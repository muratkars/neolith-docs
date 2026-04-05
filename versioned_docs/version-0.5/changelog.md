---
sidebar_position: 100
title: "Changelog"
sidebar_label: "Changelog"
---

# Changelog

All notable changes to Neolith are documented here. Each release includes highlights - not an exhaustive list. See the [GitHub releases](https://github.com/muratkars/neolith/releases) for full commit history.

---

## v0.5.0 - Fork You Very Much

**Released: 2026-04-05**

Bucket forks and event notifications - the features that set Neolith apart. Forks bring zero-copy branching to object storage (a first for self-hosted systems), and notifications make Neolith a reactive building block in data pipelines.

### Highlights

- **Bucket forks**: zero-copy branching with `PUT /{bucket}?fork={source}`. Fork, modify, diff, and merge - all without copying data at creation time. Copy-on-write semantics, mask-based deletes, and full lifecycle management (Active, Merged, Detached).
- **Fork diff and merge**: `GET ?fork-diff` computes added/modified/deleted keys between fork and source. `POST ?fork-merge={target}` applies changes back to any bucket.
- **S3 event notifications**: emit events on PUT, COPY, DELETE, and CompleteMultipartUpload. Per-bucket rules with prefix/suffix filters and wildcard event matching.
- **Multiple delivery destinations**: Webhook (HTTP POST with auth and custom headers), File (JSONL append), Stdout, and NATS (feature-gated). AMQP and Kafka config stubs for future implementation.
- **Dead letter queue**: failed events are persisted as JSONL for inspection and replay. Append-only, grep-friendly format.
- **Config Admin API**: `GET/PUT /_neolith/admin/v1/config` for runtime configuration management. CLI commands: `neolith admin config get/set/export/import`.
- **Object browser enhancements**: detail drawer with metadata display, inline preview (images, video, audio, PDF, JSON with syntax coloring, CSV as table, plain text), tag management, and version history timeline.

### New Crates

- **neolith-notify**: event notification engine (1,240 LOC, 39 tests)
- **neolith-fork**: bucket fork operations (32 tests)

### Stats

- 85/85 OSS features complete
- 928+ tests, zero clippy warnings

---

## v0.4.0 - Revenge of the Dashboard

**Released: 2026-03-09**

The web console arrives. Neolith is no longer CLI-only - you get a full browser-based dashboard with bucket management, object browsing, user administration, and real-time metrics.

### Highlights

- **Web Console v1**: React 18 + TypeScript + Tailwind v4, embedded as a single-page app via `rust-embed`. Eight modules: Dashboard, Buckets, Objects, Users, Login, Settings, FeatureGate, and Layout.
- **Console backend**: JWT HS256 authentication, embedded SPA serving, API proxy to S3 endpoints. `build_console_router()` integrates with the main server.
- **Bearer JWT auth for S3 API**: `ConsoleSessionValidator` trait allows Bearer tokens alongside SigV4 authentication, enabling the console to call S3 endpoints directly.
- **Bucket policy**: JSON-based bucket policies with `PUT/GET/DELETE /?policy`. Wildcard matching for principals, actions, and resources.
- **POST Object**: browser form upload support with policy validation and PUT pipeline delegation.
- **Static website hosting**: per-bucket `.website.json` configuration with index documents, error documents, and redirect rules.
- **Config hot-reload**: SIGHUP signal handler and `notify` file watcher for live config updates. Reloadable: TLS certs, credentials, log level, rate limits, notification settings.
- **User metadata**: `x-amz-meta-*` headers on PUT are stored and returned on HEAD/GET.
- **S3 router fix**: `.fallback_service(s3_router)` prevents S3 wildcard routes from capturing console and admin paths.

### New Crates

- **neolith-console**: embedded SPA backend with JWT auth (17 tests)

### Stats

- 68/68 features (at time of release), 809 Rust tests + 17 console tests + 27 conformance + 22 Python
- Zero clippy warnings

---

## v0.2.1 - The Need for Speed

**Released: 2026-03-03**

A performance-focused release delivering 13 optimizations identified during architectural review. No new features - just making everything faster.

### Highlights

- **PUT hot-path optimization**: `try_compress()` single-pass check+compress+size guard replaces two-pass `should_compress` + `compress`. Dual-hash MD5+BLAKE3 in a single pass.
- **Zero-copy PUT body**: store functions accept `&[u8]` directly, eliminating one full `body.to_vec()` allocation per PUT.
- **Copy object shortcut**: skip decompress/recompress when possible - decrypt source, re-encrypt dest, clone ETag and compression metadata.
- **Block-aligned encrypted Range GET**: `decrypt_range()` decrypts only the needed AEAD 64KB blocks instead of the full object.
- **Listing cache persistence**: save/load via bincode with atomic temp+rename. Cache survives server restarts.
- **Lock-free caches**: `DashMap` for `ListingCache` outer map and ETL transform cache, replacing `RwLock<HashMap>`.
- **Multipart parts spill to disk**: parts >= 1 MiB are written to temp files instead of held in memory, reducing memory pressure during large uploads.
- **BLAKE3 128-bit XOF direct output**: use `finalize_xof().fill()` instead of truncating the full 256-bit hash.
- **Batch fetch concurrency bounds**: Semaphore(32) in `ObjectFetcher` prevents unbounded parallel fetches.
- **RPC connection pool tuning**: `pool_max_idle_per_host` increased to 64, `pool_idle_timeout` set to 90s across all RPC client builders.

---

## v0.2.0 - The Blob Strikes Back

**Released: 2026-03-02**

Scaling beyond single-node with LRC erasure coding and pool-based online expansion. Day-2 operations get a proper admin CLI. This release also delivers the full v0.3 feature set: consistency, versioning, and operational readiness.

### Highlights

- **LRC erasure coding**: `LrcCodec` wraps global Reed-Solomon with per-group local parity. Standard ratios: (10,4,2,5) and (12,3,3,4). Local repair reads only ~25% of shards for single-shard failures.
- **Pool-based online expansion**: `PoolStore` with `.neolith/pools.json` sidecar. Add storage pools without downtime via CRUD admin endpoints and CLI.
- **Admin CLI and API**: `neolith admin heal/rebalance/pool` commands, `/_neolith/admin/v1/` REST API, edition gating with upsell messaging.
- **io_uring I/O engine**: `IoUringEngine` with dedicated OS thread and `mpsc` channel. Feature-gated behind `iouring`, Linux-only. Auto-detection falls back to `StandardEngine`.

### Consistency and Write Safety

- **Write quorum**: fan-out replicate to N/2+1 nodes, rollback on failure, orphan shard GC.
- **HLC-based consistency**: 64-bit hybrid logical clock (48ms physical + 16 logical), write ordering, read-repair, split-brain detection and merge.
- **Disk-full handling**: pre-write statvfs check with 1 GB reserve, ENOSPC catch-on-write returns 507.
- **Orphan scanner**: background cleanup of stale `.tmp` files older than 5 minutes.

### Versioning, Auth, and Encryption

- **Object versioning**: UUID v4 version IDs, delete markers, list versions, `v/` subdirectory storage layout.
- **Lifecycle rules**: S3-compatible expiration with days-based rules, noncurrent version expiration, prefix+tag filtering, 1-hour background scanner.
- **SSE-C encryption**: customer-provided keys with AES-256-GCM, MD5 validation, copy support with source and destination SSE-C headers.
- **STS temporary credentials**: `ASIA`-prefixed temporary access keys, session tokens, 900-43200s configurable duration, background cleanup task.

### Testing

- **Chaos testing framework**: `neolith-chaos` crate with 22 tests covering heal, HLC, topology, orphan GC, EC, and concurrency scenarios.
- **Performance regression CI**: offline benchmark suite with compare CLI, `bench.yml` GitHub Actions workflow, 15%/20% regression thresholds.

### New Crates

- **neolith-admin**: admin API and CLI (700 LOC, 34 tests)
- **neolith-chaos**: chaos testing framework (22 tests)

---

## v0.1.0 - Let There Be Blobs

**Released: 2026-02-28**

The initial release of Neolith. A complete S3-compatible object storage server in a single binary, with erasure coding, encryption, authentication, clustering, healing, batch APIs, ETL transforms, and a PyTorch SDK.

### Highlights

- **Single-binary server**: TOML config, graceful shutdown, Axum HTTP/2, single port 9000.
- **S3 API core**: PUT, GET, HEAD, DELETE, LIST (v2), multipart upload (6 endpoints), presigned URLs.
- **Erasure coding**: Reed-Solomon with mandatory SIMD (AVX2/NEON), BLAKE3 checksums, streaming 1MB chunk encode.
- **Per-shard metadata**: FlatBuffer v2 on-disk format with `MetaView` zero-copy access for LIST/HEAD hot paths. Bincode v1 backward compatibility with lazy migration.
- **Compression**: LZ4 and zstd with 3-stage smart skip (entropy detection).
- **SSE-S3 encryption**: AES-256-GCM with 64KB AEAD blocks, HKDF per-object DEK, aws-lc-rs.
- **SigV4 authentication**: full signature verification with constant-time comparison. IAM policies with deny-overrides-allow and wildcard matching.
- **Multi-node cluster**: TCH placement with HRW hashing, failure-domain spread, HTTP/2 RPC, heartbeat polling.
- **Healing engine**: on-read + reactive heal, priority queue (criticality > hotness > age), parallel shard I/O via JoinSet, 30-day background scanner, exponential backoff retry.
- **Batch GET API**: TAR+LZ4/zstd format, Fisher-Yates shuffle for ML training, epoch-based streaming with `PrefetchPipeline` and Semaphore memory budget.
- **ETL engine**: native + WASM (Wasmtime, feature-gated) transforms. Three built-in: identity, checksum-blake3, to-json-meta. BLAKE3-keyed LZ4 disk cache with LRU eviction.
- **PyTorch SDK**: `NeolithDataset` (IterableDataset), thread-based prefetch, manual POSIX ustar TAR parsing, LZ4 decompression.
- **Prometheus metrics**: `/metrics` endpoint with request counters, latency histograms, and storage gauges.
- **TLS**: rustls TLS 1.3 only, mTLS support via `WebPkiClientVerifier`, TLS-aware RPC client.
- **Benchmarks**: HdrHistogram latency tracking, Semaphore-based concurrency, iterative binary search for key discovery.
- **S3 completeness**: byte-range GET, copy object, conditional requests (If-Match/None-Match/Modified-Since), virtual-hosted-style addressing, CORS, tagging, request IDs, Content-MD5 validation, Unicode NFC key normalization, streaming LIST.

### New Crates

- **neolith-common**: shared types, errors, config
- **neolith-meta**: per-shard FlatBuffer metadata, listing cache, MetaView
- **neolith-ec**: Reed-Solomon erasure coding with SIMD
- **neolith-compress**: LZ4/zstd compression with smart skip
- **neolith-rio**: I/O engine abstraction
- **neolith-crypto**: AES-256-GCM encryption
- **neolith-s3**: S3 API handlers
- **neolith-iam**: SigV4 auth and IAM policies
- **neolith-batch**: batch GET and epoch-based streaming
- **neolith-etl**: WASM transform engine and cache
- **neolith-cluster**: TCH placement, RPC, heartbeat
- **neolith-heal**: healing engine with priority queue
- **neolith-metrics**: Prometheus metrics
- **neolith-server**: main binary
- **neolith-bench**: benchmark tool

### Stats

- 20 core features across 13 phases
- 809 Rust tests + 27 conformance tests + 22 Python tests
- 18.7 MB release binary, 11.4 MB idle memory, 16ms startup time
