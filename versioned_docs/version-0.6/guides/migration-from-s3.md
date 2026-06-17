---
sidebar_position: 2
title: "Migrate from AWS S3"
---

# Migrate from AWS S3

Moving from AWS S3 to Neolith lets you run the same S3-compatible API on your own infrastructure: no egress fees, no per-request charges, and full control over data placement and security. This guide covers API compatibility, data migration strategies, IAM mapping, feature differences, and cost considerations.

## S3 API Compatibility

Neolith implements the S3 API surface that most applications and SDKs rely on. Client libraries (AWS SDK, boto3, s3cmd, rclone) work by changing the endpoint URL.

### Supported Operations

| Category | Operations | Status |
|---|---|---|
| Object CRUD | GET, PUT, DELETE, HEAD, COPY | Supported |
| Listing | ListObjectsV2, ListObjectVersions | Supported |
| Multipart | CreateMultipartUpload, UploadPart, CompleteMultipartUpload, AbortMultipartUpload | Supported |
| Versioning | GetBucketVersioning, PutBucketVersioning | Supported |
| Lifecycle | GetBucketLifecycleConfiguration, PutBucketLifecycleConfiguration | Supported |
| Encryption | SSE-S3 (AES256), SSE-C | Supported |
| Auth | SigV4 (header + query string), STS temporary credentials | Supported |
| Presigned URLs | GET and PUT presigned URLs | Supported |
| CORS | GetBucketCors, PutBucketCors | Supported |
| Tagging | GetObjectTagging, PutObjectTagging | Supported |
| Conditional | If-Match, If-None-Match, If-Modified-Since, If-Unmodified-Since | Supported |
| Range reads | Range header (bytes=start-end) | Supported |

### Not Yet Supported

| Feature | Notes |
|---|---|
| S3 Select | Use Neolith ETL transforms instead |
| SSE-KMS | SSE-S3 and SSE-C supported; KMS planned for v0.6 |
| Object Lock | Not yet implemented |
| Intelligent Tiering | Use lifecycle rules for expiration |
| S3 Object Lambda | Use Neolith ETL transforms (WASM/container) |
| Transfer Acceleration | Not applicable (self-hosted) |

## Data Migration Strategies

### Strategy 1: rclone (Recommended for Most Workloads)

rclone provides reliable, resumable transfers with built-in parallelism:

```bash
# Configure AWS S3 source
rclone config create aws s3 \
  provider=AWS \
  access_key_id="$AWS_ACCESS_KEY_ID" \
  secret_access_key="$AWS_SECRET_ACCESS_KEY" \
  region=us-east-1

# Configure Neolith target
rclone config create neolith s3 \
  provider=Other \
  access_key_id=neolithadmin \
  secret_access_key=neolithadmin \
  endpoint=http://neolith:9000

# Sync a bucket
rclone sync aws:my-bucket neolith:my-bucket \
  --transfers 32 \
  --checkers 16 \
  --progress \
  --fast-list

# Verify
rclone check aws:my-bucket neolith:my-bucket --one-way
```

For large datasets (multi-TB), run rclone on an EC2 instance in the same region as your S3 bucket to avoid cross-region transfer costs, then copy from that instance to your Neolith cluster.

### Strategy 2: aws s3 sync

The AWS CLI works directly against Neolith:

```bash
# Copy from S3 to local staging
aws s3 sync s3://my-bucket /mnt/staging/my-bucket

# Copy from staging to Neolith
aws --endpoint-url http://neolith:9000 s3 sync /mnt/staging/my-bucket s3://my-bucket
```

### Strategy 3: Incremental Migration

For zero-downtime migration, run both systems in parallel during a transition period:

1. Start syncing data from S3 to Neolith using rclone
2. Configure your application to dual-write to both S3 and Neolith
3. Read from S3 (primary) with fallback to Neolith
4. Once fully synced, switch reads to Neolith
5. Stop writes to S3

## IAM Policy Mapping

AWS IAM policies use ARN-based resource identifiers. Neolith OSS uses access key/secret key pairs for authentication. Neolith Enterprise provides bucket policies with the same JSON format, using `arn:neolith:s3:::` instead of `arn:aws:s3:::`.

