---
slug: introducing-neolith
title: "Introducing Neolith: Next-Gen Object Storage for AI/ML"
authors:
  - name: "Murat Karslioglu"
    title: "Creator"
    url: "https://github.com/muratkars"
tags: [announcement, rust, storage, ai-ml]
---

# Introducing Neolith: Next-Gen Object Storage for AI/ML

Every existing object storage system forces a tradeoff that should not exist. MinIO delivers the best S3 implementation but is constrained by AGPL licensing and Go's garbage collector. Ceph provides exabyte-scale unified storage but demands a dedicated operations team for its 3-million-line C++ codebase. NVIDIA AIStore is purpose-built for ML training but has no encryption, no Object Lock, and auth is disabled by default. None of them combine AI-native storage primitives with enterprise governance, hardware-accelerated I/O, and operational simplicity.

Today we are introducing **Neolith**: a next-generation object storage system built in Rust, designed for the AI era, and released under the Apache 2.0 license.

<!-- truncate -->

## Why We Built Neolith

The rise of large-scale AI/ML training has exposed a fundamental gap in storage infrastructure. Training a large language model or a computer vision system requires reading petabytes of data across hundreds of epochs. Every training step that waits on storage is a GPU sitting idle at $2-3/hour. The storage layer is no longer a dumb pipe: it is a compute participant.

Existing object stores were not designed for this workload. They serve one object per request. They do not shuffle. They do not batch. They do not transform data at the storage layer. ML engineers are forced to build complex data pipelines that pre-process, cache, and stage data outside the storage system, adding cost, latency, and failure modes.

Neolith closes this gap. One binary. One API surface. From a Raspberry Pi to an exabyte datacenter.

## Key Differentiators

### AI-Native Storage Primitives

Neolith is the first object storage system with built-in ML training primitives:

- **Batch GET**: A single HTTP request returns hundreds of objects packed in TAR+LZ4 or TAR+zstd. One request replaces hundreds of individual GETs, reducing per-object overhead by orders of magnitude.
- **Epoch-based training**: Register an epoch with `POST ?batch-epoch`, then stream shuffled batches with `GET ?batch-next`. Deterministic Fisher-Yates shuffle ensures reproducible training across runs.
- **ETL-on-GET**: Apply transforms (resize, normalize, augment) at the storage layer with `GET ?transform=<name>`. Transforms run as native Rust functions or sandboxed WASM modules. Results are cached with BLAKE3-keyed LRU eviction.
- **PyTorch SDK**: A native Python `IterableDataset` with thread-based prefetch, automatic TAR parsing, and LZ4 decompression. Drop it into any PyTorch `DataLoader`.

### Rust Performance Without Compromise

Neolith is written entirely in Rust with `deny(unsafe_code)` at the workspace level. This means:

- **Zero garbage collection**: No GC pauses, ever. Tail latency is deterministic under all memory pressure conditions.
- **Memory safety**: Buffer overflows, use-after-free, and data races are compile-time errors. Memory-safety CVEs are architecturally impossible.
- **Mandatory SIMD erasure coding**: No scalar fallback. The `reed-solomon-simd` crate requires SIMD at compile time, ensuring consistent encoding/decoding throughput.
- **FIPS 140-3 via aws-lc-rs**: Cryptographic operations use AWS's libcrypto (the same library behind AWS's own services), providing FIPS-capable encryption without CGo or OpenSSL.

### Apache 2.0 License

Neolith's open-source edition is Apache 2.0. Not AGPL. Not SSPL. Not BSL. This means:

- Cloud providers can offer managed Neolith without licensing constraints
- SaaS companies can embed Neolith without open-sourcing their stack
- ISVs can bundle Neolith in proprietary products
- Enterprises can modify Neolith without contribution-back requirements

We believe open-source storage infrastructure should be truly open.

## Architecture Highlights

### Single Binary, Single Port

Neolith runs as a single binary serving everything on port 9000: S3 API, Batch API, Admin API, and inter-node RPC all share the same Axum HTTP/2 server. No coordinator daemons, no external databases, no ZooKeeper, no etcd. If you can run `systemctl start neolith`, you can run a cluster.

### Per-Shard FlatBuffer Metadata

Unlike systems that embed metadata in RocksDB or SQLite, Neolith stores metadata as per-shard FlatBuffer files. The `MetaView` zero-copy fast path serves HEAD and LIST operations by reading fields directly from memory-mapped buffers, with no deserialization cost. This is 10-100x faster than traditional approaches for metadata-heavy workloads.

### LRC Erasure Coding

Neolith supports both standard Reed-Solomon and Local Reconstruction Codes (LRC). LRC organizes parity into local groups, enabling single-shard failures to be repaired by reading only the local group (typically 5 shards) instead of all data shards (typically 10+). This reduces repair I/O by approximately 75%, which matters enormously at scale: a 1000-drive cluster experiences a drive failure every few days, and each repair reads terabytes of data.

### Hybrid Logical Clocks

Distributed consistency uses 64-bit Hybrid Logical Clocks (48 bits physical + 16 bits logical) stored in `AtomicU64` for lock-free reads. Write quorum fans out to N/2+1 replicas. Read-repair checks a remote replica HLC and fetches newer versions inline. Last-Writer-Wins conflict resolution ensures convergence without coordination.

## Current Status

Neolith v0.4 is complete with:

- **68 OSS features** across 20 phases, covering S3 API, erasure coding, encryption, versioning, lifecycle, batch GET/epoch, ETL transforms, PyTorch SDK, TLS/mTLS, multipart uploads, presigned URLs, admin API, and more
- **57 Enterprise features** across 13 phases, covering multi-tenancy, compliance, audit, replication, tiering, OIDC/LDAP, KMS, observability, web console, and Kubernetes operator
- **928 OSS tests + 524 Enterprise tests** with zero clippy warnings
- **v0.5 planned**: Event notifications and bucket forks

## What's Next

The v0.5 roadmap includes:

- **Event notifications** (#128-129): Webhook and message queue notifications for object events (create, delete, replicate), enabling event-driven architectures.
- **Bucket forks** (#130-131): Fork-on-write branching for buckets, enabling experimentation and A/B testing of datasets without copying data.

Beyond v0.5, we are planning field testing phases: crash consistency verification, Loom/Shuttle concurrency testing, Pocket Watch deterministic simulation, and Chaos Mesh fault injection.

## Get Started

Neolith is open source under Apache 2.0. Try it today:

```bash
# Clone and build
git clone https://github.com/muratkars/neolith.git
cd neolith
cargo build --release

# Start a single-node server
./target/release/neolith server start

# Use with any S3 client
aws s3 mb s3://my-bucket --endpoint-url http://localhost:9000
aws s3 cp my-file.txt s3://my-bucket/ --endpoint-url http://localhost:9000
```

We welcome contributions, bug reports, and feature requests. Star the repo on [GitHub](https://github.com/muratkars/neolith) and join the community.
