---
sidebar_position: 7
title: "Configuration Management"
---

# Configuration Management

Neolith is configured via a TOML file, environment variables, and a runtime Admin API. This page covers every configuration section, hot-reload behavior, and example configs for common deployment scenarios.

## Config File Format

Neolith reads its configuration from a TOML file specified at startup:

```bash
neolith server start --config /etc/neolith/config.toml
```

If no config file is specified, Neolith starts with built-in defaults (listen on `0.0.0.0:9000`, single-directory storage, 8+4 Reed-Solomon erasure coding, LZ4 compression).

## Configuration Sections

### Top-Level Settings

```toml
# Listen address and port (default: 0.0.0.0:9000)
listen = "0.0.0.0:9000"

# Edition: "oss", "enterprise", or "ai" (default: "oss")
# Can be overridden by NEOLITH_EDITION env var
edition = "oss"

# Graceful shutdown drain timeout in seconds (default: 30)
drain_timeout_seconds = 30
```

### Server

```toml
[server]
max_body_size_bytes = 536870912   # 512 MiB (default; use multipart for larger)
region = "us-east-1"              # SigV4 scope region
inline_threshold_bytes = 131072   # 128 KiB - objects below this are inlined in metadata
max_key_length = 1024             # Max object key length in bytes (S3 spec: 1024)
max_tags_per_object = 10          # Max tags per object (S3 spec: 10)
list_parallelism = 32             # Concurrent metadata reads during LIST
max_clock_skew_seconds = 900      # SigV4 timestamp tolerance (15 min)
```

### Storage

```toml
[storage]
# Multi-drive mode (recommended for production)
drives = ["/mnt/disk1", "/mnt/disk2", "/mnt/disk3", "/mnt/disk4"]
# Single-directory mode (for development)
# data_dir = "/data/neolith"
```

### Erasure Coding

```toml
[erasure]
codec = "reed-solomon"  # "reed-solomon" or "lrc"
data_shards = 8
parity_shards = 4
```

Reed-Solomon is limited to 255 total shards (data + parity). For LRC, standard ratios are (10,4,2,5) and (12,3,3,4).

**Scheme precedence.** The `[erasure]` block sets the cluster-wide default. The *effective* scheme for any given object is resolved with the precedence **storage-class > bucket > pool > global** and stamped on the object at write time, so a per-bucket or per-storage-class override always wins over the global default.

### Durability

```toml
[durability]
fsync = true   # default: true
```

When `fsync = true` (the default), every newly created file (object data, tags, version files) **and its parent directory entry** are flushed to stable storage before the write is acknowledged, and again after the atomic metadata rename. This closes the window where an acknowledged write could be lost to a power failure while still in the OS page cache.

#### What `fsync` does and doesn't protect

`fsync` guards against **power loss and OS/kernel crashes**. It does **not** affect a Neolith process crash (`kill -9`, panic, OOM): those leave the data safely in the OS page cache, and the kernel still flushes it to disk. So disabling `fsync` only widens the failure window for *power/kernel* events, not for process restarts.

The cost is real: a synchronous flush before every ack. On large objects this dominates write latency — e.g. 10 MiB objects at concurrency can run several times slower with `fsync` on than off, because each PUT waits for the data to physically reach the drive instead of acking from cache.

#### When to set `fsync = false`

Disabling `fsync` is a legitimate, deliberate choice when an acknowledged-then-lost write costs you nothing — i.e. the data is **regenerable**:

- **Ephemeral / scratch data** — ML training shuffle buffers, intermediate or derived datasets, checkpoints you'd re-run on failure anyway. If a power cut means restarting the job regardless, durably persisting partial output buys nothing.
- **Development, test, and CI** — throughput matters, durability does not.
- **Cache tiers** — the system of record lives elsewhere; this deployment is a regenerable cache.

```toml
[durability]
fsync = false   # throughput over power-fail durability — regenerable data only
```

:::warning
With `fsync = false`, an acknowledged write can be **lost on power loss or an OS crash**, which breaks the S3 contract that a successful `PUT` is durable. Never use it for primary, system-of-record data. It is safe only when the data can be regenerated. See [Deployment Topologies & Minimums](./deployment-topologies.md) for the single-node/local case.
:::