Neolith also supports STS `GetSessionToken` for temporary credentials (ASIA-prefixed access keys, 900s to 43200s duration).

## Feature Differences

### What You Gain with Neolith

| Feature | AWS S3 | Neolith |
|---|---|---|
| Batch GET API | Not available | TAR+LZ4 streaming, 1000x less HTTP overhead |
| Epoch streaming | Not available | Server-side shuffle + prefetch for ML |
| PyTorch SDK | Not available | Native DataLoader integration |
| Server-side ETL | S3 Object Lambda ($$$) | Built-in WASM + container transforms |
| Bucket forks | Not available | Copy-on-write branching |
| Egress costs | $0.09/GB | $0 (your network) |
| Request costs | $0.0004-0.005 per 1K | $0 (your hardware) |
| Data sovereignty | AWS regions | Your datacenter, your rules |
| Vendor lock-in | AWS ecosystem | Apache 2.0, self-hosted |

### What You Lose (or Gain Differently)

| AWS Feature | Neolith Alternative |
|---|---|
| 11 nines durability | Configurable EC (up to RS(10,4) or LRC) |
| S3 Glacier / Deep Archive | Not available (use lifecycle expiration) |
| S3 Intelligent Tiering | Not available |
| CloudWatch metrics | Prometheus + Grafana |
| AWS Lambda triggers | HTTP webhook notifications |
| S3 Access Logs | Neolith Enterprise audit logs |
| Cross-region replication | Neolith Enterprise replication |
| S3 Inventory | LIST API, admin endpoints |

## Cost Comparison

The cost advantage of self-hosted storage depends on scale. At small volumes, AWS S3 is simpler. At larger volumes, the economics shift dramatically.

### Example: 100 TB Storage, 500 TB/month Reads

| Cost Component | AWS S3 Standard | Neolith (Self-Hosted) |
|---|---|---|
| Storage (100 TB) | $2,300/mo | Hardware amortized |
| PUT requests (10M/mo) | $50/mo | $0 |
| GET requests (500M/mo) | $200/mo | $0 |
| Data transfer (500 TB out) | $45,000/mo | $0 |
| **Total monthly** | **~$47,550/mo** | **Hardware + power + ops** |

A 3-node Neolith cluster with 100 TB usable capacity (64-core servers, 8x 8TB NVMe each) costs roughly $43,500 in hardware, or ~$1,208/mo amortized over 3 years. At this scale, Neolith pays for itself in under one month of saved egress fees alone.

### When AWS S3 Is the Better Choice

- Storage under 1 TB with light access patterns
- Need for S3 Glacier or Intelligent Tiering
- Tight integration with AWS Lambda, Athena, Redshift
- No operations team to manage infrastructure
- Multi-region availability requirements without self-managed replication

## Migration Checklist

1. **Audit**: Inventory all S3 buckets, sizes, access patterns, and dependent services
2. **Plan capacity**: Size your Neolith cluster based on total storage + throughput needs
3. **Deploy Neolith**: Set up cluster, configure TLS, create access credentials
4. **Create buckets**: Replicate bucket configuration (versioning, lifecycle, CORS)
5. **Migrate data**: Use rclone or batch copy, starting with non-critical buckets
6. **Verify**: Compare object counts and checksums between S3 and Neolith
7. **Update applications**: Change endpoint URL, update credentials
8. **Parallel run**: Run both systems for a transition period, monitor for issues
9. **Migrate notifications**: Reconfigure event triggers for Neolith webhooks
10. **Cutover**: Switch all traffic to Neolith, disable S3 writes
11. **Decommission**: After retention period, delete S3 data to stop billing

## Client Configuration Examples

### boto3 (Python)

```python
import boto3

s3 = boto3.client('s3', endpoint_url='http://neolith:9000',
    aws_access_key_id='neolithadmin', aws_secret_access_key='neolithadmin',
    region_name='us-east-1')  # region is required by boto3 but the value does not matter
```

### AWS CLI

```bash
export AWS_ACCESS_KEY_ID=neolithadmin
export AWS_SECRET_ACCESS_KEY=neolithadmin
export AWS_ENDPOINT_URL=http://neolith:9000
aws s3 ls
```

For additional SDK examples (Go, Rust, JavaScript), see the [SDK documentation](/docs/sdk/overview).
