---
sidebar_position: 9
title: I/O Engine
---

# I/O Engine

Neolith abstracts disk I/O behind an `IoEngine` interface with two implementations: a portable `StandardEngine` and a Linux-specific `IoUringEngine`. The engine is selected automatically at startup based on platform and kernel capabilities.

## IoEngineKind

The engine dispatch uses an enum rather than a trait object. This avoids dynamic dispatch overhead on the hot path:

```rust
pub enum IoEngineKind {
    Standard(StandardEngine),
    IoUring(IoUringEngine),
}
```

The engine is selected once at startup by `create_engine()`. In the current release the durability-critical write paths (journal segment appends, erasure-coded shard flush, metadata store) intentionally use direct synchronous I/O with explicit fsync rather than routing through the engine: correctness first, on any platform. Routing those hot paths through the io_uring engine is the subject of the modernization roadmap below.

Note: The `IoEngine` trait uses Return Position Impl Trait in Traits (RPITIT) rather than `async_trait` or `dyn` dispatch. This means the trait is not object-safe, which is why `IoEngineKind` is an enum.

## StandardEngine

The `StandardEngine` uses standard `tokio::fs` operations for all I/O. It works on all platforms (Linux, macOS, Windows).

### macOS Optimizations

On macOS, the standard engine uses `F_NOCACHE` file control hints to bypass the OS page cache for large sequential reads and writes. This prevents large object I/O from evicting useful cached data:

```rust
#[cfg(target_os = "macos")]
fn set_nocache(file: &std::fs::File) {
    use std::os::unix::io::AsRawFd;
    unsafe { libc::fcntl(file.as_raw_fd(), libc::F_NOCACHE, 1) };
}
```

### Write Path

```
1. Create temp file (.tmp suffix)
2. Write data to temp file
3. fsync the file
4. Rename temp file to final path (atomic)
```

The atomic rename ensures crash consistency: a power failure at any point leaves either the old file or the new file, never a partial write.

### Read Path

```
1. Open file
2. Read into pre-allocated buffer
3. Return buffer
```

For multi-shard reads, the engine issues parallel `tokio::fs::read` calls using `JoinSet`, allowing the tokio runtime to schedule I/O across threads.

## IoUringEngine

The `IoUringEngine` uses Linux's `io_uring` interface for asynchronous I/O. It is feature-gated behind the `iouring` Cargo feature and only compiles on Linux.

### Architecture

The io_uring engine uses a dedicated OS thread with an mpsc channel for communication:

```
Tokio async task                    Dedicated OS thread
      |                                    |
  [submit IoRequest]  --mpsc-->   [receive IoRequest]
      |                                    |
  [await oneshot]                 [submit SQE to io_uring ring]
      |                                    |
      |                           [wait for CQE completion]
      |                                    |
  [receive result]   <--oneshot-- [send result back]
```

This design keeps io_uring operations on a single dedicated thread, which avoids the complexity of sharing an io_uring ring across multiple threads. The mpsc channel is the only synchronization point.

### Why a Dedicated Thread?

io_uring rings are not thread-safe by default. While it is possible to use `IORING_SETUP_SQPOLL` for kernel-side polling or share rings with `IORING_SETUP_ATTACH_WQ`, the dedicated thread approach is simpler and provides predictable performance:

- No contention on the submission queue
- No need for `io_uring_register` to share rings
- Clean shutdown via channel close
- Easy to profile and debug (single thread for all I/O)

### SQE/CQE Operations

The engine uses `io_uring::opcode::Read` and `io_uring::opcode::Write` for data I/O:

```rust
// Submit a read operation
let sqe = opcode::Read::new(
    types::Fd(fd),
    buf.as_mut_ptr(),
    buf.len() as u32,
)
.offset(offset)
.build()
.user_data(request_id);

// Submit to the ring
unsafe { ring.submission().push(&sqe) }?;
ring.submit()?;

// Wait for completion
let cqe = ring.completion().next().unwrap();
let bytes_read = cqe.result();
```

### Communication Protocol

Each I/O request is a `UringOp` variant carrying the target path, any data, and a reply channel:

```rust
enum UringOp {
    Write { path: PathBuf, data: Vec<u8>, reply: oneshot::Sender<NeolithResult<()>> },
    Read { path: PathBuf, reply: oneshot::Sender<NeolithResult<Vec<u8>>> },
    Delete { path: PathBuf, reply: oneshot::Sender<NeolithResult<()>> },
    // ... exists, size, atomic write, shutdown
}
```

The `oneshot::Sender` allows the async caller to `await` the result without blocking the tokio runtime. Operations are path-based: each write opens the file, writes, and closes it as one unit. Handle-based operations (offset appends to an already-open segment file) are part of the roadmap below.

## Feature Gate and Auto-Detection

### Cargo Feature

