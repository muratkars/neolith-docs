---
sidebar_position: 4
title: "Object Operations"
---

# Object Operations

Neolith supports the core S3 object operations: PUT, GET, DELETE, HEAD, and COPY, along with conditional requests, range reads, and server-side encryption.

## PutObject

Uploads an object to a bucket. Maximum single PUT size is **128 MiB**. For larger objects, use [multipart upload](./multipart.md).

**Request:**

```
PUT /<bucket>/<key> HTTP/1.1
Host: localhost:9000
Content-Type: application/octet-stream
Content-Length: <size>
Content-MD5: <base64-md5>          (optional, validated if present)
x-amz-meta-<name>: <value>         (optional, custom metadata)
x-amz-server-side-encryption: AES256  (optional, SSE-S3)
```

**AWS CLI:**

```bash
# Simple upload
aws --endpoint-url http://localhost:9000 s3api put-object \
  --bucket my-bucket \
  --key documents/report.pdf \
  --body report.pdf \
  --content-type application/pdf

# Upload with custom metadata
aws --endpoint-url http://localhost:9000 s3api put-object \
  --bucket my-bucket \
  --key data/sensor.csv \
  --body sensor.csv \
  --content-type text/csv \
  --metadata '{"project":"alpha","source":"iot-gateway"}'

# Upload with SSE-S3 encryption
aws --endpoint-url http://localhost:9000 s3api put-object \
  --bucket my-bucket \
  --key secrets/config.enc \
  --body config.json \
  --server-side-encryption AES256

# Upload with Content-MD5 validation
aws --endpoint-url http://localhost:9000 s3api put-object \
  --bucket my-bucket \
  --key data/file.bin \
  --body file.bin \
  --content-md5 "$(openssl md5 -binary file.bin | base64)"
```

**curl (with awscurl):**

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  -X PUT \
  -H "Content-Type: text/plain" \
  -d "Hello, Neolith!" \
  http://localhost:9000/my-bucket/hello.txt
```

**Response (200 OK):**

```
HTTP/1.1 200 OK
ETag: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
x-amz-request-id: 550e8400-e29b-41d4-a716-446655440000
x-amz-id-2: neolith
```

### SSE-C (Customer-Provided Encryption Key)

```bash
# Generate a 256-bit key
KEY=$(openssl rand -base64 32)
KEY_MD5=$(echo -n "$KEY" | base64 -d | openssl md5 -binary | base64)

# Upload with SSE-C
aws --endpoint-url http://localhost:9000 s3api put-object \
  --bucket my-bucket \
  --key encrypted/data.bin \
  --body data.bin \
  --sse-customer-algorithm AES256 \
  --sse-customer-key "$KEY" \
  --sse-customer-key-md5 "$KEY_MD5"
```

SSE-C headers:

| Header | Description |
|---|---|
| `x-amz-server-side-encryption-customer-algorithm` | Must be `AES256` |
| `x-amz-server-side-encryption-customer-key` | Base64-encoded 256-bit key |
| `x-amz-server-side-encryption-customer-key-MD5` | Base64-encoded MD5 of the key |

With SSE-C, the customer key encrypts the object directly (no HKDF key derivation). The key MD5 is stored in `EncryptionInfo.sealed_dek` with algorithm `AES256-C`, distinguishing it from SSE-S3 (`AES256`).

## GetObject

Retrieves an object from a bucket.

**Request:**

```
GET /<bucket>/<key> HTTP/1.1
Host: localhost:9000
Range: bytes=0-1023              (optional)
If-Match: "<etag>"               (optional)
If-None-Match: "<etag>"          (optional)
If-Modified-Since: <date>        (optional)
If-Unmodified-Since: <date>      (optional)
```

**AWS CLI:**

```bash
# Download an object
aws --endpoint-url http://localhost:9000 s3api get-object \
  --bucket my-bucket \
  --key documents/report.pdf \
  output.pdf

