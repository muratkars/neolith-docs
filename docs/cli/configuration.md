---
sidebar_position: 5
title: "Configuration Reference"
---

# Configuration Reference

Neolith uses TOML for its configuration file. Pass the config file to the server with `--config`:

```bash
neolith server start --config /etc/neolith/config.toml /mnt/disk{1...16}
```

All configuration sections have sensible defaults. An empty config file is valid and equivalent to running without `--config`.

## Complete Configuration Example

```toml
# Listen address (host:port)
listen = "0.0.0.0:9000"

# Edition: "oss", "enterprise", or "ai"
# Can be overridden by NEOLITH_EDITION env var
edition = "oss"

# Graceful shutdown drain timeout in seconds
drain_timeout_seconds = 30

# ─── Server Limits ──────────────────────────────────────────────
[server]
max_body_size_bytes = 536870912   # 512 MiB (use multipart for larger)
region = "us-east-1"              # SigV4 scope region
inline_threshold_bytes = 131072   # 128 KiB (objects below: inlined in metadata)
max_key_length = 1024             # Max object key length (S3 spec: 1024)
max_tags_per_object = 10          # Max tags per object (S3 spec: 10)
list_parallelism = 32             # Concurrent metadata reads during LIST
max_clock_skew_seconds = 900      # SigV4 timestamp tolerance (15 min)

# ─── Storage ─────────────────────────────────────────────────────
[storage]
# Data directories / drive paths
# Usually set via CLI args, but can also be specified here
drives = ["/mnt/disk1", "/mnt/disk2", "/mnt/disk3", "/mnt/disk4"]

# ─── Erasure Coding ─────────────────────────────────────────────
[erasure]
# Codec: "reed-solomon" or "lrc" (Locally Repairable Code)
codec = "reed-solomon"

# Number of data shards
data_shards = 8

# Number of parity shards
parity_shards = 4

# ─── Compression ────────────────────────────────────────────────
[compression]
# Codec: "lz4", "zstd", or "none"
codec = "lz4"

# Enable smart skip (skip compression for incompressible data)
smart_skip = true

# Entropy threshold for smart skip (bits per byte, 0.0-8.0)
# Data with entropy above this value is already near-random and
# will not benefit from compression. Default 7.5 catches most
# pre-compressed, encrypted, or binary media files.
entropy_threshold = 7.5

# ─── TLS ────────────────────────────────────────────────────────
[tls]
# PEM certificate file
cert_file = "/etc/neolith/tls/cert.pem"

# PEM private key file
key_file = "/etc/neolith/tls/key.pem"

# CA certificate for mutual TLS client verification
# When set, clients must present a certificate signed by this CA
ca_file = "/etc/neolith/tls/ca.pem"

# Client certificate for inter-node mTLS
client_cert_file = "/etc/neolith/tls/client-cert.pem"

# Client private key for inter-node mTLS
client_key_file = "/etc/neolith/tls/client-key.pem"

# ─── Cluster ────────────────────────────────────────────────────
[cluster]
# This node's advertised endpoint (how peers reach this node)
advertise = "https://node1.neolith.local:9000"

# Peer node endpoints
peers = [
    "https://node2.neolith.local:9000",
    "https://node3.neolith.local:9000",
    "https://node4.neolith.local:9000",
]

# Number of TCH partitions (default: 16384)
# Higher values improve balance at the cost of more metadata.
# Changing this requires a full cluster rebuild.
partitions = 16384

# ─── Logging ────────────────────────────────────────────────────
[logging]
# Log level filter. Supports per-crate filtering:
#   "info" - global info level
#   "debug" - global debug level
#   "neolith=debug,tower=warn" - debug for neolith, warn for tower
level = "info"

# Output format: "text" (human-readable) or "json" (structured)
format = "text"

# ─── Rate Limiting ──────────────────────────────────────────────
[rate_limit]
# Global operations per second across all clients
global_ops_per_sec = 10000.0

# Per-credential operations per second
per_credential_ops_per_sec = 1000.0

# Burst capacity = rate * multiplier
burst_multiplier = 2.0

# Remove idle rate-limit buckets after this many seconds
idle_timeout_seconds = 600

# ─── Notifications ──────────────────────────────────────────────
[notify]
# Enable bucket event notifications (default: true)
enabled = true

# Event queue capacity (default: 10000)
queue_capacity = 10000

# Maximum webhook delivery retries (default: 5)
max_retries = 5

# Webhook request timeout in seconds (default: 10)
webhook_timeout_seconds = 10

# ─── Heal Throttle ──────────────────────────────────────────────
[heal_throttle]
# Enable heal I/O throttling (default: true)
# Prevents healing from overwhelming foreground I/O
enabled = true

# Maximum heal I/O budget in bytes per second (default: 50 MB/s)
io_budget_bytes_per_sec = 52428800

# Maximum concurrent heals per drive (default: 2)
max_concurrent_per_drive = 2

# ─── Quarantine ─────────────────────────────────────────────────
[quarantine]
# Enable quarantine for corrupted data (default: true)
# Corrupted objects are moved to .neolith/quarantine/ for forensic
# analysis rather than being deleted
enabled = true

# Maximum age of quarantined files in days before cleanup
max_age_days = 7

# Maximum total quarantine size in GB
max_size_gb = 1

# ─── Deep Scan ──────────────────────────────────────────────────
[deep_scan]
# Delay between scanning individual objects in milliseconds
# Higher values reduce I/O impact but slow the scan cycle
inter_object_delay_ms = 50

# Maximum concurrent EC decode verifications
# Each verification reads all shards and performs a full EC decode
max_concurrent_verifies = 2

# ─── Drive Health ───────────────────────────────────────────────
[drive_health]
# Enable drive health monitoring (default: true)
enabled = true

# Health check interval in seconds (default: 300 = 5 minutes)
check_interval_seconds = 300

# ─── Latency Tracking ──────────────────────────────────────────
[latency_tracking]
# Enable per-drive latency tracking (default: true)
enabled = true

# Number of latency samples to keep per drive
window_size = 1000

# Multiplier for slow drive detection
# A drive is marked "slow" when its latency exceeds the cluster
# median times this multiplier
slow_multiplier = 3.0
```

