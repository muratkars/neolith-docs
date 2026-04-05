---
sidebar_position: 1
title: "CLI Overview"
---

# CLI Overview

Neolith ships as a single static binary called `neolith` that combines the storage server, cluster management, and administrative operations into one tool. The CLI is built with [clap 4](https://docs.rs/clap/latest/clap/) using the derive-based API and supports environment variable overrides for all sensitive or deployment-specific options.

## Installation

Download the prebuilt binary for your platform, or build from source:

```bash
# Build from source (requires Rust 1.85+)
cargo build --release -p neolith-server
cp target/release/neolith /usr/local/bin/
```

On Linux, the binary uses jemalloc as the global allocator for improved memory performance under heavy allocation workloads.

## Command Structure

The CLI is organized into three top-level subcommands:

```
neolith
  server      Start or manage the Neolith server
  cluster     Cluster info and topology commands
  admin       Admin operations (heal, rebalance, decommission, pools)
  version     Print version and build info
```

### `neolith server`

Controls the storage server lifecycle. The primary subcommand is `start`, which initializes the data directories, sets up the S3 API router, configures optional TLS and cluster membership, and begins serving requests.

```bash
# Single directory, no auth (dev/test)
neolith server start /data

# Multi-drive with erasure coding
neolith server start /mnt/disk{1...16}

# Production with config file and auth
neolith server start --config /etc/neolith/config.toml \
  --access-key myaccesskey \
  --secret-key mysecretkey \
  /mnt/disk{1...16}
```

### `neolith cluster`

Read-only commands for inspecting cluster state. These connect to a running Neolith server via its Admin API.

```bash
neolith cluster info --endpoint http://node1:9000
neolith cluster status --endpoint http://node1:9000 --output json
```

### `neolith admin`

Administrative operations that mutate cluster state: healing, rebalancing, decommissioning nodes, and managing storage pools.

```bash
neolith admin heal status --endpoint http://node1:9000
neolith admin rebalance start --concurrency 4 --throttle-mbps 100
neolith admin pool list
```

### `neolith version`

Prints the binary version, Rust edition, resolved edition (OSS/Enterprise/AI), and enabled compile-time features:

```bash
$ neolith version
neolith 0.4.0 (oss edition)
rust edition: 2024
```

If optional features are compiled in, they are listed:

```
feature: wasm-etl
feature: io-uring
```

## Environment Variables

All sensitive CLI arguments support environment variable overrides. When both a CLI flag and its corresponding environment variable are set, the CLI flag takes precedence.

| Variable | CLI Flag | Description |
|---|---|---|
| `NEOLITH_ACCESS_KEY` | `--access-key` | Root access key ID for SigV4 authentication |
| `NEOLITH_SECRET_KEY` | `--secret-key` | Root secret access key for SigV4 authentication |
| `NEOLITH_MASTER_KEY` | `--master-key` | Base64-encoded 256-bit master key for SSE-S3 encryption |
| `NEOLITH_EDITION` | N/A (config `edition`) | Override edition: `oss`, `enterprise`, or `ai` |
| `NEOLITH_ENDPOINT` | `--endpoint` | Default server URL for cluster/admin commands (default: `http://localhost:9000`) |
| `RUST_LOG` | N/A | Log level filter (e.g., `info`, `debug`, `neolith=debug,tower=warn`) |

## Output Formats

Cluster and admin commands support two output formats via the `--output` flag:

- **`text`** (default): Human-readable key-value pairs and tables, suitable for interactive use.
- **`json`**: Machine-readable JSON output, suitable for scripting and automation.

```bash
# Human-readable output
neolith cluster info --endpoint http://node1:9000

# JSON for scripting
neolith cluster info --endpoint http://node1:9000 --output json | jq '.features'
```

## Exit Codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | General error (invalid arguments, connection failure, etc.) |
| 2 | Configuration error (invalid TOML, validation failure) |

## Feature-Gated Functionality

Some CLI capabilities are only available when the binary is compiled with specific Cargo features:

| Feature | Effect |
|---|---|
| `etl-wasm` | Enables WASM transform runtime (Wasmtime) |
| `iouring` | Enables io_uring I/O engine on Linux |
| `console` | Enables the web console at `/_neolith/console/` |

These features affect binary size and dependencies. The default build includes all features for production deployments.