# Download with range
aws --endpoint-url http://localhost:9000 s3api get-object \
  --bucket my-bucket \
  --key data/large-file.bin \
  --range "bytes=0-1023" \
  first-1kb.bin

# Get specific version
aws --endpoint-url http://localhost:9000 s3api get-object \
  --bucket my-bucket \
  --key config.json \
  --version-id "abc123" \
  config-old.json

# Get SSE-C encrypted object
aws --endpoint-url http://localhost:9000 s3api get-object \
  --bucket my-bucket \
  --key encrypted/data.bin \
  --sse-customer-algorithm AES256 \
  --sse-customer-key "$KEY" \
  --sse-customer-key-md5 "$KEY_MD5" \
  data.bin
```

**curl:**

```bash
# Download
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  http://localhost:9000/my-bucket/hello.txt

# Range request (first 1 KB)
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  -H "Range: bytes=0-1023" \
  http://localhost:9000/my-bucket/data/large-file.bin
```

**Response (200 OK):**

```
HTTP/1.1 200 OK
Content-Type: text/plain
Content-Length: 15
ETag: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
Last-Modified: Sat, 15 Mar 2026 12:00:00 GMT
x-amz-request-id: 550e8400-e29b-41d4-a716-446655440000

Hello, Neolith!
```

**Range Response (206 Partial Content):**

```
HTTP/1.1 206 Partial Content
Content-Range: bytes 0-1023/2048576
Content-Length: 1024
```

### Range GET Implementation Note

For objects that are compressed and/or encrypted, Neolith performs a full decrypt-then-decompress pipeline and then slices the result to the requested byte range. This ensures correctness at the cost of performing the full pipeline for every range request on encrypted/compressed objects.

## HeadObject

Retrieves object metadata without the body. Uses the zero-copy `MetaView` fast-path for unencrypted, uncompressed objects, skipping full `ObjectMeta` deserialization.

**Request:**

```
HEAD /<bucket>/<key> HTTP/1.1
Host: localhost:9000
```

**AWS CLI:**

```bash
aws --endpoint-url http://localhost:9000 s3api head-object \
  --bucket my-bucket \
  --key documents/report.pdf
```

**curl:**

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  -I http://localhost:9000/my-bucket/documents/report.pdf
```

**Response (200 OK):**

```
HTTP/1.1 200 OK
Content-Type: application/pdf
Content-Length: 2048576
ETag: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
Last-Modified: Sat, 15 Mar 2026 12:00:00 GMT
x-amz-meta-project: alpha
x-amz-server-side-encryption: AES256
x-amz-request-id: 550e8400-e29b-41d4-a716-446655440000
```

## DeleteObject

Deletes an object. On versioned buckets, this creates a delete marker instead of removing the data.

**Request:**

```
DELETE /<bucket>/<key> HTTP/1.1
Host: localhost:9000
```

**AWS CLI:**

```bash
# Delete an object
aws --endpoint-url http://localhost:9000 s3api delete-object \
  --bucket my-bucket \
  --key old-file.txt

# Delete a specific version
aws --endpoint-url http://localhost:9000 s3api delete-object \
  --bucket my-bucket \
  --key config.json \
  --version-id "abc123"
```

**curl:**

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  -X DELETE http://localhost:9000/my-bucket/old-file.txt
```

**Response:** `204 No Content` on success.

On a versioned bucket, the response includes:

```
x-amz-version-id: <new-delete-marker-id>
x-amz-delete-marker: true
```

### Cluster Delete Behavior

In a multi-node cluster, DELETE is replicated using last-writer-wins (LWW) semantics. The replicate_delete handler compares the incoming HLC timestamp against the stored HLC and only proceeds if the incoming timestamp is newer.

## CopyObject

Copies an object within or across buckets. Internally, this runs the full GET pipeline (decrypt, decompress) on the source and the full PUT pipeline (compress, encrypt) on the destination.

**Request:**

```
PUT /<dest-bucket>/<dest-key> HTTP/1.1
Host: localhost:9000
x-amz-copy-source: /<source-bucket>/<source-key>
```

**AWS CLI:**

```bash
# Copy within a bucket
aws --endpoint-url http://localhost:9000 s3api copy-object \
  --bucket my-bucket \
  --key backup/report.pdf \
  --copy-source my-bucket/documents/report.pdf

