---
sidebar_position: 2
title: Installation
---

# Installation

Neolith is distributed as a single static binary. You can build from source or run it via Docker.

## System Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| CPU | any (scalar fallback works) | AVX2/NEON for erasure coding, AVX-512 for checksumming |
| RAM | 512 MB | 4 GB+ (depends on dataset size) |
| Disk | Any filesystem (ext4, XFS, ZFS) | XFS on NVMe for best performance |
| OS | Linux (x86_64, aarch64), macOS | Linux for io_uring support |
| Linux kernel | 3.2+ (standard I/O engine; Rust tier-1 baseline) | 5.6+ (enables the io_uring engine) |
| Rust | 1.85+ (Edition 2024) | Latest stable |

Neolith's erasure coding uses vector CPU instructions when available, with runtime detection and a portable scalar fallback if none of the below are present:

- **x86_64**: AVX2 (Haswell+, 2013), SSSE3 (Core 2+, 2006)
- **aarch64**: NEON (all ARMv8 processors)

Shard/object checksums (BLAKE3) additionally use AVX-512 where available. For production erasure-coding throughput, an AVX2-or-better x86_64 CPU or any aarch64/NEON CPU is recommended; a CPU without any of these still works, just slower.

## Building from Source

### Prerequisites

Install the Rust toolchain via [rustup](https://rustup.rs/):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup default stable
```

Verify Rust 1.85 or later:

```bash
rustc --version
# rustc 1.85.0 (...)
```

### Clone and Build

```bash
git clone https://github.com/muratkars/neolith.git
cd neolith
cargo build --release
```

The binary is located at `target/release/neolith`. You can copy it to a directory in your `$PATH`:

```bash
sudo cp target/release/neolith /usr/local/bin/
```

### Build with io_uring (Linux Only)

For Linux systems with kernel 5.6+, the `iouring` feature compiles in an `io_uring`-based I/O engine as a runtime-selectable alternative to the standard engine:

```bash
cargo build --release --features iouring
```

This requires the `liburing` headers. On Debian/Ubuntu:

```bash
sudo apt-get install liburing-dev
```

On Fedora/RHEL:

```bash
sudo dnf install liburing-devel
```

Building with `--features iouring` only makes the engine available - it does not enable it. Select it at runtime via `[io] engine` in the config file (`"auto"`, `"standard"`, or `"uring"`; see [I/O Engine configuration](./operations/configuration.md#io-engine)). `"auto"` currently resolves to `"standard"` in practice: the `io_uring` engine is fully implemented and tested, but hasn't yet shown a measured throughput win over the standard engine for the callers wired so far - see the [I/O Engine architecture page](./architecture/io-engine.md#benchmark-status) for current status before opting in explicitly with `engine = "uring"`.

## Docker

Run Neolith with Docker, mounting a host directory for data storage:

```bash
docker run -d \
  --name neolith \
  -p 9000:9000 \
  -v /data/neolith:/data \
  ghcr.io/muratkars/neolith:latest \
  server start /data
```

With authentication and encryption enabled:

```bash
docker run -d \
  --name neolith \
  -p 9000:9000 \
  -v /data/neolith:/data \
  -e NEOLITH_ACCESS_KEY=myaccesskey \
  -e NEOLITH_SECRET_KEY=mysecretkey \
  -e NEOLITH_MASTER_KEY=my-32-byte-hex-master-key \
  ghcr.io/muratkars/neolith:latest \
  server start /data
```

For multi-drive setups, mount each drive separately:

```bash
docker run -d \
  --name neolith \
  -p 9000:9000 \
  -v /mnt/disk1:/mnt/disk1 \
  -v /mnt/disk2:/mnt/disk2 \
  -v /mnt/disk3:/mnt/disk3 \
  -v /mnt/disk4:/mnt/disk4 \
  ghcr.io/muratkars/neolith:latest \
  server start /mnt/disk1 /mnt/disk2 /mnt/disk3 /mnt/disk4
```

## Verifying the Installation

Check that Neolith is installed and the binary works:

```bash
neolith --version
# neolith 0.4.0
```

Verify SIMD support is detected:

```bash
neolith server start /tmp/neolith-test
# [INFO] SIMD: AVX2 detected
# [INFO] Listening on http://0.0.0.0:9000
```

If your CPU lacks SIMD support, you will see an error:

```
Error: No supported SIMD instruction set detected. Neolith requires AVX2, SSSE3, or NEON.
```

## TLS Configuration

Neolith uses rustls (TLS 1.3 only, no OpenSSL dependency). To enable TLS:

```bash
neolith server start /data \
  --tls-cert /path/to/cert.pem \
  --tls-key /path/to/key.pem
```

For mutual TLS (mTLS) between cluster nodes:

```bash
neolith server start /data \
  --tls-cert /path/to/cert.pem \
  --tls-key /path/to/key.pem \
  --tls-ca /path/to/ca.pem
```

## What's Next?

Proceed to the [Quickstart](/docs/quickstart) guide to create your first bucket and start storing objects.
