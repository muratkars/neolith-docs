---
sidebar_position: 1
title: "Migrate from MinIO"
---

# Migrate from MinIO

Neolith and MinIO are both S3-compatible object storage systems, so migrating data between them is straightforward. This guide covers API compatibility, configuration mapping, data migration strategies, and the key differences between the two systems.

## S3 API Compatibility

Neolith supports the core S3 API surface that MinIO applications rely on. Most client code works without modification - just change the endpoint URL.

### What Works Unchanged

| Feature | MinIO | Neolith | Notes |
|---|---|---|---|
| PUT / GET / DELETE | Yes | Yes | Fully compatible |
| Multipart upload | Yes | Yes | 5 MiB min, 10K max parts |
| SigV4 auth | Yes | Yes | Header + query string |
| LIST v2 | Yes | Yes | Prefix, delimiter, continuation |
| Versioning | Yes | Yes | Enable/Suspend, version IDs |
| Lifecycle | Yes | Yes | Expiration + noncurrent version |
| Presigned URLs | Yes | Yes | Up to 7-day expiry |
| CORS | Yes | Yes | Per-bucket configuration |
| Tagging | Yes | Yes | Up to 10 tags per object |
| SSE-S3 | Yes | Yes | AES-256-GCM |
| SSE-C | Yes | Yes | Customer-provided keys |

### What Requires Changes

| Feature | MinIO | Neolith | Migration Path |
|---|---|---|---|
| MinIO Client (mc) | Native | Not supported | Use aws-cli or rclone |
| Admin API | MinIO proprietary | Neolith admin API | Update admin scripts |
| ILM tiering | Built-in | Not yet available | Use lifecycle expiration |
| Bucket notifications | SNS/SQS/Kafka/etc. | HTTP webhooks | Update notification targets |
| MinIO Console | Built-in web UI | Neolith Console | Different UI, similar features |
| Server-side replication | Built-in | Enterprise only | Requires Enterprise license |
| IAM/LDAP | Built-in | Enterprise only | Requires Enterprise license |

## Configuration Mapping

### MinIO Environment Variables to Neolith TOML

MinIO is configured via environment variables. Neolith uses a TOML configuration file.

**MinIO:**

```bash
export MINIO_ROOT_USER=minioadmin
export MINIO_ROOT_PASSWORD=minioadmin
export MINIO_VOLUMES="/data{1...4}"
export MINIO_SERVER_URL="https://minio.example.com:9000"
export MINIO_BROWSER=on
```

**Neolith (config.toml):**

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

Neolith also supports environment variables for sensitive values:

```bash
export NEOLITH_ACCESS_KEY=neolithadmin
export NEOLITH_SECRET_KEY=neolithadmin
export NEOLITH_MASTER_KEY=hex-encoded-256-bit-key
```

### Erasure Coding

MinIO uses a fixed erasure coding scheme based on the number of drives. Neolith supports configurable RS and LRC profiles:

| MinIO | Neolith Equivalent |
|---|---|
| 4 drives (EC:2) | RS(2, 2) |
| 8 drives (EC:4) | RS(4, 4) or RS(6, 2) |
| 16 drives (EC:8) | RS(8, 8) or LRC(10, 4, 2) |

## Data Migration

### Option 1: rclone (Recommended)

rclone is the most reliable tool for migrating between S3-compatible systems:

```bash
# Configure MinIO remote
rclone config create minio s3 \
  provider=Minio \
  access_key_id=minioadmin \
  secret_access_key=minioadmin \
  endpoint=http://minio:9000

# Configure Neolith remote
rclone config create neolith s3 \
  provider=Other \
  access_key_id=neolithadmin \
  secret_access_key=neolithadmin \
  endpoint=http://neolith:9000

# Migrate a bucket
rclone sync minio:my-bucket neolith:my-bucket --progress

# Migrate all buckets
for bucket in $(rclone lsd minio: | awk '{print $5}'); do
  rclone sync "minio:$bucket" "neolith:$bucket" --progress
done
```

rclone handles retries, checksums, and parallel transfers automatically. Use `--transfers 16` to increase parallelism for large migrations.

### Option 2: aws s3 sync

If you prefer the AWS CLI, use a local staging area:

```bash
aws --endpoint-url http://minio:9000 s3 sync s3://my-bucket /tmp/staging/
aws --endpoint-url http://neolith:9000 s3 sync /tmp/staging/ s3://my-bucket/
```

### Migration Verification

After migration, verify data integrity with rclone:

```bash
rclone check minio:my-bucket neolith:my-bucket --one-way
```

## Feature Mapping

### Console

MinIO includes a built-in web console for bucket management, user administration, and monitoring. Neolith provides the Neolith Console (a separate React application) with similar capabilities:

| MinIO Console | Neolith Console |
|---|---|
| Bucket browser | Bucket browser |
| User management | User management |
| Dashboard metrics | Dashboard with cluster health |
| Log viewer | Log viewer |
| Tiering configuration | Not yet available |
| Site replication | Enterprise replication |

### Notifications

MinIO supports many notification targets (SQS, SNS, Kafka, NATS, Redis, etc.). Neolith currently supports HTTP webhook notifications. Reconfigure notification consumers to accept webhooks from Neolith instead of MinIO-specific targets.

### Monitoring

Both systems expose Prometheus metrics. Update your scrape config to point to Neolith's `/metrics` endpoint (MinIO uses `/minio/v2/metrics/cluster`).

## Key Differences

### Features Neolith Has That MinIO Does Not

| Feature | Description |
|---|---|
| Batch GET API | Retrieve thousands of objects in one request (TAR+LZ4) |
| Epoch streaming | Server-side shuffle + prefetch for ML training |
| PyTorch SDK | Native DataLoader integration |
| Server-side ETL | WASM/container transforms at the storage layer |
| Bucket forks | Copy-on-write branching for experiments |
| LRC erasure coding | Local repair codes for faster single-shard recovery |
| io_uring I/O | Linux io_uring for reduced syscall overhead |
| FlatBuffers metadata | Zero-copy metadata access (MetaView) |

### Features MinIO Has That Neolith Does Not (Yet)

| Feature | Description |
|---|---|
| Broader notification targets | Kafka, SQS, NATS, Redis, etc. |
| ILM tiering | Automatic tiering to remote storage |
| Bucket quotas (OSS) | Neolith quotas are Enterprise-only |
| Lambda compute | Webhook-based object transforms |
| Active-active replication (OSS) | Neolith replication is Enterprise-only |
| LDAP/AD integration (OSS) | Neolith LDAP is Enterprise-only |

### Licensing

MinIO is licensed under AGPL v3, which requires that any application using MinIO over a network must also be open-sourced under AGPL. Neolith OSS is licensed under Apache 2.0, which has no such requirement. Neolith Enterprise features require a commercial license.

## Migration Checklist

1. **Inventory**: List all MinIO buckets, policies, and notification rules
2. **Create buckets**: Create matching buckets in Neolith with the same versioning and lifecycle settings
3. **Migrate data**: Use rclone sync for each bucket
4. **Verify**: Run rclone check to confirm integrity
5. **Update clients**: Change endpoint URL from MinIO to Neolith
6. **Update auth**: Create matching access/secret key pairs in Neolith
7. **Update notifications**: Reconfigure notification targets for Neolith webhooks
8. **Update monitoring**: Point Prometheus scrape configs to Neolith metrics endpoint
9. **Test**: Run integration tests against Neolith
10. **Cutover**: Switch DNS or load balancer to point to Neolith