## Section Reference

### Top-Level Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `listen` | `SocketAddr` | `0.0.0.0:9000` | Bind address for the HTTP server |
| `edition` | `String` | `oss` | Server edition. Overridden by `NEOLITH_EDITION` env var |
| `drain_timeout_seconds` | `u64` | `30` | Seconds to wait for in-flight requests during graceful shutdown |
| `internal_token` | `String` | (none) | Internal trust token for proxy-to-cell communication (Enterprise) |

### `[storage]`

| Field | Type | Default | Description |
|---|---|---|---|
| `drives` | `Vec<PathBuf>` | `[]` | Data directories. Usually set via CLI `<PATHS>` arguments |
| `data_dir` | `PathBuf` | (none) | Root data directory for single-dir mode |

### `[erasure]`

| Field | Type | Default | Description |
|---|---|---|---|
| `codec` | `String` | `reed-solomon` | EC codec: `reed-solomon` or `lrc` |
| `data_shards` | `u16` | `8` | Number of data shards. Must be >= 1 |
| `parity_shards` | `u16` | `4` | Number of parity shards. Must be >= 1 |

For Reed-Solomon, the total `data_shards + parity_shards` must not exceed 255.

Common EC ratios:

| Ratio | Efficiency | Fault Tolerance | Use Case |
|---|---|---|---|
| `4:2` | 67% | 2 failures | Small deployments (6+ drives) |
| `8:4` | 67% | 4 failures | Standard production (12+ drives) |
| `12:3` | 80% | 3 failures | High-capacity archive (15+ drives) |
| `16:4` | 80% | 4 failures | Large clusters (20+ drives) |

For LRC (Locally Repairable Codes), standard ratios are available:

| Config | Global | Local Groups | Local Repair I/O |
|---|---|---|---|
| `10:4:2` (group_size=5) | 10 data + 4 parity | 2 groups of 5 | Read 5 shards (vs 10 for RS) |
| `12:3:3` (group_size=4) | 12 data + 3 parity | 3 groups of 4 | Read 4 shards (vs 12 for RS) |

### `[server]`

| Field | Type | Default | Description |
|---|---|---|---|
| `max_body_size_bytes` | `usize` | `536870912` (512 MiB) | Max single-PUT body size. Range: 1 MiB - 5 GiB |
| `region` | `String` | `us-east-1` | S3 region for `GetBucketLocation` and SigV4 scope |
| `inline_threshold_bytes` | `u64` | `131072` (128 KiB) | Objects at/below this size are inlined in metadata |
| `max_key_length` | `usize` | `1024` | Max object key length in bytes. Range: 1 - 2048 |
| `max_tags_per_object` | `usize` | `10` | Max tags per object. Range: 1 - 50 |
| `list_parallelism` | `usize` | `32` | Concurrent metadata reads during LIST. Range: 1 - 256 |
| `max_clock_skew_seconds` | `i64` | `900` (15 min) | SigV4 timestamp tolerance. Range: 60 - 3600 |

For a detailed breakdown of all limits and their boundary behaviors, see the [Limits Reference](../operations/limits).

### `[compression]`

| Field | Type | Default | Description |
|---|---|---|---|
| `codec` | `String` | `lz4` | Compression codec: `lz4`, `zstd`, or `none` |
| `smart_skip` | `bool` | `true` | Skip compression for high-entropy data |
| `entropy_threshold` | `f64` | `7.5` | Bits per byte threshold (0.0-8.0) |

Smart skip measures the Shannon entropy of incoming data. Data at or above the threshold (e.g., JPEG images, encrypted data, compressed archives) is stored without compression, saving CPU cycles with no size benefit.

### `[tls]`

