---
sidebar_position: 6
title: "IAM & Access Control"
---

# IAM & Access Control

Neolith Enterprise's `neolith-auth-ext` crate extends the OSS SigV4 authentication with OIDC and LDAP identity providers, bucket policies with deny-overrides-allow evaluation, presigned URL policy constraints, and STS session management.

## Authentication Methods

| Method | Edition | Description |
|---|---|---|
| SigV4 (static keys) | OSS | AWS Signature Version 4 with access key / secret key pairs |
| SigV4 (STS sessions) | OSS | Temporary credentials via `GetSessionToken`, ASIA-prefixed keys |
| Presigned URLs | OSS | Query-string SigV4, up to 7-day expiry (604800s) |
| OIDC | Enterprise | OpenID Connect federation with external IdPs (Keycloak, Okta, Auth0, Azure AD) |
| LDAP | Enterprise | LDAP/Active Directory bind authentication with group mapping |

## OIDC Integration

Neolith Enterprise supports OpenID Connect for federated identity. Users authenticate with their organization's identity provider and receive temporary Neolith credentials.

### Flow

```
User                    IdP (Keycloak/Okta)           Neolith
  |                           |                          |
  |── authenticate ──────────>|                          |
  |<── id_token + access ─────|                          |
  |                           |                          |
  |── POST /sts?Action=AssumeRoleWithWebIdentity ──────>|
  |   (id_token in WebIdentityToken)                     |
  |                           |                          |
  |                           |   ┌──────────────────┐   |
  |                           |   │ Validate JWT     │   |
  |                           |   │ Check issuer     │   |
  |                           |   │ Verify signature │   |
  |                           |   │ Map claims to    │   |
  |                           |   │ Neolith policies │   |
  |                           |   └──────────────────┘   |
  |                           |                          |
  |<── temp credentials (ASIA-prefixed) ────────────────|
  |    + session_token + expires_at                      |
```

### Configuration

```toml
[enterprise.auth.oidc]
enabled = true

[[enterprise.auth.oidc.providers]]
name = "corporate-idp"
issuer_url = "https://idp.example.com/realms/neolith"
client_id = "neolith-storage"
client_secret = "..."

# Claim mapping: map IdP claims to Neolith tenant/role
[enterprise.auth.oidc.providers.claim_mapping]
tenant_claim = "org_id"
role_claim = "neolith_role"
groups_claim = "groups"

# Role mapping: map IdP roles/groups to Neolith policies
[[enterprise.auth.oidc.providers.role_mappings]]
idp_role = "storage-admin"
neolith_policy = "admin"

[[enterprise.auth.oidc.providers.role_mappings]]
idp_role = "data-scientist"
neolith_policy = "readwrite"
allowed_bucket_prefix = "ml-"
```

## LDAP Integration

For organizations using Active Directory or LDAP, Neolith Enterprise supports direct LDAP bind authentication with group-based access control.

### Configuration

```toml
[enterprise.auth.ldap]
enabled = true
server_url = "ldaps://ldap.example.com:636"
bind_dn = "cn=neolith-svc,ou=services,dc=example,dc=com"
bind_password = "..."  # Or use NEOLITH_LDAP_BIND_PASSWORD env var

# User search
user_search_base = "ou=users,dc=example,dc=com"
user_search_filter = "(&(objectClass=user)(sAMAccountName={username}))"
user_dn_attribute = "distinguishedName"

# Group search
group_search_base = "ou=groups,dc=example,dc=com"
group_search_filter = "(&(objectClass=group)(member={user_dn}))"
group_name_attribute = "cn"

# Group-to-policy mapping
[enterprise.auth.ldap.group_mappings]
"Storage Admins" = "admin"
"Data Scientists" = "readwrite"
"Auditors" = "readonly"
```

### Authentication Flow

1. User sends an S3 request with SigV4 credentials. The access key is formatted as `LDAP:<username>`.
2. Neolith performs an LDAP bind with the user's credentials to verify identity.
3. Neolith queries LDAP for the user's group memberships.
4. Group memberships are mapped to Neolith policies via the `group_mappings` configuration.
5. A temporary session is created (cached for `session_ttl` seconds) to avoid repeated LDAP binds.

## Bucket Policies

Neolith Enterprise supports S3-compatible bucket policies with a deny-overrides-allow evaluation model. Bucket policies define fine-grained access control rules at the bucket level.

### Policy Evaluation

