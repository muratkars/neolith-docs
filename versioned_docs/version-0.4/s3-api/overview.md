---
sidebar_position: 1
title: "Overview & Compatibility"
---

# S3 API Overview & Compatibility

Neolith implements a broad subset of the Amazon S3 REST API, allowing you to use existing S3 SDKs, CLI tools, and applications with minimal or no changes. This page summarizes which operations are supported, how to connect, and what Neolith-specific behaviors to expect.

## Endpoint Configuration

Neolith listens on a single port (default `9000`) and serves both the S3 API and internal cluster RPCs.

| Style | Format | Example |
|---|---|---|
| Path-style | `http://<host>:9000/<bucket>/<key>` | `http://localhost:9000/my-bucket/photo.jpg` |
| Virtual-hosted-style | `http://<bucket>.<host>:9000/<key>` | `http://my-bucket.localhost:9000/photo.jpg` |

To use virtual-hosted-style addressing, configure the `endpoint_domain` in your server config (e.g., `localhost`). The virtual-host middleware runs after SigV4 authentication so that signatures are computed against the original URI.

### Quick Start with AWS CLI

```bash
# Configure credentials
aws configure set aws_access_key_id YOUR_ACCESS_KEY
aws configure set aws_secret_access_key YOUR_SECRET_KEY
aws configure set default.region us-east-1

# Use Neolith as endpoint
alias s3='aws --endpoint-url http://localhost:9000 s3'
alias s3api='aws --endpoint-url http://localhost:9000 s3api'

# Create a bucket and upload a file
s3 mb s3://my-bucket
s3 cp photo.jpg s3://my-bucket/photo.jpg
```

### Quick Start with curl

```bash
# Neolith supports standard SigV4 signing.
# For quick testing, use the aws-cli or an SDK.
# Direct curl requires SigV4 signature computation (see Authentication page).

# List buckets (requires SigV4 - use aws-cli for convenience)
aws --endpoint-url http://localhost:9000 s3api list-buckets
```

## Compatibility Matrix

### Bucket Operations

| Operation | Status | Notes |
|---|---|---|
| `CreateBucket` (PUT /) | Supported | |
| `DeleteBucket` (DELETE /) | Supported | Must be empty |
| `HeadBucket` (HEAD /) | Supported | |
| `ListBuckets` (GET /) | Supported | |
| `ListObjects` v1 (GET /?prefix=) | Supported | Streaming XML for large results |
| `ListObjects` v2 (GET /?list-type=2) | Supported | Continuation token pagination |
| `GetBucketLocation` | Supported | Returns `us-east-1` |
| `PutBucketVersioning` | Supported | Enable/Suspend |
| `GetBucketVersioning` | Supported | |
| `PutBucketLifecycle` | Supported | Expiration + NoncurrentVersionExpiration |
| `GetBucketLifecycle` | Supported | |
| `DeleteBucketLifecycle` | Supported | |
| `PutBucketCors` | Supported | |
| `GetBucketCors` | Supported | |
| `DeleteBucketCors` | Supported | |
| `PutBucketTagging` | Not yet | Planned v0.3+ |
| `PutBucketPolicy` | Not yet | Planned v0.3+ |
| `GetBucketPolicy` | Not yet | Planned v0.3+ |
| `PutBucketNotification` | Not yet | Planned v0.5 |
| `PutBucketAcl` | Not supported | Use IAM/bucket policy instead |
| `GetBucketAcl` | Not supported | |

### Object Operations

| Operation | Status | Notes |
|---|---|---|
| `PutObject` (PUT) | Supported | Max 128 MiB single PUT |
| `GetObject` (GET) | Supported | Range GET, conditional requests |
| `DeleteObject` (DELETE) | Supported | Version-aware delete markers |
| `HeadObject` (HEAD) | Supported | Zero-copy MetaView fast-path |
| `CopyObject` (PUT + x-amz-copy-source) | Supported | GET pipeline to PUT pipeline |
| `ListObjectVersions` | Supported | |
| `PutObjectTagging` | Supported | Max 10 tags |
| `GetObjectTagging` | Supported | |
| `DeleteObjectTagging` | Supported | |
| `SelectObjectContent` | Enterprise | S3 Select (Enterprise edition) |
| `PutObjectAcl` | Not supported | |
| `GetObjectAcl` | Not supported | |
| `PutObjectLockConfiguration` | Not yet | Planned |
| `PutObjectRetention` | Not yet | Planned |
| `PutObjectLegalHold` | Not yet | Planned |
| `PostObject` | Not supported | Use PutObject or multipart |

### Multipart Upload

| Operation | Status | Notes |
|---|---|---|
| `CreateMultipartUpload` (POST ?uploads) | Supported | UUID v4 upload IDs |
| `UploadPart` (PUT ?partNumber&uploadId) | Supported | 5 MiB min part size |
| `CompleteMultipartUpload` (POST ?uploadId) | Supported | |
| `AbortMultipartUpload` (DELETE ?uploadId) | Supported | |
| `ListParts` (GET ?uploadId) | Supported | |
| `ListMultipartUploads` (GET ?uploads) | Supported | |
| `UploadPartCopy` | Not yet | Planned |

### Security & Encryption

| Operation | Status | Notes |
|---|---|---|
| SigV4 (Authorization header) | Supported | |
| SigV4 (Query string / Presigned) | Supported | 7-day max expiry |
| SSE-S3 (AES-256-GCM) | Supported | HKDF per-object DEK |
| SSE-C (Customer-provided key) | Supported | |
| SSE-KMS | Not yet | Planned v0.2 (Vault integration) |
| STS GetSessionToken | Supported | ASIA-prefixed temp keys |

### Neolith Extensions

| Operation | Endpoint | Notes |
|---|---|---|
| Batch GET | `POST ?batch-get` | TAR+LZ4/zstd multi-object retrieval |
| Batch Epoch | `POST ?batch-epoch` | Register epoch for ML training |
| Batch Next | `GET ?batch-next` | Fetch next batch in sliding window |
| Inline ETL | `GET ?transform=<name>` | Transform on read |
| ETL CRUD | `/etl/v1/transforms` | PUT/GET/DELETE/LIST transforms |

## Neolith-Specific Headers

Neolith adds the following headers to every response:

| Header | Description |
|---|---|
| `x-amz-request-id` | UUID v4 unique request identifier |
| `x-amz-id-2` | Secondary request identifier |
| `x-neolith-transform-cache` | `hit` or `miss` (only on ETL transform requests) |

## ETag Format

Neolith uses BLAKE3 truncated to 128 bits for ETags, formatted as a 32-character hex string. This differs from S3's MD5-based ETag but is fully compatible with S3 clients that treat ETags as opaque strings.

- Single-part upload: `"<blake3-128-hex>"`
- Multipart upload: `"<blake3(concat(part_etags))>-<part_count>"`

## Key Normalization

Object keys are normalized to Unicode NFC form upon ingestion. Control characters (U+0000 through U+001F, except U+0009 HT) are rejected with a `400 Bad Request` error.

## Content-MD5 Validation

When a `Content-MD5` header is present on a PUT request, Neolith validates the MD5 digest of the request body and returns `400 BadDigest` if it does not match.
