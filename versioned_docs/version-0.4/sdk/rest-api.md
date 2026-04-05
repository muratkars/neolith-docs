---
sidebar_position: 4
title: "REST API"
---

# REST API

Neolith exposes its S3-compatible API over HTTP/2 on a single port (default: 9000). This page covers raw HTTP interactions using `curl` and explains the SigV4 signing process.

## Unauthenticated Endpoints

When the server runs without `--access-key` / `--secret-key`, all endpoints are accessible without authentication. These endpoints are always unauthenticated regardless of server configuration:

```bash
# Health check
curl http://localhost:9000/health
# {"status":"ok"}

# Prometheus metrics
curl http://localhost:9000/metrics
# neolith_requests_total{method="GET",status="200"} 42
# neolith_request_duration_seconds_bucket{method="GET",le="0.001"} 38
# ...
```

## Bucket Operations

### Create Bucket

```bash
curl -X PUT http://localhost:9000/my-bucket
```

Response: `200 OK` (empty body)

### List Buckets

```bash
curl http://localhost:9000/
```

Response:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult>
  <Buckets>
    <Bucket>
      <Name>my-bucket</Name>
      <CreationDate>2026-03-15T10:30:00.000Z</CreationDate>
    </Bucket>
  </Buckets>
</ListAllMyBucketsResult>
```

### Delete Bucket

```bash
curl -X DELETE http://localhost:9000/my-bucket
```

### Head Bucket

```bash
curl -I http://localhost:9000/my-bucket
```

## Object Operations

### PUT Object

```bash
# Upload a file
curl -X PUT \
  -H "Content-Type: application/octet-stream" \
  --data-binary @model.pt \
  http://localhost:9000/my-bucket/models/checkpoint-42.pt

# Upload with custom metadata
curl -X PUT \
  -H "Content-Type: text/plain" \
  -H "x-amz-meta-project: nlp-v2" \
  -H "x-amz-meta-epoch: 42" \
  -d "hello world" \
  http://localhost:9000/my-bucket/greeting.txt
```

Response headers:
```
HTTP/2 200
etag: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
x-amz-request-id: 550e8400-e29b-41d4-a716-446655440000
```

### PUT Object with Encryption

```bash
# SSE-S3 (server-managed key, requires --master-key on server)
curl -X PUT \
  -H "x-amz-server-side-encryption: AES256" \
  --data-binary @secret.bin \
  http://localhost:9000/my-bucket/encrypted/secret.bin

# SSE-C (customer-provided key)
curl -X PUT \
  -H "x-amz-server-side-encryption-customer-algorithm: AES256" \
  -H "x-amz-server-side-encryption-customer-key: $(openssl rand -base64 32)" \
  -H "x-amz-server-side-encryption-customer-key-MD5: $(echo -n '<key>' | openssl dgst -md5 -binary | base64)" \
  --data-binary @secret.bin \
  http://localhost:9000/my-bucket/encrypted/ssec.bin
```

### GET Object

```bash
# Full download
curl http://localhost:9000/my-bucket/models/checkpoint-42.pt -o checkpoint.pt

# Range GET (bytes 0-1023)
curl -H "Range: bytes=0-1023" \
  http://localhost:9000/my-bucket/large-file.bin

# Conditional GET (only if modified since)
curl -H "If-Modified-Since: Thu, 01 Jan 2026 00:00:00 GMT" \
  http://localhost:9000/my-bucket/data.csv
# Returns 304 Not Modified if unchanged

# Conditional GET (only if ETag matches)
curl -H "If-None-Match: \"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4\"" \
  http://localhost:9000/my-bucket/data.csv