The evaluation order follows the S3 standard:

1. **Explicit Deny**: If any policy statement explicitly denies the action, the request is denied. This takes precedence over everything.
2. **Explicit Allow**: If a policy statement explicitly allows the action (and no deny was found), the request is allowed.
3. **Default Deny**: If no policy statement matches, the request is denied.

### Policy Structure

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowPublicRead",
      "Effect": "Allow",
      "Principal": "*",
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::public-assets/*"]
    },
    {
      "Sid": "DenyDeleteFromNonAdmin",
      "Effect": "Deny",
      "NotPrincipal": {
        "AWS": ["arn:aws:iam::root"]
      },
      "Action": ["s3:DeleteObject", "s3:DeleteBucket"],
      "Resource": [
        "arn:aws:s3:::production-data",
        "arn:aws:s3:::production-data/*"
      ]
    },
    {
      "Sid": "AllowTenantAccess",
      "Effect": "Allow",
      "Principal": {"AWS": ["arn:aws:iam::tenant-acme"]},
      "Action": ["s3:*"],
      "Resource": ["arn:aws:s3:::acme-*/*"],
      "Condition": {
        "IpAddress": {"aws:SourceIp": "10.0.0.0/8"},
        "StringEquals": {"s3:x-amz-server-side-encryption": "AES256"}
      }
    }
  ]
}
```

### Supported Conditions

| Condition Key | Operators | Description |
|---|---|---|
| `aws:SourceIp` | IpAddress, NotIpAddress | Client IP address or CIDR range |
| `aws:CurrentTime` | DateGreaterThan, DateLessThan | Request timestamp |
| `aws:SecureTransport` | Bool | Whether request used TLS |
| `s3:prefix` | StringEquals, StringLike | Object key prefix (for ListBucket) |
| `s3:max-keys` | NumericLessThanEquals | Maximum keys in LIST response |
| `s3:x-amz-server-side-encryption` | StringEquals | Required encryption method |
| `s3:x-amz-content-sha256` | StringEquals | Content checksum requirement |

## Presigned URLs with Policy Constraints

Enterprise extends presigned URLs with additional policy constraints beyond the OSS 7-day expiry limit:

```bash
# Generate presigned URL with IP restriction (Enterprise)
# The presigned URL will only work from the specified IP range
curl -X POST http://localhost:9000/_neolith/admin/v1/presign \
  -H "Content-Type: application/json" \
  -d '{
    "bucket": "shared-data",
    "key": "report.pdf",
    "method": "GET",
    "expires_in": 3600,
    "conditions": {
      "source_ip": "10.0.0.0/8",
      "require_tls": true
    }
  }'
```

Presigned URL authentication uses query-string SigV4 with the following parameters:
- `X-Amz-Algorithm`: Always `AWS4-HMAC-SHA256`
- `X-Amz-Credential`: Access key, date, region, service, and terminator
- `X-Amz-Date`: ISO 8601 timestamp
- `X-Amz-Expires`: Duration in seconds (max 604800)
- `X-Amz-SignedHeaders`: Headers included in the signature
- `X-Amz-Signature`: The computed signature

The auth middleware checks for query-string parameters before the `Authorization` header, allowing presigned URLs to work without explicit credentials.

## STS Session Management

The Security Token Service issues temporary credentials with a bounded lifetime:

```bash
# Get temporary credentials
curl -X POST "http://localhost:9000/?Action=GetSessionToken&DurationSeconds=3600"
  -H "Authorization: AWS4-HMAC-SHA256 ..."
```

Response:

```xml
<GetSessionTokenResponse>
  <GetSessionTokenResult>
    <Credentials>
      <AccessKeyId>ASIA...</AccessKeyId>
      <SecretAccessKey>temp-secret...</SecretAccessKey>
      <SessionToken>FQoGZXIvYX...</SessionToken>
      <Expiration>2026-03-15T15:30:00Z</Expiration>
    </Credentials>
  </GetSessionTokenResult>
</GetSessionTokenResponse>
```

Key STS behaviors:
- Temporary access keys are prefixed with `ASIA` (vs permanent keys with `AKIA`)
- Duration is clamped to [900, 43200] seconds (15 minutes to 12 hours)
- The `x-amz-security-token` header must be included in all requests using temporary credentials
- A background task (`cleanup_expired`) periodically removes stale sessions
- Session tokens include the `session_token` and `expires_at` fields on the `Credential` struct
