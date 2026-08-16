---
sidebar_position: 1
title: "neo Client Overview"
sidebar_label: "Overview"
---

# neo: the native Neolith client

[`neo`](https://github.com/muratkars/neo) is Neolith's first-class command-line client. It is a single static Rust binary that speaks SigV4 over the standard S3 API (so it works against any S3-compatible endpoint) and adds first-class commands for Neolith's differentiated surface: batch GET, bucket forks, ETL transforms, and ML-aware dataset inspection.

`neo` is distributed under Apache 2.0. There is no Python runtime and no per-cluster install: one binary runs anywhere.

## Why a native client?

Any S3 client will talk to Neolith, but the generic clients leave Neolith's value-add on the floor:

- `aws s3` is the lowest common denominator: slow Python startup, awkward batch UX, and no awareness of anything beyond bare S3 verbs.
- `mc` is excellent for bare S3, but it is built around another vendor's worldview and exposes none of Neolith's extensions.

`neo` answers the question "what should I install to actually use Neolith?" It stays backwards compatible with any S3 endpoint, while surfacing the Neolith-only features as top-level commands instead of hand-rolled `curl` invocations.

## Command surface

`neo` splits into an S3-parity surface and a set of Neolith-only commands.

| Command | Purpose |
|---|---|
| `neo alias` | Manage named endpoint aliases (URL + credentials) |
| `neo cp` | Copy files or objects, streaming with auto-multipart |
| `neo ls` | List buckets or objects under a prefix |
| `neo mb` / `neo rb` | Make or remove a bucket |
| `neo rm` | Remove an object or a set of objects |
| `neo stat` | Show metadata for a bucket or object (HEAD) |
| `neo sync` | Sync a local directory tree to or from a bucket |
| `neo presign` | Generate a presigned URL for an object |
| `neo completions` | Print a shell completion script |
| `neo batch` | **Neolith-only**: batch-fetch objects as one TAR+LZ4 stream |
| `neo fork` | **Neolith-only**: create, list, diff, and merge bucket forks |
| `neo etl` | **Neolith-only**: register and run WASM/native ETL transforms |
| `neo dataset` | **Neolith-only**: inspect ML datasets (parquet, safetensors, jsonl, csv) |

The S3-parity commands are documented in [S3 commands](s3-commands.md); the Neolith-only commands in [Neolith commands](neolith-commands.md). Endpoint and profile setup lives in [Configuration](configuration.md).

## Global flags

Every subcommand accepts these flags:

| Flag | Description |
|---|---|
| `-c`, `--config <PATH>` | Path to the config file (default: `~/.config/neo/config.toml`) |
| `-p`, `--profile <NAME>` | Profile (alias) to use; also read from `NEO_PROFILE` |
| `-v`, `--verbose` | Verbose output; repeat for more (`-vv` = debug, `-vvv` = trace) |
| `--json` | Machine-readable JSON output where applicable |

## Install

### Homebrew (macOS and Linux)

```bash
brew tap muratkars/neo
brew install neo
```

Shell completions are installed automatically.

### Pre-built binaries

Download from the [latest release](https://github.com/muratkars/neo/releases/latest) and place the binary on your `PATH`. Static musl builds are provided for Linux (x86_64 and aarch64), and native builds for macOS (Apple Silicon and Intel):

```bash
# Example: Linux x86_64 (static musl)
curl -L https://github.com/muratkars/neo/releases/latest/download/neo-x86_64-unknown-linux-musl.tar.gz | tar xz
sudo mv neo /usr/local/bin/
```

Verify checksums against the `sha256sums.txt` attached to each release.

### From source

```bash
cargo install --git https://github.com/muratkars/neo
```

Building from source requires Rust 1.85 or newer.

## Design principles

1. **Backwards compatible.** Any S3-compatible endpoint works.
2. **One static binary.** No Python, no per-OS quirks.
3. **Machine-readable output.** Every command supports `--json`.
4. **Streaming by default.** Multipart with configurable concurrency, no whole-object buffering.
5. **First-class Neolith.** Batch GET, forks, ETL, and ML metadata are top-level commands.
