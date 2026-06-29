---
sidebar_position: 100
title: "Changelog"
sidebar_label: "Changelog"
---

# Changelog

All notable changes to Neolith are documented here. Each release includes highlights - not an exhaustive list. See the [GitHub releases](https://github.com/muratkars/neolith/releases) for full commit history.

---

## v0.6.0 - Limits and Beyond

**Released: 2026-04-25** | **Enterprise update: 2026-04-29**

A hardening release focused on correctness and operability, plus the first Enterprise RDMA transport. Every hardcoded limit in the codebase was audited, 11 were promoted to TOML-configurable values with startup validation, and a new introspection endpoint lets operators inspect all effective limits at runtime. The web console gains multipart upload support for files of any size.

### Highlights

- **Config-driven limits**: 11 previously hardcoded constants are now configurable via TOML. `server.max_body_size_bytes` (raised from 128 MiB to 512 MiB default), `server.max_key_length`, `server.max_tags_per_object`, `server.list_parallelism`, `server.max_clock_skew_seconds`, plus multipart TTL, concurrent uploads, and spill threshold - all tunable per deployment.
- **Limits introspection**: `GET /_neolith/admin/v1/limits` returns 22 effective limits across 7 categories (s3, auth, storage, compression, heal, batch, etl) with source, human-readable value, and reloadable flag.
- **Config validation hardening**: `Config::validate()` now enforces range checks on all configurable limits and cross-field consistency (e.g. spill threshold must not exceed body size). Invalid configs are rejected at startup with descriptive errors.
- **Console multipart upload**: Files >= 64 MiB automatically use S3 multipart upload (CreateMultipartUpload, UploadPart with 4-way concurrency, CompleteMultipartUpload). No more HTTP 413 on large files.
- **Console bug fixes**: 5 bugs fixed in the web console - useState misuse in event notification editor, stale metrics ring buffers on logout, error rate miscounting 3xx as errors, SSE header reading wrong header for SSE-S3, and no-op string replacements in event formatter.
- **Property-based testing**: Added `proptest` and `test-case` for boundary testing. Key length validation, clock skew boundaries, multipart saturation, entropy invariants, and config fuzz testing - all exercised without needing a cluster.
- **Entropy threshold deduplication**: `should_compress()` now accepts a configurable threshold parameter, eliminating a redundant constant that shadowed the TOML config value.
- **Builder consolidation**: `with_server_limits()` and `with_multipart_config()` apply all config-derived limits to `AppState` in a single call, reducing wiring boilerplate.

### Durability & Placement — Architecture Hardening (Phase 28, in progress)

The first milestone of the multi-exabyte architecture-hardening track makes the durability story explicit and configurable. These are foundational, user-facing controls; the replicated journal and erasure-coded data path that build on them are on the roadmap below.

- **Write-ahead durability policy** (`[durability] fsync`, default `true`): every newly created file (object data, tags, version files) **and its parent directory entry** are `fsync`'d before a write is acknowledged, and again after the metadata rename. Closes the acked-write-loss-on-power-failure gap on the single-node and per-replica path. Set `fsync = false` only for throughput-oriented dev/test where durability is not required.
- **Failure-domain placement policy** (`[cluster] placement_policy`, `"pack"` default or `"strict"`): under `strict`, writes that cannot spread across distinct failure domains (zone/rack/host) are refused with `507 Insufficient Storage` rather than silently under-protected. A **startup guardrail** fails fast when `strict` + the configured erasure/replication scheme + cluster size are unsatisfiable, so misconfigurations are caught at boot, not at first data loss.
- **Per-scope erasure scheme resolution**: the effective erasure scheme is now resolved with a defined precedence — **storage-class > bucket > pool > global** — and stamped per object at write time.
- **`replication_factor` wired end-to-end**: the configured `[cluster] replication_factor` is now applied to cluster placement (previously partially unwired).
- **`tolerate` target** (`[placement] tolerate`): declare the failure-domain level shards must spread across to survive losing one domain: `auto` (default), `drive` / `drive:N`, `node`, and (Enterprise) `rack` / `zone`. `auto` picks the coarsest level with at least `parity + 1` distinct instances and never selects rack/zone on OSS.
- **Failure-domain labels** (`[[cluster.nodes]]`): each node can declare its `zone`, `rack`, and `drives`, so placement spreads across racks, zones, and distinct drives. Supersedes `peers` when present.
- **Budgeted spread and balanced fill**: each domain is capped at `ceil(total_shards / domains)` and never more than the parity budget; leftovers fill the least-loaded domain, so 12 shards over 3 racks land 4 / 4 / 4. Selection stays HRW-deterministic, so minimal reshuffle is preserved.
- **Distinct-drive guarantee** (`(node, drive)` placement): placement now resolves each shard to a `(node, drive)` target. When more than one shard of an object lands on a node, each takes a distinct drive, so a single node with `N` drives holds a `k + m <= N` erasure stripe on `k + m` distinct drives and tolerates any `m` drive losses, and a small three-node cluster balances shards over `(node, drive)` pairs. The drive is chosen deterministically (a read resolves the same `(node, drive)` the write chose, over the pinned epoch snapshot), the first shard on a node stays on drive 0 (backward compatible, no migration), and a drive shared by two shards is recorded as drive-under-protected. Whole-object replication is unchanged (one copy per node).
- **Reads correct across topology changes**: partitions are stamped with the cluster epoch and reads resolve over a pinned per-epoch topology snapshot, so adding or removing a node no longer mislocates existing data. Unstamped partitions fall back to recompute-over-live.
- **Protection report**: `GET /_neolith/admin/v1/placement/protection` reports under-protected partitions, the achieved tolerance level, and re-spread candidates. A partition is under-protected when one domain holds more shards than the parity budget OR two shards share one physical drive (`max_per_drive > 1`); each sample now carries `max_per_drive` alongside `max_per_domain` and `domains`.
- **Re-spread migration**: `rebalance start` now migrates under-protected partitions onto their improved placement after you add domains. Loss-free by construction (copy-up to the new placement at quorum, then advance the partition epoch, with no copy deleted), resumable, and a no-op when there is nothing to fix. `rebalance status` reports progress. A throttled background pass (`[placement] respread_interval_secs`, default 300, `0` disables) runs the same migration automatically in cluster mode, with an inter-object throttle so it never starves foreground traffic.
- **Re-spread reclamation** (`[placement] respread_delete_old`, default off): an opt-in delete-old sweep reclaims surplus copies left on nodes no longer in a partition's placement after a re-spread. A copy is deleted only when every node in its new placement confirms a copy at least as new, so the durable copy count never drops below the replication factor; otherwise the copy is kept and retried.
- **Cross-node journal replication** (`storage.scheme = "journal"`, opt-in and experimental): in a cluster, each group-commit batch is now replicated to the segment's peers and acknowledged only once it is durable on a write quorum (`replication_factor / 2 + 1` copies, counting the local one). A peer that is down or slow is tolerated up to the quorum margin; below quorum the write is refused rather than acked. Single-node deployments are unaffected.
- **Multipart uploads as erasure-coded segments** (`storage.scheme = "journal"`, opt-in and experimental): when the journal scheme is on, each multipart part is erasure-coded into its own stripe as it arrives (durable before complete, so an in-flight upload survives a restart), and `CompleteMultipartUpload` stitches the chosen part stripes into one multi-stripe object with no whole-object reassembly buffer. Reads return the parts concatenated; abort and TTL expiry free the staged stripes; re-uploading a part replaces it (last write wins). The default replicated path is unchanged.
- **Stripe compaction** (`journal.compaction_min_live_ratio`, default 0.5; opt-in journal scheme): the journal's stripe-reclamation sweep frees an EC stripe only once every object in it is dead, so an overwrite/delete-heavy workload left mostly-dead stripes pinning their full shard footprint. A background pass now re-packs a sparse stripe (live bytes below `compaction_min_live_ratio * stripe_len`) into a fresh dense stripe, after which the old stripe is fully dead and reclaimed. Set the ratio to `0.0` to disable. The maintenance pass runs flush, then compact, then reclaim.
- **New documentation**: see [Placement and Durability](./architecture/placement.md) for the failure-domain model, the `tolerate` target, and re-spread, and [Deployment Topologies & Minimums](./operations/deployment-topologies.md) for drive/node minimums per topology and what each topology survives.

### Enterprise: S3 over RDMA / RoCEv2 (Phase E)

- **neolith-rdma crate**: New `neolith-rdma` enterprise crate implementing the full RDMA/RoCEv2 transport layer. `RdmaManager` provides `pull_from_client` (PUT — RDMA READ) and `push_to_client` (GET — RDMA WRITE) with transparent TCP fallback.
- **Dual-transport architecture**: HTTP/S3 control plane always available; RDMA data plane activated per-request via `x-neolith-rdma-*` headers. Standard AWS SDKs continue to work unchanged on the TCP path.
- **Per-cell configuration**: Enable RDMA per cell via environment variables (`NEOLITH_RDMA_ENABLED=true`) or Kubernetes CRD (`spec.network.rdmaEnabled: true`). Cells without RDMA enabled are unaffected.
- **Automatic TCP fallback**: `NEOLITH_RDMA_FALLBACK_TCP=true` (default) — any RDMA setup failure silently falls back to the HTTP body path. Set to `false` only in validated environments.
- **ibverbs integration**: Full QP lifecycle support (INIT→RTR→RTS) via `IbverbsTransport` on Linux + `rdma` feature. `MockRdmaTransport` on all other platforms for development and testing.
- **MR pool**: Pre-registered memory region pool (default 512 MiB). Set `NEOLITH_RDMA_MR_POOL_MB=0` to use On-Demand Paging (ODP) on ConnectX-4 Lx or newer.
- **Admin API**: `GET /_neolith/admin/v1/rdma/status`, `GET /_neolith/admin/v1/rdma/devices`, `POST /_neolith/rdma/connect`, `POST /_neolith/rdma/disconnect/{id}`.
- **Prometheus metrics**: 11 new RDMA metrics covering bytes transferred, operation counts, fallback reasons, QP state, MR pool utilization, and CQ overflows.
- **Minimum object threshold**: Objects below `NEOLITH_RDMA_MIN_OBJ_KB` (default 256 KiB) always use TCP — RDMA setup overhead is not worth it for small objects.

### Breaking Changes

- `server.max_body_size_bytes` default changed from 128 MiB to 512 MiB. If you relied on the old 128 MiB limit to restrict upload sizes, set `max_body_size_bytes = 134217728` in your config.
- `neolith_compress::should_compress()` now takes a third parameter (`entropy_threshold: f64`). Use `neolith_compress::DEFAULT_ENTROPY_THRESHOLD` to preserve the old behavior.
- `neolith_s3::build_router()` now reads `state.max_body_size_bytes` instead of using a hardcoded constant. No change needed if you use the standard server startup path.

### New Crates

- **neolith-rdma**: RDMA/RoCEv2 transport layer with `RdmaManager`, `IbverbsTransport`, `MockRdmaTransport`, and Prometheus metrics (Enterprise)

### Stats

- 120/120 OSS features complete
- 57/60 Enterprise features complete (RDMA-1 through RDMA-3 shipped; RDMA-4, RDMA-5 in progress)
- 1,025+ tests, zero clippy warnings

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