| Field | Type | Required | Description |
|---|---|---|---|
| `cert_file` | `PathBuf` | Yes | Path to PEM certificate file |
| `key_file` | `PathBuf` | Yes | Path to PEM private key file |
| `ca_file` | `PathBuf` | No | CA cert for mTLS client verification |
| `client_cert_file` | `PathBuf` | No | Client cert for inter-node mTLS |
| `client_key_file` | `PathBuf` | No | Client key for inter-node mTLS |

Neolith uses rustls with TLS 1.3 only and the aws-lc-rs cryptography provider. Certificates can be reloaded without restart via SIGHUP or file watcher.

### `[cluster]`

| Field | Type | Default | Description |
|---|---|---|---|
| `advertise` | `String` | (required) | This node's reachable endpoint URL |
| `peers` | `Vec<String>` | (required) | List of peer endpoint URLs |
| `partitions` | `u16` | `16384` | Number of TCH hash partitions |

The `advertise` address must be reachable by all peers. It is used as the node identifier in the cluster topology. The `peers` list should include all other nodes in the cluster (not self).

### `[logging]`

| Field | Type | Default | Description |
|---|---|---|---|
| `level` | `String` | `info` | Log level filter (supports per-crate syntax) |
| `format` | `String` | `text` | Output format: `text` or `json` |

The `level` field uses `tracing-subscriber`'s `EnvFilter` syntax. It can also be overridden at runtime via the `RUST_LOG` environment variable (which takes precedence over the config file).

### `[rate_limit]`

| Field | Type | Default | Description |
|---|---|---|---|
| `global_ops_per_sec` | `f64` | `10000.0` | Cluster-wide rate limit |
| `per_credential_ops_per_sec` | `f64` | `1000.0` | Per-access-key rate limit |
| `burst_multiplier` | `f64` | `2.0` | Burst capacity multiplier |
| `idle_timeout_seconds` | `u64` | `600` | Cleanup idle rate-limit buckets |

### `[notify]`

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `bool` | `true` | Enable bucket event notifications |
| `queue_capacity` | `usize` | `10000` | Maximum pending events in the queue |
| `max_retries` | `u32` | `5` | Webhook delivery retry limit |
| `webhook_timeout_seconds` | `u64` | `10` | HTTP timeout for webhook POST |

### `[heal_throttle]`

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `bool` | `true` | Enable heal I/O throttling |
| `io_budget_bytes_per_sec` | `u64` | `52428800` (50 MB/s) | Max heal I/O bandwidth |
| `max_concurrent_per_drive` | `usize` | `2` | Max concurrent heals per drive |

### `[quarantine]`

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `bool` | `true` | Enable quarantine for corrupted data |
| `max_age_days` | `u64` | `7` | Days before quarantined files are cleaned up |
| `max_size_gb` | `u64` | `1` | Maximum total quarantine directory size |

### `[deep_scan]`

| Field | Type | Default | Description |
|---|---|---|---|
| `inter_object_delay_ms` | `u64` | `50` | Throttle between objects during scan |
| `max_concurrent_verifies` | `usize` | `2` | Parallel EC decode verifications |

### `[drive_health]`

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `bool` | `true` | Enable drive health monitoring |
| `check_interval_seconds` | `u64` | `300` | Check interval in seconds |

### `[latency_tracking]`

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `bool` | `true` | Enable latency tracking |
| `window_size` | `usize` | `1000` | Samples per drive |
| `slow_multiplier` | `f64` | `3.0` | Threshold for slow drive detection |

## Minimal Configurations

### Single Node Development

No config file needed:

```bash
neolith server start /tmp/neolith-data
```

### Single Node Production

```toml
listen = "0.0.0.0:9000"

[erasure]
data_shards = 4
parity_shards = 2

[compression]
codec = "lz4"
smart_skip = true
```

### Multi-Node Cluster

```toml
listen = "0.0.0.0:9000"

[cluster]
advertise = "https://node1.example.com:9000"
peers = [
    "https://node2.example.com:9000",
    "https://node3.example.com:9000",
    "https://node4.example.com:9000",
]

[tls]
cert_file = "/etc/neolith/tls/server.pem"
key_file = "/etc/neolith/tls/server-key.pem"
ca_file = "/etc/neolith/tls/ca.pem"
client_cert_file = "/etc/neolith/tls/client.pem"
client_key_file = "/etc/neolith/tls/client-key.pem"

[erasure]
data_shards = 8
parity_shards = 4

[logging]
level = "info"
format = "json"
```

## Validation

The configuration is validated at load time. The following constraints are enforced:

- `entropy_threshold` must be in the range `[0.0, 8.0]`
- `data_shards` must be >= 1
- `parity_shards` must be >= 1
- For Reed-Solomon, `data_shards + parity_shards` must not exceed 255
- `listen` must be a valid `host:port` socket address
- If TLS is configured, both `cert_file` and `key_file` must be specified

Validation errors produce clear messages with the specific field and constraint that failed.