```

Response headers:
```
HTTP/2 200
content-type: application/octet-stream
content-length: 1048576
etag: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
last-modified: Sat, 15 Mar 2026 10:30:00 GMT
x-amz-request-id: 550e8400-e29b-41d4-a716-446655440001
x-amz-meta-project: nlp-v2
```

### HEAD Object

```bash
curl -I http://localhost:9000/my-bucket/models/checkpoint-42.pt
```

Returns the same headers as GET but without the body. Uses the zero-copy `MetaView` fast path for maximum performance.

### DELETE Object

```bash
curl -X DELETE http://localhost:9000/my-bucket/models/old-checkpoint.pt
```

On versioned buckets, DELETE creates a delete marker instead of removing the object.

### COPY Object

```bash
curl -X PUT \
  -H "x-amz-copy-source: source-bucket/source-key.txt" \
  http://localhost:9000/dest-bucket/dest-key.txt
```

Response:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<CopyObjectResult>
  <ETag>"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"</ETag>
  <LastModified>2026-03-15T10:30:00.000Z</LastModified>
</CopyObjectResult>
```

### List Objects (ListObjectsV2)

```bash
# List all objects
curl "http://localhost:9000/my-bucket?list-type=2"

# List with prefix filter
curl "http://localhost:9000/my-bucket?list-type=2&prefix=models/"

# Paginated listing
curl "http://localhost:9000/my-bucket?list-type=2&max-keys=100&continuation-token=TOKEN"
```

Response:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>my-bucket</Name>
  <Prefix>models/</Prefix>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>models/checkpoint-42.pt</Key>
    <Size>1048576</Size>
    <ETag>"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"</ETag>
    <LastModified>2026-03-15T10:30:00.000Z</LastModified>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
</ListBucketResult>
```

## Multipart Upload

```bash
# 1. Initiate
UPLOAD_ID=$(curl -s -X POST \
  "http://localhost:9000/my-bucket/large-file.bin?uploads" \
  | xmllint --xpath '//UploadId/text()' -)

# 2. Upload parts (minimum 5 MiB each, except last)
ETAG1=$(curl -s -X PUT \
  --data-binary @part1.bin \
  "http://localhost:9000/my-bucket/large-file.bin?partNumber=1&uploadId=$UPLOAD_ID" \
  -D - -o /dev/null | grep -i etag | cut -d'"' -f2)

ETAG2=$(curl -s -X PUT \
  --data-binary @part2.bin \
  "http://localhost:9000/my-bucket/large-file.bin?partNumber=2&uploadId=$UPLOAD_ID" \
  -D - -o /dev/null | grep -i etag | cut -d'"' -f2)

# 3. Complete
curl -X POST \
  -H "Content-Type: application/xml" \
  -d "<CompleteMultipartUpload>
    <Part><PartNumber>1</PartNumber><ETag>\"$ETAG1\"</ETag></Part>
    <Part><PartNumber>2</PartNumber><ETag>\"$ETAG2\"</ETag></Part>
  </CompleteMultipartUpload>" \
  "http://localhost:9000/my-bucket/large-file.bin?uploadId=$UPLOAD_ID"
```

Multipart constraints:
- Minimum part size: 5 MiB (except the last part)
- Maximum parts: 10,000
- Upload ID: UUID v4
- TTL: 24 hours (expired uploads cleaned up automatically)
- Multipart ETag format: `BLAKE3(concat(part_etags))-N`

## Tagging

```bash
# Set tags (max 10 tags, key <= 128 chars, value <= 256 chars)
curl -X PUT \
  -H "Content-Type: application/xml" \
  -d '<Tagging><TagSet>
    <Tag><Key>project</Key><Value>nlp-v2</Value></Tag>
    <Tag><Key>stage</Key><Value>training</Value></Tag>
  </TagSet></Tagging>' \
  "http://localhost:9000/my-bucket/dataset.tar.gz?tagging"

# Get tags
curl "http://localhost:9000/my-bucket/dataset.tar.gz?tagging"

# Delete tags
curl -X DELETE "http://localhost:9000/my-bucket/dataset.tar.gz?tagging"
```

## SigV4 Signing

When authentication is enabled, requests must include an `Authorization` header with an AWS SigV4 signature, or use query-string presigned URLs.

### Authorization Header Format

```
Authorization: AWS4-HMAC-SHA256
  Credential=AKID/20260315/us-east-1/s3/aws4_request,
  SignedHeaders=host;x-amz-content-sha256;x-amz-date,
  Signature=<hex-encoded-signature>
