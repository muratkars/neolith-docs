---
sidebar_position: 1
title: "SDK Overview"
---

# SDK Overview

Neolith is fully S3-compatible, which means any S3 client library works out of the box. In addition, Neolith provides a purpose-built Python SDK optimized for AI/ML training workloads with batch streaming, epoch management, and PyTorch DataLoader integration.

## Client Options

| Client | Best For | S3 Compat | Batch API | Epoch Streaming |
|---|---|---|---|---|
| [PyTorch SDK](./python-pytorch) | ML training pipelines | Yes | Yes | Yes |
| [AWS SDKs](./aws-sdk) (boto3, aws-sdk-s3, etc.) | General-purpose S3 operations | Yes | No | No |
| [REST API](./rest-api) (curl, HTTP clients) | Scripting, debugging, low-level | Yes | Yes | Yes |
| aws-cli | Ops, scripting, bucket management | Yes | No | No |

## S3 Compatibility

Neolith implements a broad subset of the S3 API, sufficient for most S3 client libraries to work without modification. Key supported operations:

**Bucket Operations:**
- `PUT Bucket` (CreateBucket)
- `GET Bucket` (ListObjectsV2)
- `DELETE Bucket`
- `HEAD Bucket`
- `PUT/GET/DELETE BucketVersioning`
- `PUT/GET/DELETE BucketLifecycle`
- `PUT/GET/DELETE BucketCORS`
- `PUT/GET/DELETE BucketNotification`
- `PUT/GET/DELETE BucketPolicy`

**Object Operations:**
- `PUT Object` (with SSE-S3 and SSE-C encryption)
- `GET Object` (with range requests, conditional headers)
- `DELETE Object`
- `HEAD Object`
- `COPY Object`
- `PUT/GET/DELETE ObjectTagging`

**Multipart Upload:**
- `POST CreateMultipartUpload`
- `PUT UploadPart`
- `POST CompleteMultipartUpload`
- `DELETE AbortMultipartUpload`
- `GET ListMultipartUploads`

**Authentication:**
- SigV4 (Authorization header and query string / presigned URLs)
- STS `GetSessionToken` for temporary credentials
- SSE-C (customer-provided encryption keys)

**Additional:**
- Virtual-hosted-style bucket addressing
- Presigned URLs (up to 7-day expiry)
- POST Object (browser-based uploads)
- Static website hosting

## Connecting to Neolith

All S3 clients need three configuration values:

1. **Endpoint URL**: The Neolith server address (e.g., `http://localhost:9000`)
2. **Access Key**: Your access key ID (if authentication is enabled)
3. **Secret Key**: Your secret access key (if authentication is enabled)

Most S3 clients default to AWS endpoints. You must explicitly configure the endpoint URL to point to your Neolith server. Additionally, some clients need path-style addressing enabled (instead of virtual-hosted-style) when the endpoint is an IP address or does not support subdomain-based bucket routing.

## Neolith-Specific APIs

Beyond S3 compatibility, Neolith exposes purpose-built APIs for AI/ML workloads:

### Batch GET API

Retrieve many objects in a single request, streamed as a TAR archive with optional LZ4 or zstd compression:

```
POST /{bucket}?batch-get
```

### Epoch Streaming API

Register a training epoch with server-side shuffle and speculative prefetch, then stream batches one at a time:

```
POST /{bucket}?batch-epoch    # Register epoch, get epoch_id
GET  /{bucket}?batch-next&epoch_id=...  # Fetch next batch
```

### ETL Transform API

Register, manage, and apply server-side transforms (native, WASM, or container):

```
PUT    /etl/v1/transforms/{name}   # Register transform
GET    /etl/v1/transforms/{name}   # Get transform info
DELETE /etl/v1/transforms/{name}   # Delete transform
GET    /etl/v1/transforms          # List transforms
GET    /{bucket}/{key}?transform=name  # Apply inline
```

### Admin API

Cluster management and diagnostics:

```
GET  /_neolith/v1/info             # Server info
GET  /_neolith/admin/v1/heal/status   # Heal status
POST /_neolith/admin/v1/heal/trigger  # Trigger heal
GET  /_neolith/admin/v1/pools         # List pools
GET  /metrics                      # Prometheus metrics
GET  /health                       # Health check
```

## Authentication

When authentication is enabled (server started with `--access-key` and `--secret-key`), all S3 API requests must be signed with AWS SigV4. The Neolith-specific APIs (Admin, ETL) also require valid authentication.

The only unauthenticated endpoints are:
- `GET /health` - returns `{"status":"ok"}`
- `GET /metrics` - Prometheus metrics
- `OPTIONS` preflight requests (CORS)