The io_uring engine is behind a feature gate:

```toml
[features]
iouring = ["io-uring"]
```

Building without the feature excludes all io_uring code:

```bash
# Standard build (no io_uring)
cargo build --release

# Build with io_uring support
cargo build --release --features iouring
```

### Platform Guard

The io_uring code is wrapped in `cfg` attributes:

```rust
#[cfg(all(target_os = "linux", feature = "iouring"))]
mod uring;
```

This prevents compilation errors on macOS and Windows, even if the feature is accidentally enabled.

### Auto-Detection

At startup, `create_engine()` selects the best available engine:

```rust
pub fn create_engine() -> IoEngineKind {
    #[cfg(all(target_os = "linux", feature = "iouring"))]
    {
        match IoUringEngine::new() {
            Ok(engine) => {
                tracing::info!("I/O engine: io_uring");
                return IoEngineKind::IoUring(engine);
            }
            Err(e) => {
                tracing::warn!("io_uring unavailable: {e}, falling back to standard I/O");
            }
        }
    }

    tracing::info!("I/O engine: standard");
    IoEngineKind::Standard(StandardEngine::new())
}
```

If io_uring initialization fails (old kernel, missing capabilities, seccomp blocking), the engine falls back silently to standard I/O.

## Buffer Pools

Both engines use pre-allocated buffer pools to reduce allocation pressure on the hot path:

- **Read buffers**: Pre-allocated to the expected shard size (object_size / K, rounded up)
- **Write buffers**: Reused across sequential shard writes
- **Pool sizing**: Configured based on the expected concurrency (default: 2x the number of drives)

Buffer pools are implemented as a simple `Vec<Vec<u8>>` behind a `Mutex`, with fallback to fresh allocation if the pool is empty. Returned buffers are `clear()`ed and pushed back to the pool.

## Status and Modernization Roadmap

### Current status

The shipped io_uring engine is a deliberately conservative first implementation:

- Operations are processed one at a time: each submission waits for its completion before the next begins, so the effective queue depth is 1 regardless of ring size.
- Operations are path-based (open, transfer, close per call); there is no handle reuse and no fsync operation in the engine itself.
- Registered (fixed) buffers and files are not yet used.
- The durability-critical write paths do not route through it yet (see above).

This makes the engine correct and easy to reason about, but it does not yet express the parallelism of modern NVMe devices. Treat io_uring in the current release as an opt-in preview, not a performance feature.

### Planned: completion reactor

The next iteration of the engine (in design, gated on NVMe validation hardware) turns the dedicated thread into a true completion reactor:

- **Real queue depth**: many operations in flight per ring, submissions batched, completions reaped as they arrive.
- **Linked operations**: an acknowledged durable write becomes a single kernel-enforced chain (write then fdatasync), halving round trips on the fsync path.
- **Registered files and buffers**: pre-registered 1 MB chunk buffers matching the streaming erasure-coding pipeline, removing per-operation setup costs.
- **Handle-based segment I/O**: offset appends and datasync against already-open journal segment files, which is what the group-commit write path actually needs.
- **Hot-path wiring**: journal shard flush and group commit route through the engine behind an `[io]` config knob, defaulting to the standard path until benchmarks validate the switch.

### Kernel feature roadmap

The reactor detects kernel capabilities at startup and enables features in tiers. Later tiers are where recent kernels pay off:

| Capability | Kernel | What it gives Neolith |
|-----------|--------|------------------------|
| Batched submission, linked write+fsync | 5.6+ | Queue depth and fewer syscalls on the durable-write path |
| Registered files and buffers | 6.1+ | Zero per-op registration cost for chunked shard I/O |
| Untorn writes (`RWF_ATOMIC`, XFS) | 6.13+ | Torn-write-immune journal records without double-writing |
| Polled and hybrid-polled I/O | 6.13+ | Lower small-operation latency on NVMe polling queues |
| Zero-copy network receive | 6.15+ | Future: cut a copy from the PUT/batch-GET network path |
| NVMe passthrough + Flexible Data Placement | spike | Future: separate journal, stripe, and tombstone write streams to reduce SSD write amplification |

### Deployment recommendation

For NVMe deployments, run a kernel of 6.17 or newer with XFS so all current-tier features are available; the engine degrades gracefully on older kernels (the floor remains 5.6, below which it falls back to the standard engine). On macOS, the StandardEngine with `F_NOCACHE` provides competitive performance for sequential workloads.

## Dependencies

| Crate | Version | Purpose |
|-------|---------|---------|
| `io-uring` | 0.7 | Linux io_uring bindings |
| `tokio` | 1.x | Async runtime, mpsc channels, oneshot |

The `io-uring` crate is the only external dependency for the io_uring engine. It provides safe Rust bindings over the Linux io_uring syscalls.
