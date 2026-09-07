---
sidebar_position: 1
title: "Migrate from S3-Compatible Object Stores"
---

# Migrate from S3-Compatible Object Stores

Neolith speaks the standard S3 API, so migrating from any S3-compatible
object store is mostly an endpoint change plus a data copy. This guide covers
API compatibility, configuration mapping, and migration mechanics for moving
off other self-hosted stores ("the source system" below). Migrating from AWS
S3 itself is covered separately in [Migrate from AWS S3](./migration-from-s3).

## S3 API Compatibility

Most client code works without modification: change the endpoint URL and
credentials.

### What Works Unchanged

| Feature | Neolith | Notes |
|---|---|---|
| PUT / GET / DELETE | Yes | Fully compatible |
| Multipart upload | Yes | 5 MiB min, 10K max parts |
| SigV4 auth | Yes | Header + query string |
| LIST v2 | Yes | Prefix, delimiter, continuation |
| Versioning | Yes | Enable/Suspend, version IDs |
| Lifecycle | Yes | Expiration + noncurrent version |
| Presigned URLs | Yes | Up to 7-day expiry |
| CORS | Yes | Per-bucket configuration |
| Tagging | Yes | Up to 10 tags per object |
| SSE-S3 / SSE-C | Yes | AES-256-GCM; SSE-KMS is Enterprise |

### What Requires Changes

| Source-system feature | Neolith | Migration path |
|---|---|---|
| Vendor admin API | Neolith admin API | Update admin scripts |
| Built-in ILM tiering | Lifecycle expiration | Re-express policies |
| SNS/SQS/Kafka notifications | HTTP webhooks | Update notification targets |
| Vendor web console | Neolith Console | Different UI, similar features |
| Server-side replication | Enterprise only | Requires Enterprise license |
| IAM/LDAP integration | Enterprise only | Requires Enterprise license |

## Configuration Mapping

Self-hosted stores are commonly configured through environment variables.
Neolith uses a TOML file, with environment variables for sensitive values:

```toml
[server]
data_dir = "/data"
listen_addr = "0.0.0.0:9000"

[auth]
access_key = "neolithadmin"
secret_key = "neolithadmin"

[encryption]
master_key = "hex-encoded-256-bit-key"

[tls]
cert_file = "/etc/neolith/tls/cert.pem"
key_file = "/etc/neolith/tls/key.pem"
```

```bash
export NEOLITH_ACCESS_KEY=neolithadmin
export NEOLITH_SECRET_KEY=...
```

Map the source system's root credentials to `[auth]`, its volume/drive list
to `data_dir` (or multi-drive EC mode), and its TLS material to `[tls]`.

### Erasure Coding

Translate drive-count-plus-parity settings into an explicit Neolith scheme:

| Source layout | Neolith equivalent |
|---|---|
| 4 drives, 2 parity | RS(2, 2) |
| 8 drives, 4 parity | RS(4, 4) or RS(6, 2) |
| 16 drives, 8 parity | RS(8, 8) or LRC(10, 4, 2) |

Note the failure-domain difference: many stores treat the **drive** as the
failure domain; Neolith defaults to the **node** (see
[Deployment Topologies](../operations/deployment-topologies.md)).

## Data Migration

### Option 1: rclone (Recommended)

```bash
# Configure the source remote
rclone config create src s3 provider=Other \
  endpoint=https://source.example.com:9000 \
  access_key_id=SRC_KEY secret_access_key=SRC_SECRET

# Configure the Neolith remote
rclone config create neolith s3 provider=Other \
  endpoint=http://localhost:9000 \
  access_key_id=neolithadmin secret_access_key=neolithadmin

# Migrate a bucket
rclone sync src:my-bucket neolith:my-bucket --progress --checksum

# Migrate all buckets
for b in $(rclone lsd src: | awk '{print $NF}'); do
  rclone sync "src:$b" "neolith:$b" --progress --checksum
done
```

### Option 2: mc mirror

`mc` works against any S3 endpoint:

```bash
mc alias set src https://source.example.com:9000 SRC_KEY SRC_SECRET
mc alias set neolith http://localhost:9000 neolithadmin neolithadmin
mc mirror --preserve src/my-bucket neolith/my-bucket
```

### Verification

```bash
# Object counts match
rclone size src:my-bucket
rclone size neolith:my-bucket

# Spot-check checksums
rclone check src:my-bucket neolith:my-bucket --one-way
```

## Key Differences to Plan Around

- **Failure domain**: node-level by default (drive-level is a configuration
  choice, not the only mode).
- **Notifications**: HTTP webhooks; re-point queue-based consumers through a
  webhook bridge.
- **Console**: Neolith Console replaces the vendor UI; tiering configuration
  is not yet available in OSS.
- **Monitoring**: Prometheus metrics at `/metrics`; dashboards need re-pointing,
  not re-inventing.
