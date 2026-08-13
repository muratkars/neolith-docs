---
sidebar_position: 9
title: I/O Engine
---

# I/O Engine

Neolith abstracts disk I/O for the journal storage scheme behind a pluggable engine choice: a portable standard engine (`tokio::fs`) and, on Linux, an `io_uring`-based reactor. The engine is a runtime config choice (`[io].engine`), not a compile-time-only decision - only the availability of the `io_uring` code path is compile-time-gated (the `iouring` Cargo feature, Linux-only).

This page describes the reactor as it exists today, after a full rewrite (feature #218) from an earlier, unwired prototype. If you read an older version of this page or of third-party notes about Neolith's `io_uring` support, treat the architecture and performance claims below as authoritative going forward.

## Where this applies

The engine choice is consulted only where a caller has actually been wired to route through it:

- **EC shard flush** (`UringShardWriter`/`UringShardReader`) - writing a stripe's shards during flush, and the narrow-path GET read that serves a small object directly from its covering shard(s) without a full stripe decode.
- **Journal group-commit segment writes** (`WriteBackend::Uring`) - the append + `fdatasync` path for the active WAL segment, for both the local writer and (in a cluster) the replica mirror.

Everything else - the replicated storage scheme, metadata I/O, listing, and any read path not listed above (full degraded stripe decode, compaction, scrub) - always uses the standard engine regardless of `[io].engine`. This is a deliberate, incremental rollout: each caller is wired and benchmarked on its own before the next one is considered.

## Configuration

```toml
[io]
engine = "auto"      # "auto" | "standard" | "uring"
queue_depth = 128     # per-ring submission queue depth
rings_per_drive = 2   # independent io_uring rings per drive
```

- **`engine`** - `"standard"` always uses `tokio::fs`. `"uring"` requires `io_uring` to be available (Linux, kernel 5.6+, built with the `iouring` feature) and **fails to start** if it isn't - a misconfiguration is caught at startup, not silently downgraded. `"auto"` (the default) currently resolves to the standard engine unconditionally, with a logged reason: a ratified post-benchmark decision (see [Benchmark status](#benchmark-status)), not a probe result. When a benchmarked `io_uring` win lands, `auto` becomes probe-and-prefer without a config change on your side.
- **`queue_depth`** - submission queue depth per ring; only meaningful when the resolved engine is `io_uring`. Must be at least 2: an acknowledged durable write is one kernel-linked write+fsync chain, and both entries must fit a single submission batch (startup validation rejects lower values).
- **`rings_per_drive`** - how many independent rings (each its own ring thread) serve each drive. See [Why multiple rings](#why-multiple-rings-ringpool) below for why this exists and how `2` was chosen.

**Current default behavior: `auto` resolves to `standard`.** This isn't a bug - see [Benchmark status](#benchmark-status) below. The `io_uring` path is fully implemented and tested, but hasn't yet demonstrated a throughput win over the standard engine for the write-path callers wired so far, on the hardware tested. Set `engine = "uring"` explicitly to opt in ahead of a default flip.

## Reactor architecture

Each `io_uring` ring runs on a dedicated OS thread, reachable from async callers via an mpsc channel:

```
Tokio async task                    Ring thread
      |                                    |
  [submit op]        --mpsc-->    [drain channel]
      |                                    |
  [await oneshot]                 [build SQEs into an in-flight table]
      |                                    |
      |                           [submit_and_wait(1)]
      |                                    |
      |                           [reap every ready CQE]
      |                                    |
  [receive result]   <--oneshot-- [reply to each completed op]
```

This is a real batched-submit/reap pipeline, not a one-op-at-a-time relay: multiple in-flight operations get submitted together and their completions reaped together, so the ring genuinely benefits from queue depth greater than 1. Blocking filesystem work that has no `io_uring` opcode (open, mkdir, stat, rename) runs on Tokio's ordinary blocking-thread pool via `spawn_blocking`, resolved before an op ever reaches the ring thread - the ring thread itself never blocks on VFS work.

A ring is not thread-safe to share directly, so each one still gets its own dedicated OS thread and its own mpsc channel as the single synchronization point - the same reasoning as earlier designs. What changed is that a *pool* of rings (see below) now exists instead of exactly one ring for the whole process, and each ring in the pool does real batched submission instead of a single-op relay.

### Handle-based file seam

I/O against an already-open file goes through a handle type (`UringFile`) with offset-based operations - `write_at`, `write_at_sync` (a linked write→`fdatasync` chain, one round trip through the ring for both), `read_at`, `datasync` - rather than a path-per-operation API. This matters for the journal: a segment file, or a shard file mid-flush, stays open across multiple operations, and a handle-based API lets those operations share one open file instead of reopening it each time.

### Registered files

Long-lived file handles (the journal's active segment, reopened across many group-commit batches) register into the ring's fixed-file table (`IORING_REGISTER_FILES`/`_UPDATE`) on open. This removes a `dup(2)` and the kernel's per-op `fdget`/`fdput` for every subsequent operation against that handle - a real per-op cost saving, but only for callers that issue many operations against the same open file. Short-lived, one-shot handles (the EC shard-flush write path, and the GET narrow-path read - each opens a file for exactly one operation before dropping it) deliberately do **not** register: the register/unregister round trip would cost more than the syscalls it saves for a handle with nothing to amortize it against.

Registered *buffers* (`IORING_REGISTER_BUFFERS`, writing directly into kernel-pinned memory to skip a copy) are not yet implemented. Every read today, `io_uring` or not, still allocates a fresh buffer per operation. This is a real, understood gap, deferred until there's a measured case that justifies the extra complexity (a fixed, address-stable buffer pool is a materially different data structure than the general-purpose reusable buffer pool this codebase has elsewhere).

## Why multiple rings (`RingPool`)

A single ring, however well the batched-submit/reap loop is implemented, has a hard per-thread dispatch-loop throughput ceiling - one ring thread can only drive so many submit/reap cycles per second, independent of queue depth. On the hardware this was benchmarked on (2x NVMe drives), a single ring plateaued around 8-8.5k ops/s while the drives themselves could sustain roughly 19-23k ops/s - a ceiling well below physical capacity, confirmed by testing queue depths up to 2048 with no change (ruling out queue depth as the cause).

Splitting load across multiple independent rings per drive removes this ceiling. `RingPool` is a drive-indexed pool of rings with round-robin selection within a drive: `rings_per_drive` rings are created per configured drive, and each write/read op resolves to one of that drive's rings by the same index the caller already uses for drive placement (so no extra lookup is needed). Measured on the same hardware: `rings_per_drive = 2` reached 95% of the standard engine's raw throughput (single ring reached only 70%), with `rings_per_drive = 4` only marginally better - which is why `2` is the default.

The EC shard-flush writer and the GET narrow-path reader each hold their own `RingPool`; the journal's segment writer holds a separate, deliberately single-ring pool (its active segment is always exactly one file, so more rings there would just be idle threads, not usable concurrency). These pools are intentionally independent rather than shared, trading a small number of extra OS threads for simpler lifetime management between callers with different lifespans (per-flush vs. per-server-lifetime).

## Benchmark status

The reactor mechanism itself is proven: an isolated benchmark that talks directly to the reactor (no HTTP/S3/EC/journal layers in the way) shows `io_uring` beating the standard engine once enough operations are genuinely concurrent, and confirms `RingPool` removes the single-ring ceiling described above.

That win has **not yet shown up** for the real callers wired so far, end-to-end through the actual server:

- **EC shard flush** (4 MiB objects, default 8+4 erasure scheme): no measurable difference from the standard engine (within ~0.3%, noise-level).
- **Journal group-commit** (4 KiB objects): no measurable difference (also within ~0.3%).

The reason is architectural, not a bug: the journal's group-commit path issues exactly one operation at a time from its single commit thread, so the reactor's batched-submission design is never actually exercised by that caller - there's nothing to batch. The EC shard-flush path's fan-out (writing a stripe's shards concurrently) does present genuine concurrency, but at the tested scheme's shard count and drive count, it falls short of the per-drive concurrency the isolated benchmark needed before a difference appeared.

**Practical implication:** `auto` stays defaulted to `standard` until a wired caller demonstrates a real win, not just a working mechanism. This is deliberate, re-confirmed discipline, not an oversight - the config surface and the reactor exist and are fully tested so that the moment a caller with the right concurrency shape gets wired (or hardware changes what "enough concurrency" means), the switch is a config change, not a rewrite.

## Kernel feature roadmap

The reactor detects kernel capabilities at startup and enables features in tiers. Later tiers are where recent kernels pay off:

| Capability | Kernel | Status |
|-----------|--------|--------|
| Batched submission, linked write+fsync | 5.6+ | Shipped (the reactor rewrite this page describes) |
| Registered files | 6.1+ | Shipped - long-lived handles (the journal segment writer) register on open, removing a `dup(2)` and per-op `fdget`/`fdput` |
| Registered buffers | 6.1+ | Not yet implemented (see [Registered files](#registered-files) above) |
| Untorn writes (`RWF_ATOMIC`, XFS) | 6.13+ | Roadmap - torn-write-immune journal records without double-writing |
| Polled and hybrid-polled I/O | 6.13+ | Roadmap - lower small-operation latency on NVMe polling queues |
| Zero-copy network receive | 6.15+ | Roadmap - cut a copy from the PUT/batch-GET network path |
| NVMe passthrough + Flexible Data Placement | spike | Roadmap - separate journal, stripe, and tombstone write streams to reduce SSD write amplification |

## Kernel requirements

`io_uring` itself needs Linux 5.6+ as an absolute floor; the registered-files mechanism above needs a somewhat newer kernel for reliable, non-degraded behavior. Neolith probes kernel capabilities at startup and exposes the detected tier via the server's info endpoint, so an operator can check what a given host actually supports before opting in. For NVMe-backed deployments, a 6.17+ kernel with XFS is the recommended baseline in product deployment guidance.

If `io_uring` initialization fails for any reason (old kernel, missing capability, seccomp policy blocking the required syscalls), `engine = "uring"` fails startup, so an explicit request for `io_uring` that can't be honored is never silently downgraded. (`engine = "auto"` never reaches that probe today: it resolves to the standard engine by policy, per [Configuration](#configuration).)

## Runtime failure semantics

The reactor's durability posture is fail loudly, never hang, never lie:

- A short write (positive completion smaller than the buffer, e.g. `ENOSPC` mid-write or a quota limit) fails the whole write+fsync chain; the caller gets an error and the batch is never acked as durable.
- Signal interruptions (`EINTR`) during submission are retried immediately and never counted as failures, so profilers and timers cannot destabilize the engine.
- Persistent submission failures back off briefly and, after a bounded run (roughly 2.7 seconds worst case), the reactor fails every queued operation loudly and shuts down for the remainder of the process lifetime. From that point every journal submission through it errors immediately, and the `/health` endpoint reports HTTP 503 so orchestrators restart the process instead of routing traffic to it. Restart is the remedy; the engine is never rebuilt in-process.
