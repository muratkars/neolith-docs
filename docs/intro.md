---
sidebar_position: 1
slug: /intro
title: Introduction
---

# What is Neolith?

Neolith is a next-generation cloud object storage system built in Rust, designed from the ground up for AI/ML workloads while providing full S3 API compatibility.

## Key Features

- **AI/ML-Native**: Batch GET with TAR+LZ4/zstd streaming, epoch-based data loading, deterministic Fisher-Yates shuffle, WASM ETL transforms, native PyTorch SDK
- **Rust Performance**: Zero-copy metadata (FlatBuffers MetaView), mandatory SIMD erasure coding (12+ GB/s/core), io_uring on Linux, jemalloc allocator
- **S3-Compatible**: SigV4 auth, multipart uploads, versioning, lifecycle rules, presigned URLs, CORS, tagging, conditional requests
- **Self-Healing**: Reed-Solomon + LRC erasure coding, background scanner, priority repair queue, on-read corruption detection
- **Single Binary**: One binary, one port (9000), one config file. No etcd, no Raft, no coordinator. HLC-based consistency
- **Apache 2.0**: No AGPL restrictions. Enterprise features available separately

## Architecture at a Glance

Neolith uses a symmetric peer-to-peer architecture where every node is identical. Data is erasure-coded across drives using Reed-Solomon or Locally Repairable Codes (LRC), with placement determined by Tiered Consistent Hashing (TCH). Metadata is stored as per-object FlatBuffer sidecar files - no embedded database.

| Component | Technology |
|-----------|-----------|
| Language | Rust (Edition 2024, MSRV 1.85) |
| Serialization | FlatBuffers v2 (zero-copy) |
| Erasure Coding | Reed-Solomon + LRC (SIMD-only) |
| Network | HTTP/2 (Axum + hyper), single port 9000 |
| Crypto | aws-lc-rs (FIPS 140-3 capable) |
| TLS | rustls 1.3 only (no OpenSSL) |
| Hashing | BLAKE3 (128-bit truncated for ETag) |
| Allocator | jemalloc (Linux), system (macOS) |

## Quick Example

```bash
# Start a single-node server
neolith server start /data

# Create a bucket and upload a file
aws --endpoint-url http://localhost:9000 s3 mb s3://my-bucket
aws --endpoint-url http://localhost:9000 s3 cp myfile.txt s3://my-bucket/

# Download the file
aws --endpoint-url http://localhost:9000 s3 cp s3://my-bucket/myfile.txt ./downloaded.txt
```

## What's Next?

- [Installation](/docs/installation) - Build from source or run with Docker
- [Quickstart](/docs/quickstart) - Your first bucket in 5 minutes
- [Architecture Overview](/docs/architecture/overview) - Deep dive into the design
- [S3 API Reference](/docs/s3-api/overview) - Full API documentation