```

### Required Headers

| Header | Description |
|---|---|
| `x-amz-date` | Request timestamp in ISO 8601 format (`20260315T103000Z`) |
| `x-amz-content-sha256` | SHA-256 hash of the request body (or `UNSIGNED-PAYLOAD`) |
| `Host` | Server hostname |

### Presigned URL Format

Presigned URLs encode the signature in query parameters:

```
http://localhost:9000/my-bucket/file.bin
  ?X-Amz-Algorithm=AWS4-HMAC-SHA256
  &X-Amz-Credential=AKID/20260315/us-east-1/s3/aws4_request
  &X-Amz-Date=20260315T103000Z
  &X-Amz-Expires=3600
  &X-Amz-SignedHeaders=host
  &X-Amz-Signature=<hex-encoded-signature>
```

Maximum expiry: 7 days (604,800 seconds).

### STS Temporary Credentials

Request temporary credentials via the STS API:

```bash
curl -X POST "http://localhost:9000/?Action=GetSessionToken&DurationSeconds=3600" \
  -H "Authorization: AWS4-HMAC-SHA256 ..."
```

Response includes temporary credentials with `ASIA`-prefixed access keys:

```xml
<GetSessionTokenResponse>
  <GetSessionTokenResult>
    <Credentials>
      <AccessKeyId>ASIA...</AccessKeyId>
      <SecretAccessKey>...</SecretAccessKey>
      <SessionToken>...</SessionToken>
      <Expiration>2026-03-15T11:30:00Z</Expiration>
    </Credentials>
  </GetSessionTokenResult>
</GetSessionTokenResponse>
```

Temporary credentials must include the `x-amz-security-token` header in subsequent requests. Duration is clamped to 900-43,200 seconds.

## Request and Response Headers

### Common Request Headers

| Header | Description |
|---|---|
| `Authorization` | SigV4 signature |
| `x-amz-date` | Request timestamp |
| `x-amz-content-sha256` | Body hash |
| `x-amz-security-token` | STS session token |
| `x-amz-server-side-encryption` | SSE mode (`AES256`) |
| `x-amz-meta-*` | Custom metadata |
| `Content-MD5` | Base64-encoded MD5 for integrity |
| `Range` | Byte range for partial GET |

### Common Response Headers

| Header | Description |
|---|---|
| `x-amz-request-id` | Unique request ID (UUID v4) |
| `x-amz-id-2` | Secondary request ID |
| `ETag` | Object content hash (BLAKE3 truncated to 128 bits) |
| `Last-Modified` | Object modification timestamp |
| `x-amz-server-side-encryption` | Encryption mode if applied |
| `x-amz-version-id` | Version ID (on versioned buckets) |
| `x-amz-delete-marker` | Present if object is a delete marker |

## Error Responses

Errors are returned as XML:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>NoSuchKey</Code>
  <Message>The specified key does not exist.</Message>
  <Key>nonexistent.txt</Key>
  <RequestId>550e8400-e29b-41d4-a716-446655440002</RequestId>
</Error>
```

Common error codes:

| Code | HTTP Status | Description |
|---|---|---|
| `NoSuchBucket` | 404 | Bucket does not exist |
| `NoSuchKey` | 404 | Object does not exist |
| `BucketAlreadyExists` | 409 | Bucket name already taken |
| `BucketNotEmpty` | 409 | Cannot delete non-empty bucket |
| `AccessDenied` | 403 | Authentication or authorization failure |
| `InvalidArgument` | 400 | Invalid request parameter |
| `EntityTooSmall` | 400 | Multipart part below 5 MiB minimum |
| `InsufficientStorage` | 507 | Disk full (statvfs pre-check or ENOSPC) |
| `SlowDown` | 503 | Rate limited or server is draining |
