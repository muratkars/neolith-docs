---
sidebar_position: 2
title: "Server Commands"
---

# Server Commands

The `neolith server` subcommand group manages the storage server lifecycle. Currently, the primary subcommand is `start`.

## `neolith server start`

Start the Neolith storage server. This initializes data directories, sets up the S3 API router with optional authentication and encryption, configures cluster membership if peers are specified, and begins serving HTTP requests.

### Synopsis

```
neolith server start [OPTIONS] <PATHS>...
```

### Arguments

#### `<PATHS>...` (required)

One or more data directories or drive paths where Neolith stores object data and metadata. Each path receives erasure-coded shards distributed across the available drives.

**Brace expansion** is supported for specifying multiple drives concisely:

```bash
# Expands to /mnt/disk1 /mnt/disk2 ... /mnt/disk16
neolith server start /mnt/disk{1...16}

# With suffix path
neolith server start /node{1...3}/data

# Mixed paths
neolith server start /mnt/nvme{1...4} /mnt/ssd{1...8}
```

The brace syntax uses three dots (`...`) between the start and end numbers (inclusive). This is distinct from standard shell brace expansion and is handled by the Neolith binary itself, so it works in any shell without special quoting.

At least one path is required. For single-directory development mode, a single path is sufficient:

```bash
neolith server start /tmp/neolith-data
```

### Options

#### `--config <FILE>` / `-c <FILE>`

Path to a TOML configuration file. When provided, the server loads all settings from this file before applying CLI overrides. See [Configuration Reference](./configuration) for the complete TOML schema.

```bash
neolith server start --config /etc/neolith/config.toml /mnt/disk{1...4}
```

If omitted, the server uses default settings: listen on `0.0.0.0:9000`, Reed-Solomon 8+4 erasure coding, LZ4 compression with smart skip, no TLS, no cluster.

#### `--listen <ADDR>`

Listen address in `host:port` format. Overrides the `listen` field in the configuration file.

```bash
neolith server start --listen 127.0.0.1:9001 /data
```

Default: `0.0.0.0:9000`

#### `--access-key <KEY>`

Root access key ID for SigV4 authentication. Must be provided together with `--secret-key` to enable authentication. When authentication is enabled, all S3 API requests require valid SigV4 signatures.

Can also be set via the `NEOLITH_ACCESS_KEY` environment variable.

```bash
neolith server start \
  --access-key AKIAIOSFODNN7EXAMPLE \
  --secret-key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY \
  /data
```

When neither `--access-key` nor `--secret-key` is provided, the server runs in open mode with no authentication (a warning is logged).

#### `--secret-key <KEY>`

Root secret access key for SigV4 authentication. Must be provided together with `--access-key`.

Can also be set via the `NEOLITH_SECRET_KEY` environment variable.

#### `--master-key <KEY>`

Base64-encoded 256-bit master key for server-side encryption (SSE-S3). When set, objects stored with the `x-amz-server-side-encryption: AES256` header are encrypted using AES-256-GCM with per-object data encryption keys derived via HKDF from this master key.

Can also be set via the `NEOLITH_MASTER_KEY` environment variable.

```bash
# Generate a random 256-bit key
MASTER_KEY=$(openssl rand -base64 32)

neolith server start \
  --access-key mykey \
  --secret-key mysecret \
  --master-key "$MASTER_KEY" \
  /data
```

### Startup Sequence

When `neolith server start` is invoked, the following steps execute in order:

1. **Tracing initialization**: Configures structured logging via `tracing-subscriber`, reading the log level from `RUST_LOG` (default: `info`).

2. **Configuration loading**: If `--config` is specified, loads and validates the TOML file. CLI flags override config file values.

3. **Drive path expansion**: Brace patterns in `<PATHS>` are expanded. The first drive is used as the primary data directory.

4. **Edition resolution**: The edition is determined from the config file's `edition` field, overridden by `NEOLITH_EDITION` if set. Possible values: `oss` (default), `enterprise`, `ai`.

5. **Application state construction**: Creates the `AppState` with the MetaStore, optional security (IAM credentials + policy engine), optional master key for encryption.

6. **Cluster initialization** (if configured): Builds cluster topology with TCH placement, starts the heartbeat polling loop for peer health monitoring.

7. **Batch API initialization**: Creates the `BatchState` for batch GET operations and epoch management.

8. **ETL engine initialization**: Creates the ETL state with transform registry and disk-backed transform cache.

9. **Notification system** (if configured): Spawns the webhook delivery worker with configurable retry and timeout.

10. **Listing cache restoration**: Attempts to load the persisted listing cache from `.neolith/listing-cache.bin`. Falls back to a full disk scan if the snapshot is missing or corrupted.

11. **Router assembly**: Merges S3 API routes, admin routes, operational endpoints (`/metrics`, `/health`), RPC routes (if clustered), and the web console (if the `console` feature is enabled).

12. **Background tasks**: Starts periodic background tasks:
    - Uptime ticker (15s interval)
    - Epoch cleanup for batch API
    - ETL cache eviction
    - Multipart upload cleanup (5min interval, 24h TTL)
    - STS credential cleanup (5min interval)
    - Lifecycle scanner (1h interval)
    - Config hot-reload (SIGHUP handler + file watcher)

13. **Bind and serve**: Binds the TCP listener and starts serving. If TLS is configured, uses `rustls` with a reloadable TLS acceptor.

### Graceful Shutdown

The server handles `SIGTERM` and `SIGINT` (Ctrl+C) for graceful shutdown:

1. **Stop accepting new connections**: The TCP listener is closed.
2. **Begin draining**: New requests receive HTTP 503 `SlowDown` responses via the drain middleware.
3. **Wait for in-flight requests**: The server waits up to `drain_timeout_seconds` (default: 30s) for active requests to complete.
4. **Persist listing cache**: Saves the listing cache snapshot to `.neolith/listing-cache.bin` for fast restart.
5. **Cancel background tasks**: Notification workers and other background tasks receive cancellation signals.
6. **Exit**: The process exits with code 0.

```bash
# The server logs drain progress
INFO in_flight=12 timeout_secs=30 "draining connections"
INFO "all connections drained"
INFO count=4523 "listing cache snapshot saved"
INFO "shutting down"
```

If the drain timeout expires with connections still active, a warning is logged and the server exits anyway:

```
WARN remaining=3 "drain timeout - force closing"
```

### Config Hot-Reload

The running server supports hot-reloading certain configuration values without restart:

- **SIGHUP signal**: Send `kill -HUP <pid>` to trigger a config reload from the file specified by `--config`.
- **File watcher**: If `--config` is specified, the server watches the file for changes and automatically reloads.

Hot-reloadable settings include TLS certificates, logging levels, and rate limit parameters. Changes to listen address, drive paths, or cluster topology require a full restart.

### Examples

**Development mode** - single directory, no auth, no encryption:

```bash
neolith server start /tmp/neolith-dev
```

**Single node production** - 4 NVMe drives, auth, encryption:

```bash
neolith server start \
  --config /etc/neolith/config.toml \
  --access-key "$ACCESS_KEY" \
  --secret-key "$SECRET_KEY" \
  --master-key "$MASTER_KEY" \
  /mnt/nvme{1...4}
```

**Multi-node cluster** - 16 drives per node, config-driven:

```bash
neolith server start \
  --config /etc/neolith/node1.toml \
  /mnt/disk{1...16}
```

**Custom listen address** with environment variables:

```bash
export NEOLITH_ACCESS_KEY=mykey
export NEOLITH_SECRET_KEY=mysecret
neolith server start --listen 0.0.0.0:8080 /data
```
