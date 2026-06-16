---
sidebar_position: 1
title: Architecture Overview
---

# Architecture Overview

Neolith is built as a symmetric, leaderless distributed storage system. Every node in the cluster runs the same binary and has the same capabilities. There is no coordinator, no consensus protocol, and no external dependency like etcd or ZooKeeper.

## Design Principles

1. **Simplicity**: Single binary, single port, single config file. No moving parts to fail.
2. **Performance**: Zero-copy metadata, SIMD erasure coding, io_uring I/O, jemalloc. Every layer is optimized for throughput.
3. **Correctness**: `forbid(unsafe_code)` workspace-wide (with a narrow exception for generated FlatBuffer code). Hybrid Logical Clocks for causal ordering. Write quorum for durability.
4. **AI/ML-Native**: First-class batch operations, epoch-based training, ETL transforms, and native PyTorch/framework SDKs - not bolted on as an afterthought.

## Single Port Architecture

All traffic flows through a single port (default 9000) over HTTP/2:

```
Port 9000
  |
  +-- S3 API        /bucket/key              (client data traffic)
  +-- Admin API     /_neolith/admin/v1/...   (cluster management)
  +-- RPC           /_neolith/v1/...         (inter-node replication)
  +-- Metrics       /metrics                 (Prometheus exposition)
  +-- Batch API     /?batch-get, ?batch-epoch (AI/ML batch operations)
  +-- ETL API       /etl/v1/transforms/...   (transform management)
```

This simplifies deployment, firewall rules, and load balancer configuration. TLS (rustls, 1.3 only) and mTLS are applied uniformly to all traffic.

## Workspace Crates

Neolith is organized as a Cargo workspace with 17 crates, each responsible for a distinct concern:

| Crate | Purpose |
|-------|---------|
| `neolith-server` | Binary entry point, CLI, AppState, server lifecycle |
| `neolith-s3` | S3 API handlers (GET, PUT, DELETE, LIST, multipart, etc.) |
| `neolith-store` | Storage engine: shard I/O, metadata management, MetaStore |
| `neolith-meta` | ObjectMeta, MetaView, FlatBuffer schema, serialization |
| `neolith-ec` | Erasure coding: Reed-Solomon, LRC, SIMD backends |
| `neolith-crypto` | Encryption (SSE-S3, SSE-C), HKDF, AES-256-GCM blocks |
| `neolith-compress` | Compression (LZ4, zstd), smart skip logic |
| `neolith-hash` | BLAKE3 hashing, 128-bit truncation, checksums |
| `neolith-cluster` | Topology, TCH placement, heartbeat, RPC client/server |
| `neolith-heal` | Self-healing: scanner, priority queue, hotness tracker |
| `neolith-batch` | Batch GET: TAR assembly, epochs, shuffle, prefetch |
| `neolith-etl` | ETL transforms: WASM sandbox, native transforms, cache |
| `neolith-admin` | Admin API: info, heal, rebalance, pool management |
| `neolith-config` | Configuration parsing, validation, defaults |
| `neolith-error` | NeolithError enum, IoPath variant, error conversions |
| `neolith-io` | I/O engines: Standard, io_uring, buffer pools |
| `neolith-bench` | Built-in benchmark: HdrHistogram, PUT/GET workloads |

## Symmetric Peer-to-Peer

Every Neolith node is identical. There are no special roles (no master, no name node, no metadata server):

```
  Client          Client          Client
    |               |               |
    v               v               v
 +------+       +------+       +------+
 |Node 1| <---> |Node 2| <---> |Node 3|
 +------+       +------+       +------+
    |               |               |
  [disks]         [disks]         [disks]
```

Nodes discover each other via a static TOML peer list. Each node periodically polls its peers for topology updates (heartbeat). Placement decisions are computed locally using Tiered Consistent Hashing (TCH) - every node arrives at the same placement independently, with no coordination.

## Data Path Overview

### PUT (Write)

```
Client POST/PUT
       |
  [Receive body into contiguous buffer]
       |
  [Smart Skip: check entropy/magic/content-type]
       |
  [Compress: LZ4 (default) or zstd]
       |
  [Erasure Code: split into K data + M parity shards]
       |
  [Encrypt: AES-256-GCM per shard, per-object DEK via HKDF]
       |
  [Write: shards to local/remote drives, meta.neo sidecar]
       |
  [Quorum: wait for N/2+1 acknowledgments]
       |
  [HLC: stamp with hybrid logical clock timestamp]
       |
  HTTP 200 OK + ETag
```

### GET (Read)

```
Client GET
       |
  [Locate: TCH -> partition -> nodes -> drives]
       |
  [Read: fetch K of K+M shards in parallel]
       |
  [Verify: BLAKE3 checksum per shard]
       |
  [EC Decode: reconstruct if degraded]
       |
  [Decrypt: AES-256-GCM per shard]
       |
  [Decompress: LZ4/zstd]
       |
  [Read-repair: compare HLC with remote, fetch newer if stale]
       |
  HTTP 200 OK + body
```

## Metadata Design

Neolith stores metadata as per-object FlatBuffer sidecar files (`.neo`), not in an embedded database. This design choice provides:

- **No compaction pauses**: No LSM tree, no write amplification from background compaction
- **Filesystem-native**: Metadata files can be inspected, backed up, and recovered with standard tools
- **Zero-copy reads**: MetaView provides field access without deserialization for LIST and HEAD operations (10-100x faster)
- **Crash consistency**: Atomic rename (write to `.tmp`, then rename) ensures metadata is never partially written

See [Metadata](/docs/architecture/metadata) for details.

## Consistency Model

Neolith uses Hybrid Logical Clocks (HLC) for causal ordering rather than a consensus protocol like Raft or Paxos. This gives strong consistency within a write quorum without the latency overhead of leader election:

- **Writes**: Fan out to N/2+1 replicas. Local write first, rollback on quorum failure.
- **Reads**: Read from local, check one remote HLC. If remote is newer, fetch and serve the newer version (read-repair).
- **Deletes**: Last-Writer-Wins (LWW) based on HLC ordering.

See [Consistency](/docs/architecture/consistency) for details.

## Self-Healing

Neolith continuously monitors data integrity and automatically repairs detected problems:

- **On-read verification**: Every shard read is verified against its BLAKE3 checksum. Corrupt shards are repaired inline.
- **Background scanner**: Full-drive scan on a 30-day cycle, per-object throttling to avoid I/O storms.
- **Priority queue**: Repairs are prioritized by criticality (remaining healthy shards), hotness (access frequency), and age.
- **LRC fast path**: For single-shard failures with LRC coding, local parity repair reads only ~25% of the data compared to global RS decode.

## What's Next?

- [Data Path](/docs/architecture/data-path) - Detailed PUT and GET pipeline
- [Metadata](/docs/architecture/metadata) - FlatBuffer schema and MetaView
- [Erasure Coding](/docs/architecture/erasure-coding) - RS and LRC details
- [Cluster Topology](/docs/architecture/cluster) - TCH placement and failure domains
- [Consistency](/docs/architecture/consistency) - HLC and quorum semantics
- [Encryption](/docs/architecture/encryption) - SSE-S3, SSE-C, and TLS
- [Compression](/docs/architecture/compression) - LZ4, zstd, and smart skip
- [I/O Engine](/docs/architecture/io-engine) - io_uring and standard backends
