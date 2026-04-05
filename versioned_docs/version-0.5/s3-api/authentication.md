---
sidebar_position: 2
title: "Authentication"
---

# Authentication

Neolith supports AWS Signature Version 4 (SigV4) for request authentication, including both the `Authorization` header method and query-string presigned URLs. Temporary credentials are available through the Security Token Service (STS) endpoint.

## Configuring Credentials

Set the master access key and secret key when starting the Neolith server:

```bash
# Via environment variables
export NEOLITH_ACCESS_KEY=myaccesskey
export NEOLITH_SECRET_KEY=mysecretkey
neolith server start

# Via CLI flags
neolith server start --access-key myaccesskey --secret-key mysecretkey
```

Configure the AWS CLI or SDKs to use these credentials:

```bash
aws configure
# AWS Access Key ID: myaccesskey
# AWS Secret Access Key: mysecretkey
# Default region name: us-east-1
# Default output format: json
```

## Signature Version 4 (Authorization Header)

Neolith requires SigV4 on all API requests (except CORS preflight OPTIONS). The `Authorization` header format is:

```
Authorization: AWS4-HMAC-SHA256
  Credential=<access-key>/<date>/<region>/s3/aws4_request,
  SignedHeaders=<signed-headers>,
  Signature=<signature>
```

### Signing Steps

1. **Create the canonical request:**

```
<HTTPMethod>\n
<CanonicalURI>\n
<CanonicalQueryString>\n
<CanonicalHeaders>\n
<SignedHeaders>\n
<HashedPayload>
```

2. **Create the string to sign:**

```
AWS4-HMAC-SHA256\n
<Timestamp>\n
<Scope>\n
SHA256(<CanonicalRequest>)
```

Where scope is `<date>/<region>/s3/aws4_request`.

3. **Calculate the signature:**

```
DateKey = HMAC-SHA256("AWS4" + secret_key, date)
DateRegionKey = HMAC-SHA256(DateKey, region)
DateRegionServiceKey = HMAC-SHA256(DateRegionKey, "s3")
SigningKey = HMAC-SHA256(DateRegionServiceKey, "aws4_request")
Signature = Hex(HMAC-SHA256(SigningKey, StringToSign))
```

### curl Example (using aws-cli as signer)

Direct curl with SigV4 requires computing the signature manually. For convenience, use the AWS CLI or an SDK. If you need raw HTTP access, tools like `awscurl` handle signing automatically:

```bash
# Install awscurl
pip install awscurl

# PUT an object
awscurl --service s3 \
  --region us-east-1 \
  --access_key myaccesskey \
  --secret_key mysecretkey \
  -X PUT \
  -d 'Hello, Neolith!' \
  -H "Content-Type: text/plain" \
  http://localhost:9000/my-bucket/hello.txt

# GET an object
awscurl --service s3 \
  --region us-east-1 \
  --access_key myaccesskey \
  --secret_key mysecretkey \
  http://localhost:9000/my-bucket/hello.txt

# List buckets
awscurl --service s3 \
  --region us-east-1 \
  --access_key myaccesskey \
  --secret_key mysecretkey \
  http://localhost:9000/
```

### AWS CLI Examples

```bash
# All aws commands use the --endpoint-url flag
export AWS_ENDPOINT_URL=http://localhost:9000

# List buckets
aws --endpoint-url $AWS_ENDPOINT_URL s3api list-buckets

# Put object
aws --endpoint-url $AWS_ENDPOINT_URL s3api put-object \
  --bucket my-bucket \
  --key hello.txt \
  --body hello.txt

# Get object
aws --endpoint-url $AWS_ENDPOINT_URL s3api get-object \
  --bucket my-bucket \
  --key hello.txt \
  output.txt
```

## Presigned URLs

Presigned URLs embed SigV4 credentials in the query string, allowing unauthenticated HTTP clients (browsers, wget, curl) to access objects for a limited time.

### Query String Parameters

