---
sidebar_position: 1
title: "Neolith vs MinIO"
---

# Neolith vs MinIO

MinIO and Neolith are both S3-compatible object storage systems designed for high-performance workloads. They differ fundamentally in language, licensing, and AI/ML focus.

## At a Glance

| Dimension | MinIO | Neolith |
|---|---|---|
| **Language** | Go | Rust |
| **License** | AGPL v3 (OSS) / Commercial | Apache 2.0 (OSS) / Commercial |
| **First Release** | 2014 | 2026 |
| **Production Scale** | 100+ PiB proven | New project, designed for exabyte |
| **S3 Coverage** | ~95% of S3 API | Core S3 + AI-native extensions |
| **Binary** | Single binary | Single binary |
| **Erasure Coding** | Reed-Solomon (Go) | Reed-Solomon + LRC (SIMD) |
| **Metadata** | XL metadata (MessagePack) | FlatBuffers (zero-copy) |
| **Encryption** | SSE-S3, SSE-C, SSE-KMS | SSE-S3, SSE-C (KMS in Enterprise) |
| **AI/ML Native** | No (third-party integrations) | Batch GET, ETL-on-GET, PyTorch SDK |
| **Lakehouse** | Iceberg, Delta (native tables) | Iceberg REST Catalog (Enterprise) |
| **FIPS 140** | Via BoringCrypto (CGo) | Via aws-lc-rs (native Rust) |

## Performance

### Rust vs Go

MinIO is written in Go, which brings garbage collection pauses to the I/O path. While Go's GC has improved significantly (sub-millisecond pauses in most cases), it introduces non-deterministic tail latency. Under high memory pressure or large heap sizes, GC pauses can reach several milliseconds.

Neolith is written in Rust with zero garbage collection. Memory is managed deterministically through ownership and borrowing. This gives Neolith predictable tail latency under all conditions, which matters for latency-sensitive ML training pipelines where a single slow batch stalls the entire GPU cluster.

### Erasure Coding

MinIO uses Reed-Solomon erasure coding implemented in Go with assembly-optimized kernels for x86 (AVX2/AVX-512) and ARM (NEON). Performance is strong but bounded by Go's calling conventions and goroutine scheduling.

Neolith uses mandatory SIMD erasure coding via the `reed-solomon-simd` crate. There is no scalar fallback: the binary requires SIMD at compile time. This eliminates runtime dispatch overhead and ensures consistent throughput. Additionally, Neolith supports LRC (Local Reconstruction Codes) that reduce repair I/O by approximately 75% compared to standard Reed-Solomon by enabling local parity groups.

### Metadata

MinIO stores metadata in XL format using MessagePack serialization. Every HEAD or LIST operation requires full deserialization of the metadata structure.

Neolith uses FlatBuffers for metadata serialization with a `MetaView` zero-copy fast path. HEAD and LIST operations on unencrypted, uncompressed objects access metadata fields directly from the memory-mapped buffer without any deserialization. This is 10-100x faster for metadata-heavy workloads like large directory listings.

## Licensing

This is often the decisive factor.

**MinIO AGPL**: MinIO's open-source edition is licensed under AGPL v3. Under AGPL, if you modify MinIO and provide it as a network service (SaaS), you must release your modifications under AGPL. This effectively prohibits:
- Cloud providers from offering managed MinIO without a commercial license
- SaaS companies from embedding MinIO without open-sourcing their stack
- ISVs from bundling MinIO without AGPL compliance

MinIO's commercial license removes the AGPL constraint but adds per-TiB or per-node fees.

**Neolith Apache 2.0**: Neolith's open-source edition is Apache 2.0, a permissive license that allows:
- Embedding in proprietary products without source disclosure
- Offering as a managed service without licensing obligations
- Modification without contribution-back requirements
- Use in any context without AGPL compliance concerns

For SaaS companies, cloud providers, and ISVs, the Apache 2.0 license eliminates a significant legal and business risk.

## AI/ML Features

This is where Neolith diverges most sharply from MinIO.

| Feature | MinIO | Neolith |
|---|---|---|
| Batch GET (one-shot) | No | `POST ?batch-get` with TAR+LZ4/zstd |
| Epoch-based training | No | `POST ?batch-epoch` + `GET ?batch-next` |
| Deterministic shuffle | No | Fisher-Yates via seeded StdRng |
| ETL on GET | No | `GET ?transform=<name>` inline transforms |
| ETL transforms | No | Native, WASM (wasmtime), Container |
| Transform cache | No | BLAKE3-keyed, LZ4 disk-backed, LRU |
| PyTorch SDK | No (use S3 SDK) | Native `IterableDataset` with prefetch |
| Prefetch pipeline | No | Semaphore-bounded memory budget |

MinIO provides excellent S3 compatibility and relies on external tools (PyTorch's built-in S3 integration, third-party ETL systems) for ML workflows. Neolith builds these primitives into the storage layer itself, eliminating network round-trips and reducing pipeline complexity.

### Batch GET Example

With MinIO, fetching 10,000 small files for a training batch requires 10,000 individual GET requests. With Neolith:

```python
# Neolith PyTorch SDK
from neolith import NeolithDataset

dataset = NeolithDataset(
    endpoint="http://neolith:9000",
    bucket="training-data",
    prefix="imagenet/train/",
    batch_size=256,
    shuffle=True,
    seed=42,  # Deterministic shuffle
    format="tar-lz4",
    prefetch=4,
)

for batch in DataLoader(dataset, num_workers=4):
    # Each batch is a single HTTP request returning TAR+LZ4
    images, labels = batch
    ...
```

One HTTP request returns 256 objects packed in TAR+LZ4, reducing per-object overhead by 256x.

## Lakehouse Integration

MinIO has invested heavily in lakehouse integration, providing native Iceberg and Delta table support through MinIO Tables. This is a mature, production-tested feature.

Neolith offers an Iceberg REST Catalog in the AI Edition, with table management via the `neolith-catalog` crate. This is newer and less battle-tested than MinIO's implementation but follows the standard Iceberg REST Catalog specification.

## Operational Model

Both systems follow a single-binary deployment model with no external dependencies (no ZooKeeper, no etcd). Configuration is straightforward in both cases.

| Aspect | MinIO | Neolith |
|---|---|---|
| Configuration | Environment variables + `config.json` | TOML config + env vars |
| Cluster formation | Server pool arguments at startup | Static TOML peers + heartbeat |
| Upgrade | Rolling restart | Rolling restart |
| Monitoring | Prometheus + built-in console | Prometheus + Grafana dashboards (Enterprise) |
| Web Console | Built-in (all editions) | Enterprise only |
| K8s Operator | MinIO Operator (mature) | neolith-operator via kube-rs (new) |

## When to Choose MinIO

- You need production-proven scale (100+ PiB) with extensive S3 API coverage
- Lakehouse integration (Iceberg/Delta) is a primary requirement
- You have existing MinIO operational expertise
- AGPL licensing is acceptable for your use case
- You need the broadest ecosystem of third-party integrations

## When to Choose Neolith

- Apache 2.0 licensing is required (SaaS, ISV, cloud provider, embedded)
- AI/ML training workloads demand batch GET, ETL-on-GET, and native PyTorch integration
- Predictable tail latency matters (Rust vs Go GC)
- LRC erasure coding is needed to reduce repair I/O by 75%
- You want zero-copy metadata performance for metadata-heavy workloads
- FIPS 140-3 without CGo (native Rust crypto via aws-lc-rs)
