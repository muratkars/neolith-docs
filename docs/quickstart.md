---
sidebar_position: 3
title: Quickstart
---

# Quickstart

Get up and running with Neolith in 5 minutes. This guide covers single-node setup, basic S3 operations, authentication, encryption, and multi-drive configuration.

## Prerequisites

- Neolith binary installed (see [Installation](/docs/installation))
- `mc` (MinIO Client) installed:
  ```bash
  brew install minio/stable/mc   # macOS
  # wget https://dl.min.io/client/mc/release/linux-amd64/mc && chmod +x mc && sudo mv mc /usr/local/bin/   # Linux
  ```

## Start a Single-Node Server

Create a data directory and start Neolith:

```bash
mkdir -p /data/neolith
neolith server start /data/neolith
```

You should see output like:

```
[INFO] Neolith v0.6.0
[INFO] SIMD: AVX2 detected
[INFO] Erasure coding: RS(8,4)
[INFO] Data path: /data/neolith
[INFO] Listening on http://0.0.0.0:9000
```

Neolith is now running and accepting S3 requests on port 9000.

## Configure mc

`mc` (MinIO Client) is a lightweight S3-compatible CLI. Configure an alias pointing at your Neolith instance - when running without authentication (development mode), any credentials will work:

```bash
# Configure alias (replace URL, KEY, SECRET with your values)
mc alias set myn http://localhost:9000 ACCESS_KEY SECRET_KEY
```

This guide uses the alias `myn` (short for "my neolith") throughout.

:::note Neolith-native client
[`neo`](https://github.com/muratkars/neo) is Neolith's native S3 client - all standard S3 operations plus `neo batch get`, bucket forks, ETL transforms, and ML dataset inspection.
:::

## Create a Bucket

```bash
mc mb myn/my-bucket
# Bucket created successfully `myn/my-bucket`.
```

List buckets:

```bash
mc ls myn
# [2026-03-17 10:00:00]     0B my-bucket/
```

## Upload and Download Objects

Upload a file:

```bash
echo "Hello, Neolith!" > hello.txt
mc cp hello.txt myn/my-bucket/hello.txt
# ...hello.txt: 16 B / 16 B
```

List objects in the bucket:

```bash
mc ls myn/my-bucket/
# [2026-03-17 10:01:00]    16B hello.txt
```

Download the file:

```bash
mc cp myn/my-bucket/hello.txt downloaded.txt
cat downloaded.txt
# Hello, Neolith!
```

## Upload a Directory

```bash
mc cp --recursive /path/to/dataset/ myn/my-bucket/dataset/
```

## Enable Authentication

For production use, enable SigV4 authentication with access and secret keys:

```bash
neolith server start /data/neolith \
  --access-key myaccesskey \
  --secret-key mysupersecretkey
```

Or via environment variables:

```bash
export NEOLITH_ACCESS_KEY=myaccesskey
export NEOLITH_SECRET_KEY=mysupersecretkey
neolith server start /data/neolith
```

Update mc credentials:

```bash
mc alias set myn http://localhost:9000 myaccesskey mysupersecretkey
```

Requests without valid credentials will now return `403 Forbidden`.

## Enable Server-Side Encryption (SSE-S3)

Enable automatic encryption of all stored objects with a master key:

```bash
neolith server start /data/neolith \
  --access-key myaccesskey \
  --secret-key mysupersecretkey \
  --master-key 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
```

Or via environment variable:

```bash
export NEOLITH_MASTER_KEY=000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
neolith server start /data/neolith
```

The master key is a 32-byte hex string (64 hex characters). Each object gets a unique Data Encryption Key (DEK) derived via HKDF, and data is encrypted with AES-256-GCM in 64KB blocks.

Objects are encrypted transparently - the S3 API works exactly the same:

```bash
mc cp secret.txt myn/my-bucket/secret.txt
mc cp myn/my-bucket/secret.txt decrypted.txt
# Files are identical - encryption/decryption is automatic
```

## Multi-Drive Setup

For better performance and fault tolerance, spread data across multiple drives:

```bash
neolith server start /mnt/disk1 /mnt/disk2 /mnt/disk3 /mnt/disk4
```

Using brace expansion:

```bash
neolith server start /mnt/disk{1...4}
```

Neolith distributes erasure-coded shards across the drives. With the default RS(8,4) coding, you can lose up to 4 shards and still recover any object.

## Check Server Status

Use the admin API to verify the server is healthy:

```bash
curl http://localhost:9000/_neolith/v1/info | jq .
```

```json
{
  "version": "0.6.0",
  "edition": "oss",
  "uptime_seconds": 120,
  "drives": ["/mnt/disk1", "/mnt/disk2", "/mnt/disk3", "/mnt/disk4"]
}
```

## Using the Neolith CLI

The Neolith CLI includes cluster management commands:

```bash
# Check cluster info
neolith cluster info --endpoint http://localhost:9000

# View cluster status
neolith cluster status --endpoint http://localhost:9000

# Trigger a heal scan
neolith admin heal start --endpoint http://localhost:9000
```

## What's Next?

- [Architecture Overview](/docs/architecture/overview) - Understand how Neolith works under the hood
- [S3 API Reference](/docs/s3-api/overview) - Full API documentation
- [AI/ML Workflows](/docs/ai-ml/overview) - Batch GET, ETL transforms, and PyTorch integration
- [Operations Guide](/docs/operations/monitoring) - Monitoring, metrics, and administration