# Copy across buckets
aws --endpoint-url http://localhost:9000 s3api copy-object \
  --bucket archive-bucket \
  --key 2026/report.pdf \
  --copy-source my-bucket/documents/report.pdf

# Copy with SSE-C (source and destination keys)
aws --endpoint-url http://localhost:9000 s3api copy-object \
  --bucket my-bucket \
  --key encrypted/copy.bin \
  --copy-source my-bucket/encrypted/data.bin \
  --copy-source-sse-customer-algorithm AES256 \
  --copy-source-sse-customer-key "$SOURCE_KEY" \
  --copy-source-sse-customer-key-md5 "$SOURCE_KEY_MD5" \
  --sse-customer-algorithm AES256 \
  --sse-customer-key "$DEST_KEY" \
  --sse-customer-key-md5 "$DEST_KEY_MD5"
```

**Response (200 OK):**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CopyObjectResult>
  <LastModified>2026-03-15T14:30:00.000Z</LastModified>
  <ETag>"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"</ETag>
</CopyObjectResult>
```

## Conditional Requests

Neolith supports the four standard conditional request headers on GET and HEAD:

| Header | Behavior |
|---|---|
| `If-Match` | Return object only if its ETag matches the given value. Otherwise `412 Precondition Failed`. |
| `If-None-Match` | Return object only if its ETag does NOT match. Otherwise `304 Not Modified`. |
| `If-Modified-Since` | Return object only if modified after the given date. Otherwise `304 Not Modified`. |
| `If-Unmodified-Since` | Return object only if NOT modified after the given date. Otherwise `412 Precondition Failed`. |

```bash
# Conditional GET: only download if changed
aws --endpoint-url http://localhost:9000 s3api get-object \
  --bucket my-bucket \
  --key data.json \
  --if-none-match '"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"' \
  data.json

# Conditional PUT: only overwrite if ETag matches (optimistic concurrency)
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  -X PUT \
  -H 'If-Match: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"' \
  -d @updated-data.json \
  http://localhost:9000/my-bucket/data.json
```

## ETag Format

Neolith uses BLAKE3 truncated to 128 bits for ETags. The ETag is formatted as a quoted 32-character hex string:

- **Single-part upload:** `"<blake3-128-hex>"`
- **Multipart upload:** `"<blake3(concat(part_etags))>-<part_count>"`

This differs from AWS S3 (which uses MD5) but is compatible with all S3 clients that treat ETags as opaque strings.

## Content-MD5 Validation

When the `Content-MD5` header is present on a PUT request, Neolith computes the MD5 digest of the request body and compares it against the provided value. A mismatch returns:

```xml
<Error>
  <Code>BadDigest</Code>
  <Message>The Content-MD5 you specified did not match what we received.</Message>
  <RequestId>550e8400-e29b-41d4-a716-446655440000</RequestId>
</Error>
```

## Custom Metadata

Store custom metadata using `x-amz-meta-` prefixed headers. Metadata keys are case-insensitive and stored in lowercase.

```bash
# Set custom metadata on upload
aws --endpoint-url http://localhost:9000 s3api put-object \
  --bucket my-bucket \
  --key datasets/training.tar \
  --body training.tar \
  --metadata '{"epoch":"42","model":"resnet50","dataset-version":"3.1"}'

# Retrieve metadata with HEAD
aws --endpoint-url http://localhost:9000 s3api head-object \
  --bucket my-bucket \
  --key datasets/training.tar
```

Response includes:

```json
{
  "Metadata": {
    "epoch": "42",
    "model": "resnet50",
    "dataset-version": "3.1"
  }
}
```