### Compression

```toml
[compression]
codec = "lz4"              # "lz4", "zstd", or "none"
smart_skip = true           # entropy-based skip for incompressible data
entropy_threshold = 7.5     # bits per byte, 0.0-8.0
zstd_level = 3              # 1-22, levels 1-4 are fast
```

### TLS

```toml
[tls]
cert_file = "/etc/neolith/tls/cert.pem"
key_file = "/etc/neolith/tls/key.pem"
ca_file = "/etc/neolith/tls/ca.pem"               # enables mTLS
client_cert_file = "/etc/neolith/tls/client.pem"   # inter-node mTLS
client_key_file = "/etc/neolith/tls/client-key.pem"
```

Neolith uses rustls with TLS 1.3 only and the aws-lc-rs cryptographic provider.

### Cluster

```toml
[cluster]
advertise = "https://node1.neolith.local:9000"
peers = ["https://node2.neolith.local:9000", "https://node3.neolith.local:9000"]
partitions = 16384             # TCH partition count
heartbeat_interval_secs = 10
rpc_timeout_secs = 30
rpc_idle_timeout_secs = 90
rpc_max_idle_per_host = 64
replication_factor = 3            # copies per object (also the journal/replicated tier RF)
placement_policy = "pack"         # "pack" (default) or "strict" — see below
min_free_disk_bytes = 1073741824  # 1 GB
```

**Placement policy.** `placement_policy` controls how shards/replicas are spread across failure domains (zone/rack/host):

- `pack` (default): place across as many distinct domains as available, packing onto shared domains when there aren't enough. Permissive — suitable for single-node, dev, and small clusters.
- `strict`: refuse any write that cannot spread across distinct failure domains for the configured scheme, returning `507 Insufficient Storage`. A **startup guardrail** additionally rejects the configuration at boot if `strict` + the chosen erasure/replication scheme + cluster size can never be satisfied — so an under-provisioned cluster fails fast instead of silently storing under-protected data.

See [Deployment Topologies & Minimums](./deployment-topologies.md) for the domain/drive minimums each policy implies.

### Logging

```toml
[logging]
level = "info"    # supports per-module: "neolith=debug,tower=warn"
format = "text"   # "text" or "json"
```

### Rate Limiting

```toml
[rate_limit]
global_ops_per_sec = 10000.0
per_credential_ops_per_sec = 1000.0
burst_multiplier = 2.0
idle_timeout_seconds = 600
```

### Notifications

```toml
[notify]
enabled = true
queue_capacity = 10000
max_retries = 5
webhook_timeout_seconds = 10
dlq_enabled = true
# dlq_dir = "/var/log/neolith/dlq"  # default: .neolith/dlq/
```

### Background, Heal, Multipart, Batch, and ETL

These sections control internal subsystems. All fields have sensible defaults.

```toml
[background]
uptime_ticker_secs = 15       # process metrics refresh
sts_cleanup_secs = 300        # expired STS credential reap
lifecycle_scan_secs = 3600    # lifecycle rule evaluation
stats_refresh_secs = 30       # dashboard stats cache

[heal]
max_concurrent = 4            # parallel heal operations
inter_heal_delay_ms = 100     # throttle between heals
max_queue_size = 100000       # bounded queue (20 MB at ~200 bytes/entry)
max_retries = 3               # exponential backoff retries

[multipart]
upload_ttl_secs = 86400       # 24 hours
max_concurrent_uploads = 10000
spill_threshold_bytes = 1048576   # 1 MiB - parts above this spill to disk
cleanup_interval_secs = 300

[batch]
max_batch_size = 1000
prefetch_ahead = 8
memory_budget_bytes = 1073741824  # 1 GiB
epoch_ttl_secs = 3600

[etl]
wasm_max_memory_bytes = 67108864  # 64 MiB per invocation
wasm_fuel_limit = 10000000        # 0 to disable fuel metering
wasm_timeout_secs = 30
cache_max_bytes = 10737418240     # 10 GiB
```

## Admin API

The Admin API provides runtime configuration management.

### Get Current Configuration

```bash
curl "http://localhost:9000/_neolith/admin/v1/config"
```

### Update Configuration

