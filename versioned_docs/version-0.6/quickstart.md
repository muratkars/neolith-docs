---
sidebar_position: 3
title: Quickstart
---

# Quickstart

Get up and running with Neolith in 5 minutes. This guide covers single-node setup, basic S3 operations, authentication, encryption, and multi-drive configuration.

## Prerequisites

- Neolith binary installed (see [Installation](/docs/installation))
- AWS CLI v2 installed (`brew install awscli` or `apt install awscli`)

## Start a Single-Node Server

Create a data directory and start Neolith:

```bash
mkdir -p /data/neolith
neolith server start /data/neolith
```

You should see output like:

```
[INFO] Neolith v0.4.0
[INFO] SIMD: AVX2 detected
[INFO] Erasure coding: RS(8,4)
[INFO] Data path: /data/neolith
[INFO] Listening on http://0.0.0.0:9000
```

Neolith is now running and accepting S3 requests on port 9000.

## Configure the AWS CLI

Point the AWS CLI at your Neolith instance. When running without authentication (development mode), any credentials will work:

```bash
aws configure
# AWS Access Key ID: test
# AWS Secret Access Key: test
# Default region name: us-east-1
# Default output format: json
```

Set up an alias for convenience:

```bash
alias neos3='aws --endpoint-url http://localhost:9000 s3'
alias neos3api='aws --endpoint-url http://localhost:9000 s3api'
```

## Create a Bucket

```bash
neos3 mb s3://my-bucket
# make_bucket: my-bucket
```

List buckets:

```bash
neos3 ls
# 2026-03-17 10:00:00 my-bucket
```

## Upload and Download Objects

Upload a file:

```bash
echo "Hello, Neolith!" > hello.txt
neos3 cp hello.txt s3://my-bucket/hello.txt
# upload: ./hello.txt to s3://my-bucket/hello.txt
```

List objects in the bucket:

```bash
neos3 ls s3://my-bucket/
# 2026-03-17 10:01:00   16 hello.txt
```

Download the file:

```bash
neos3 cp s3://my-bucket/hello.txt downloaded.txt
cat downloaded.txt
# Hello, Neolith!
```

## Upload a Directory

```bash
neos3 cp /path/to/dataset/ s3://my-bucket/dataset/ --recursive
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

Update the AWS CLI credentials:

```bash
aws configure
# AWS Access Key ID: myaccesskey
# AWS Secret Access Key: mysupersecretkey
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
neos3 cp secret.txt s3://my-bucket/secret.txt
neos3 cp s3://my-bucket/secret.txt decrypted.txt
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
  "version": "0.4.0",
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