| Parameter | Description |
|---|---|
| `X-Amz-Algorithm` | Always `AWS4-HMAC-SHA256` |
| `X-Amz-Credential` | `<access-key>/<date>/<region>/s3/aws4_request` |
| `X-Amz-Date` | ISO 8601 timestamp (`YYYYMMDDTHHMMSSZ`) |
| `X-Amz-Expires` | Validity period in seconds (max 604800 = 7 days) |
| `X-Amz-SignedHeaders` | Semicolon-separated list of signed headers |
| `X-Amz-Signature` | Computed SigV4 signature |

The auth middleware checks query-string parameters before falling back to the `Authorization` header.

### Generate a Presigned URL

```bash
# Generate a presigned GET URL valid for 1 hour (3600 seconds)
aws --endpoint-url http://localhost:9000 s3 presign \
  s3://my-bucket/photo.jpg \
  --expires-in 3600

# Output:
# http://localhost:9000/my-bucket/photo.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=...&X-Amz-Date=...&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=...

# Use the presigned URL with curl (no credentials needed)
curl -o photo.jpg "http://localhost:9000/my-bucket/photo.jpg?X-Amz-Algorithm=..."
```

### Presigned PUT

```bash
# Generate a presigned PUT URL
aws --endpoint-url http://localhost:9000 s3 presign \
  s3://my-bucket/upload.txt \
  --expires-in 3600

# Upload using the presigned URL
curl -X PUT \
  -H "Content-Type: text/plain" \
  --data-binary @upload.txt \
  "http://localhost:9000/my-bucket/upload.txt?X-Amz-Algorithm=..."
```

### Limits

- Maximum expiry: **604,800 seconds** (7 days), matching AWS S3.
- Requests with `X-Amz-Expires` exceeding this value receive a `400 AuthorizationQueryParametersError`.

## Security Token Service (STS)

Neolith provides a minimal STS implementation for generating temporary credentials.

### GetSessionToken

Issue a `POST` request with the `Action=GetSessionToken` query parameter:

```bash
# Request temporary credentials (default 12 hours)
awscurl --service sts \
  --region us-east-1 \
  --access_key myaccesskey \
  --secret_key mysecretkey \
  -X POST \
  "http://localhost:9000/?Action=GetSessionToken&DurationSeconds=3600"
```

**Response:**

```xml
<GetSessionTokenResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <GetSessionTokenResult>
    <Credentials>
      <AccessKeyId>ASIAxxxxxxxxxxxx</AccessKeyId>
      <SecretAccessKey>temporary-secret-key</SecretAccessKey>
      <SessionToken>session-token-value</SessionToken>
      <Expiration>2026-03-18T12:00:00Z</Expiration>
    </Credentials>
  </GetSessionTokenResult>
</GetSessionTokenResponse>
```

### Using Temporary Credentials

Temporary access keys are prefixed with `ASIA` (matching AWS convention). Include the session token in every request:

```bash
# Set temporary credentials
export AWS_ACCESS_KEY_ID=ASIAxxxxxxxxxxxx
export AWS_SECRET_ACCESS_KEY=temporary-secret-key
export AWS_SESSION_TOKEN=session-token-value

# Use normally
aws --endpoint-url http://localhost:9000 s3 ls
```

When using raw HTTP requests, include the `x-amz-security-token` header:

```
x-amz-security-token: session-token-value
```

### STS Parameters

| Parameter | Description | Default |
|---|---|---|
| `DurationSeconds` | Session duration in seconds | 43200 (12h) |
| Minimum | | 900 (15 min) |
| Maximum | | 43200 (12h) |

Expired sessions are automatically cleaned up by a background task.

## Server-Side Encryption Authentication

For SSE-C (customer-provided keys), include encryption headers in each request. See the [Object Operations](./object-operations.md) page for SSE-C header details.

## Middleware Layer Order

Authentication is applied as Axum middleware in this order (bottom to top):

1. `DefaultBodyLimit` - Request size limits
2. Virtual-host extraction - Extracts bucket from `Host` header
3. **SigV4 Authentication** - Validates credentials
4. CORS - Applies CORS headers (OPTIONS preflight bypasses auth)
5. Metrics - Request timing
6. Request ID - Assigns `x-amz-request-id` (UUID v4, outermost layer)