```bash
curl -X PUT "http://localhost:9000/_neolith/admin/v1/config" \
  -H "Content-Type: application/json" \
  -d '{"logging": {"level": "debug"}}'
```

### CLI Commands

```bash
# Get a specific config value
neolith admin config get logging.level

# Set a config value
neolith admin config set logging.level debug

# Export full config to a file
neolith admin config export > config-backup.toml

# Import config from a file
neolith admin config import config-new.toml
```

## Hot-Reload

Neolith supports hot-reloading a subset of configuration settings without restarting the server.

### Trigger Reload

There are two ways to trigger a reload:

1. **SIGHUP signal** (Unix only):

```bash
kill -HUP $(pidof neolith)
```

2. **File watcher**: Neolith watches the config file for changes using the `notify` crate. Edits are detected and reloaded automatically.

### Reloadable Settings

The following settings can be updated without a restart:

| Setting | Section |
|---|---|
| TLS certificate and key | `[tls]` |
| Access credentials | Environment variables |
| Log level and format | `[logging]` |
| Rate limit values | `[rate_limit]` |
| Notification settings | `[notify]` |

### Settings Requiring Restart

These settings require a full server restart to take effect:

| Setting | Reason |
|---|---|
| `listen` address/port | Socket is bound at startup |
| `[storage]` drives/data_dir | Storage layout is fixed |
| `[erasure]` codec/shards | Changing EC params mid-flight would corrupt data |
| `[cluster]` topology | Peer connections are established at startup |
| `[server]` region | SigV4 scope is set at startup |

## Environment Variables

The following environment variables are recognized:

| Variable | Description | Overrides |
|---|---|---|
| `NEOLITH_ACCESS_KEY` | S3 access key ID | CLI `--access-key` |
| `NEOLITH_SECRET_KEY` | S3 secret access key | CLI `--secret-key` |
| `NEOLITH_MASTER_KEY` | SSE-S3 master encryption key (hex) | CLI `--master-key` |
| `NEOLITH_ENDPOINT` | Admin CLI endpoint (default: `http://localhost:9000`) | CLI `--endpoint` |
| `NEOLITH_EDITION` | Edition override: `oss`, `enterprise`, or `ai` | Config `edition` |

Environment variables take precedence over config file values for credentials.

## Example Configurations

### Single-Node Development

Minimal config for local development and testing:

```toml
listen = "127.0.0.1:9000"

[storage]
data_dir = "/tmp/neolith-data"

[erasure]
data_shards = 4
parity_shards = 2

[logging]
level = "debug"
format = "text"
```

### Production Single-Node with TLS

```toml
listen = "0.0.0.0:9000"

[server]
region = "us-west-2"

[storage]
drives = ["/mnt/nvme0", "/mnt/nvme1", "/mnt/nvme2", "/mnt/nvme3"]

[compression]
codec = "zstd"

[tls]
cert_file = "/etc/neolith/tls/server.pem"
key_file = "/etc/neolith/tls/server-key.pem"

[logging]
level = "info"
format = "json"

[heal]
max_concurrent = 8
inter_heal_delay_ms = 50
```

### Multi-Node Cluster

Replace `advertise` and `peers` on each node with the appropriate hostnames.

```toml
listen = "0.0.0.0:9000"

[storage]
drives = ["/mnt/nvme0", "/mnt/nvme1", "/mnt/nvme2", "/mnt/nvme3"]

[cluster]
advertise = "https://node1.neolith.local:9000"
peers = ["https://node2.neolith.local:9000", "https://node3.neolith.local:9000"]
replication_factor = 3

[tls]
cert_file = "/etc/neolith/tls/node.pem"
key_file = "/etc/neolith/tls/node-key.pem"
ca_file = "/etc/neolith/tls/ca.pem"
client_cert_file = "/etc/neolith/tls/client.pem"
client_key_file = "/etc/neolith/tls/client-key.pem"

[logging]
format = "json"
```

## Web Console Configuration Editor

The Neolith web console includes a graphical configuration editor at **Settings > Configuration**. The editor displays the current server configuration with inline documentation for each field. Changes made through the console are applied via the Admin API and follow the same hot-reload rules as file-based changes.

Access the console at `http://localhost:9000/_neolith/console/` and navigate to the Settings page.
