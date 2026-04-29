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

### Enterprise: S3 over RDMA / RoCEv2 (Phase E)

- **neolith-rdma crate**: New enterprise crate implementing the RDMA/RoCEv2 transport layer. `RdmaManager` provides `pull_from_client` (PUT — RDMA READ) and `push_to_client` (GET — RDMA WRITE) with transparent TCP fallback.
- **Dual-transport architecture**: HTTP/S3 control plane always available; RDMA data plane activated per-request via `x-neolith-rdma-*` headers. Standard AWS SDKs continue to work unchanged.
- **Per-cell configuration**: Enable via `NEOLITH_RDMA_ENABLED=true` or Kubernetes CRD `spec.network.rdmaEnabled: true`.
- **ibverbs integration**: Full QP lifecycle (INIT→RTR→RTS) via `IbverbsTransport` on Linux + `rdma` feature. `MockRdmaTransport` for development on all other platforms.
- **Admin API**: `GET /_neolith/admin/v1/rdma/status`, `GET /rdma/devices`, `POST /_neolith/rdma/connect`, `POST /_neolith/rdma/disconnect/{id}`.
- **Prometheus metrics**: 11 new RDMA metrics covering bytes, ops, fallback reasons, QP state, MR pool, CQ overflows.

### Breaking Changes

- `server.max_body_size_bytes` default changed from 128 MiB to 512 MiB.
- `neolith_compress::should_compress()` now takes a third parameter (`entropy_threshold: f64`).
- `neolith_s3::build_router()` now reads `state.max_body_size_bytes` instead of a hardcoded constant.

### New Crates

- **neolith-rdma**: RDMA/RoCEv2 transport layer (Enterprise)

### Stats

- 120/120 OSS features complete
- 57/60 Enterprise features complete
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
- **Config Admin API**: `GET/PUT /_neolith/admin/v1/config` for runtime configuration management.
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

- **Web Console v1**: React 18 + TypeScript + Tailwind v4, embedded as a single-page app via `rust-embed`.
- **Console backend**: JWT HS256 authentication, embedded SPA serving, API proxy to S3 endpoints.
- **Bucket policy**: JSON-based bucket policies with `PUT/GET/DELETE /?policy`.
- **POST Object**: browser form upload support.
- **Static website hosting**: per-bucket `.website.json` configuration.
- **Config hot-reload**: SIGHUP signal handler and `notify` file watcher for live config updates.

### New Crates

- **neolith-console**: embedded SPA backend with JWT auth (17 tests)

### Stats

- 68/68 features (at time of release), 809 Rust tests
- Zero clippy warnings

---

## v0.2.1 - The Need for Speed

**Released: 2026-03-03**

A performance-focused release delivering 13 optimizations identified during architectural review.

---

## v0.2.0 - The Blob Strikes Back

**Released: 2026-03-02**

Scaling beyond single-node with LRC erasure coding and pool-based online expansion.

---

## v0.1.0 - Let There Be Blobs

**Released: 2026-02-28**

The initial release of Neolith — a complete S3-compatible object storage server in a single binary with erasure coding, encryption, authentication, clustering, healing, batch APIs, ETL transforms, and a PyTorch SDK.
