---
sidebar_position: 1
title: "Neolith vs. Open-Source Object Stores"
---

# Neolith vs. Open-Source Object Stores

Several mature open-source object stores serve the same S3-compatible role
Neolith targets. This page compares Neolith against the two most common
architecture families among them: single-binary Go-based stores with
per-object erasure coding, and CRUSH-style distributed storage systems with
placement-function reads.

## At a Glance

| Dimension | Typical Go-based store | CRUSH-style distributed store | Neolith |
|---|---|---|---|
| **Language** | Go | C++ | Rust |
| **License** | AGPL v3 / Commercial | LGPL | Apache 2.0 (OSS) / Commercial |
| **S3 Coverage** | ~95% of S3 API | Via a gateway layer | Core S3 + AI-native extensions |
| **Binary** | Single binary | Multiple daemons | Single binary |
| **Erasure Coding** | Reed-Solomon (Go asm kernels) | Reed-Solomon plugins | Reed-Solomon + LRC (mandatory SIMD) |
| **Metadata** | Per-object sidecar (MessagePack) | Dedicated metadata daemons | FlatBuffers (zero-copy MetaView) |
| **Reads** | Sidecar-authoritative | Placement-function recompute | Manifest-authoritative descriptors |
| **AI/ML Native** | Third-party integrations | Third-party integrations | Batch GET, ETL-on-GET, PyTorch SDK |
| **Failure domain** | Drive | Configurable (CRUSH map) | Node by default, drive/rack/zone via `tolerate` |

## Performance

**Rust vs. Go.** Go garbage collection brings non-deterministic tail latency
to the I/O path; under memory pressure pauses can reach milliseconds. Neolith
is Rust with zero GC: memory is managed deterministically, which matters for
ML training pipelines where one slow batch stalls a GPU cluster.

**Erasure coding.** Neolith's SIMD erasure coding has no scalar fallback: the
binary requires SIMD at compile time, eliminating runtime dispatch. LRC
(Local Reconstruction Codes) cuts repair I/O by roughly 75% versus plain
Reed-Solomon via local parity groups.

**Metadata.** Stores that keep a serialized per-object sidecar must fully
deserialize it on every HEAD or LIST. Neolith's FlatBuffers metadata with the
`MetaView` zero-copy fast path reads fields directly from the mapped buffer:
10-100x faster for metadata-heavy workloads such as large listings.

## Licensing

The most common open-source alternative is AGPL v3: modifying it and offering
it as a network service requires releasing your modifications, which
effectively rules out embedding it in proprietary SaaS without a commercial
license. Neolith's open-source edition is Apache 2.0: embed it, offer it as a
managed service, and bundle it without source-disclosure obligations.
Enterprise features (multi-tenancy, SSE-KMS, audit, object lock, replication)
are a separate commercial edition in both worlds; the difference is what the
free tier permits.

## Architecture

**Placement-function reads vs. manifest-authoritative reads.** CRUSH-style
systems recompute an object's location from the cluster map on every read.
That recompute drifts from reality the moment healing moves a shard, which is
why such systems need peering and backfill machinery. Neolith reads are
manifest-authoritative: the descriptor written at commit time is the single
source of truth, healing rewrites it idempotently, and no peering protocol
exists to go wrong.

**Failure domains.** In drive-domain stores, one node's drives can hold most
of an object's shards, so a node loss can exceed the parity budget. Neolith
places shards node-first (`tolerate = "node"` by default) and lets you widen
the domain (`rack`, `zone`) as the cluster grows.

## When to Choose Which

Choose an established store when you need its decade of production hardening
today and its license fits your distribution model. Choose Neolith when tail
latency, AI-native data-path features (batch GET, ETL-on-GET, epoch-aware
prefetch), permissive licensing, or erasure-coded efficiency with LRC repair
economics drive the decision.
