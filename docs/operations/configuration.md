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
# scheme = "journal"   # write-path scheme; see the default rules below
```

**Write-path scheme default.** `storage.scheme` selects between the journal
write path (`"journal"`: group-commit journal for small objects, direct
erasure-coded stripes for large ones) and the historical whole-object
replication path (`"replicated"`). When left unset, the default is resolved
from the deployment:

- **Single node, no server-side encryption**: `journal` (the default since
  the durability and performance gate closed).
- **Multi-node cluster** (any `[cluster]` peers or nodes declared):
  `replicated`, until journal cluster mode's storage overhead is removed.
  Journal remains an explicit opt-in for clusters.
- **Server-side encryption enabled**: `replicated`, because the journal
  scheme does not yet support multipart uploads with SSE and S3 SDKs switch
  to multipart automatically for large uploads. Existing journal data keeps
  the journal scheme; only the silent default is affected.

**Downgrade guard.** Booting with `scheme = "replicated"` while journal data
exists on disk is refused: journal-written objects are readable only while
the journal is enabled, so the downgrade would serve them as missing. The
same guard recognizes the growth case (a single node whose unset scheme
defaulted to journal, later joined to a cluster) and names the options: set
`scheme = "journal"` explicitly to keep the data while clustering, or remove
the `[cluster]` section to stay single-node.

A global `[erasure] codec = "lrc"` is rejected at startup under the journal
scheme rather than silently degrading to plain Reed-Solomon (per-bucket LRC
overrides are skipped with fallthrough, as described under Erasure Scheme
Overrides).

### Metadata / Listing Index

```toml
[meta]
# Entries buffered in RAM per index shard before the buffer is sealed to
# disk (the 60s background tick seals smaller buffers)
index_flush_threshold = 64000
```

The listing index answers `ListObjects`/`ListObjectsV2` and powers batch GET key selection. It lives on disk as partition-sharded sorted runs (`.neolith/index/<bucket>/shard-XX/`), aligned with the cluster's placement partitions so a rebalance move touches one shard per bucket. Resident memory is fence pointers, bloom filters, and small per-shard write buffers, not the full key set - measured 26.6x-34.7x lower RSS than the in-RAM cache this replaced, growing with bucket size. Recovery is per-shard and incremental: only shards with unflushed writes at crash time are re-derived from object metadata. Listings are served from the stored index rows without per-key metadata reads.

The first start derives each bucket's index from object metadata (existing buckets are pre-warmed in the background at startup; new buckets derive on first access). The index pins the cluster partition count it was built with and refuses to start over a mismatched tree (delete `.neolith/index/` to force a re-derive). `index_flush_threshold` cannot be hot-reloaded.

### Erasure Coding

```toml
[erasure]
codec = "reed-solomon"  # "reed-solomon" or "lrc"
data_shards = 8
parity_shards = 4
```

Reed-Solomon is limited to 255 total shards (data + parity). For LRC, standard ratios are (10,4,2,5) and (12,3,3,4).

**Scheme precedence.** The `[erasure]` block sets the cluster-wide default. The *effective* scheme for any given object is resolved with the precedence **storage-class > bucket > pool > global** and stamped on the object at write time, so a per-bucket or per-storage-class override always wins over the global default.

### Erasure Scheme Overrides

Storage-class and bucket-level overrides are managed at runtime through the admin API, not the TOML config file - they're operational, not deployment-time, settings. Each override independently sets an EC scheme (`ec`), a max EC stripe size (`max_stripe_bytes`), or both:

```
GET    /_neolith/admin/v1/ec-overrides                          # list every configured override
GET    /_neolith/admin/v1/buckets/{bucket}/ec-override
PUT    /_neolith/admin/v1/buckets/{bucket}/ec-override
DELETE /_neolith/admin/v1/buckets/{bucket}/ec-override
GET    /_neolith/admin/v1/storage-classes/{name}/ec-override
PUT    /_neolith/admin/v1/storage-classes/{name}/ec-override
DELETE /_neolith/admin/v1/storage-classes/{name}/ec-override
```

`PUT` body (both fields optional - set only the one you care about):

```json
{
  "ec": { "codec": "reed-solomon", "data_shards": 10, "parity_shards": 4, "local_parity": 0 },
  "max_stripe_bytes": 33554432
}
```

`max_stripe_bytes` caps how large a single EC stripe is allowed to grow when the journal flushes a batch of writes for that bucket/storage-class - it does not resize `journal.segment_max_bytes` (the WAL segment-rolling threshold stays a single global setting), it only bounds the *EC stripe* an oversized flush batch gets split into. It must be at least 1 MiB; smaller values are rejected, since a target near or below typical object size defeats the point of stripe batching (one EC stripe, and its full parity-shard write + fsync overhead, per object).

**LRC overrides are skipped, not applied.** The journal engine has no LRC support - if an `ec` override at any tier (pool, bucket, or storage-class) specifies `local_parity > 0`, that tier's EC scheme is skipped (not silently truncated to plain Reed-Solomon) and resolution falls through to the next tier in the precedence chain. A `max_stripe_bytes` value on the same override still applies even if its `ec` half was skipped.

### Journal commit sharding

```toml
[journal]
commit_shards = 2   # default: 2
```

Under `storage.scheme = "journal"`, every write routes to one of
`commit_shards` independent commit threads (by bucket/key partition). This is
a measured workload trade-off, not a free speedup: spreading the same client
concurrency across more shards raises large-object PUT throughput but thins
each group-commit batch, amortizing fsync worse for small objects. On the
2x NVMe reference hardware (vs one shard): 2 shards were near-neutral on
4 KiB durable PUTs (-0.9%) while gaining +25.7% at 64 KiB, +56.9% at 1 MiB,
and +78.0% at 8 MiB - the default; 8 shards gained the most on large objects
(about 3.2x) but cost 47.5% of 4 KiB durable-PUT throughput. Raise the value
for large-object-heavy ingest pipelines; lower it to 1 only if small-object
durable-PUT is your sole bottleneck. Local per-node setting with no
cluster-wide meaning. Choose it per deployment BEFORE writing data: keys
route to shards by hash, so the server refuses to start if the configured
value differs from what an existing journal was written with (changing it
requires an empty journal directory).

### Journal WAL drive sharding

```toml
[journal]
shard_drives = false   # default: false
```

With `shard_drives = true` and multiple `[storage]` drives, each commit
shard's write-ahead log directory is placed on its own drive (round-robin),
so group-commit fsyncs on different shards stop contending for one device.
Like `commit_shards`, choose it before first write: the server persists the
shard-to-drive layout in a manifest and refuses to boot on ANY layout change
(drive list reorder, insertion, or removal) that would remap a shard away
from its data, naming the affected shard and both locations. The same
manifest records the ordered `[storage]` drive list itself, because every
erasure-coded stripe shard is addressed by its position in that list: a
reorder, insertion, removal or replacement at an existing index is refused
regardless of `shard_drives`, naming the index and both drives. Each drive
root is also stamped once with an identity marker (`.neolith/drive-id`)
recorded next to its path, so drives physically re-plugged in a different
order under device-name mounts are caught even though the configured paths
look unchanged: the refusal says which drive is now behind which path.
Identities must be unique across the list (the same filesystem mounted at two
paths is refused), and a recorded drive found at a newly appended path is
reported as a move, not a new drive. Mounting drives by filesystem UUID or
label avoids the whole class of mix-ups.

Each drive also carries the identity of the journal it belongs to
(`.neolith/journal-id`, a copy of the `.journal-id` file kept next to the
shard-layout manifest). A stamped drive taken from another node and mounted
here at a new path is therefore refused at startup, naming the journal it
belongs to, instead of being adopted as new capacity and having its stripe
shards swept as orphans. To reuse such a drive here deliberately, wipe it and
remove both markers first. Drives stamped before this marker existed are
accepted as before and receive the journal identity on the next start. The
journal's own identity record lives next to the shard-layout manifest; if it
is lost with that directory (a replaced index 0, a metadata wipe), it is
recovered from the drives' copies, so deleting the manifest to re-adopt a
layout keeps working and never requires wiping a drive.

Replacing a failed drive: keep its path in the list, mount the blank
replacement there, create the file `<drive>/.neolith/accept-as-replacement`
on it, and restart. The server stamps the replacement with a fresh identity,
consumes the marker, and scrub/heal regenerate the shards that lived on the
failed drive. Without that marker a drive with no identity stamp at a recorded
index is refused, because an unmounted drive looks exactly like a blank one
and accepting it silently would poison the layout record so the intact
original is refused once it is remounted. A configured path that does not
exist is refused outright (the server never creates drive roots).

Reorders are resolved, not refused: at startup the configured drives are put
back into the recorded order by identity, so a list written in a different
order, or a drive re-plugged at another device path, boots normally with no
data moved (each such move is logged at warn with the recorded index and the
new path, because the node then runs in a different order than configured).
The startup check still refuses what cannot be resolved: a recorded drive
found neither by identity nor at its recorded path, a different stamped drive
sitting at a recorded path, a blank drive at the path a recorded drive
vacated, two paths carrying one identity, and a shorter list (a removed drive
shifts every later index). Index 0 also carries the metadata store, so it
cannot be changed by reordering; to make another drive index 0, migrate the
data deliberately and delete the shard-layout manifest to re-adopt the list.
In a labeled topology the local node's `[[cluster.nodes]].drives` must match
the resolved order (compared as paths), because peers address this node's
shards by index into the advertised list; an entry that omits its drives
advertises the resolved list. This is a tightening: a mismatch that used to
boot with a warning is now refused at startup.

Appending new drives at the END of the list is allowed (existing indices keep
their meaning) and is how capacity is added. Removing an index outright is
not supported; deliberate hand-migrated re-layouts delete the manifest file
to re-adopt the current configuration.

Retiring a drive that is permanently lost with no same-path replacement:
run `neolith admin drive retire <index>` on the node (the drive's position
in `[storage] drives`). The job first checks that every stripe with a shard
on that drive is still within its parity budget and refuses otherwise
(nothing is changed; `--force` retires anyway and reports the stripes whose
data is already lost). It then marks the index retired, so no new shard is
placed on it from that moment (in a cluster the retirement is advertised in
the topology, so peers stop targeting it too), records the retirement in the
shard-layout manifest, and re-stripes every affected stripe onto the
remaining drives in small chunks between regular writes: objects stay
readable throughout, and multipart parts are moved as well. A part that
belongs to an upload still in progress is reported and left for a re-run
once the upload completes; `neolith admin drive retire-status` shows the
progress and every retired index, `neolith admin drive retire-stop` stops
the job between chunks (the index stays retired and a re-run finishes what
is left). After the job the drive's line may stay in the configuration or
be removed: a retired index keeps its position with no drive behind it, the
startup check does not probe it, and a restart never needs the drive.
Index 0 (it carries the metadata store) and, with `shard_drives = true`, a
drive hosting a commit shard's write-ahead log cannot be retired; those are
replaced in place with the accept-as-replacement marker.

### Journal checksum algorithm

`[journal] checksum_algorithm` selects the integrity hash for erasure-coded
stripe shards and objects: `blake3` (default, cryptographic),
`highwayhash256`, or `xxh3_128` (both non-cryptographic and marginally
cheaper on reads). It is fixed at the journal's first start (a change is
refused at startup) and must be identical on every node of a cluster:
shards and descriptors checksummed under one algorithm read as corrupted
under the other. Each node advertises its algorithm in the gossiped
topology; a peer that advertises a different one is fenced offline at the
next heartbeat, before any shard is placed on it, and a node whose every
peer disagrees logs an error naming itself as the misconfigured one. The
inter-node RPC layer also refuses mismatched shard and descriptor writes.

### Large-object write concurrency

```toml
[journal]
large_put_concurrency = 0   # default: 0 (auto: CPU parallelism / 2)
```

Large objects (those above `journal.max_object_bytes`) are erasure-coded and
written to disk on the requesting task, off the commit threads, so their
throughput scales with client concurrency rather than with `commit_shards`.
`large_put_concurrency` caps how many of these encode-and-write operations
run at once across the whole server: it bounds the chunk-buffer memory and
drive contention a burst of large PUTs can create; requests over the cap
queue rather than pile on. `0` (the default) sizes the cap automatically to
half the available CPU parallelism. Values up to 65536 are accepted; there
is rarely a reason to raise the automatic value unless large-object ingest
is your dominant workload and profiling shows idle drives.

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

### I/O Engine

```toml
[io]
engine = "auto"       # "auto" | "standard" | "uring"
queue_depth = 128      # per-ring io_uring submission queue depth
rings_per_drive = 2    # independent io_uring rings per drive
```

Mechanism, not policy — deliberately separate from `[durability]` above. Only consulted where a caller has actually been wired to route through it (currently: the journal's EC shard flush, its narrow-path GET read, and its group-commit segment writes; every other I/O path always uses the standard engine). Linux-only; `queue_depth`/`rings_per_drive` are meaningless when the resolved engine is `standard`.

- `"standard"` — always `tokio::fs`, works everywhere.
- `"uring"` — requires `io_uring` (Linux, kernel 5.6+, built with the `iouring` feature); fails to start if unavailable rather than silently downgrading.
- `"auto"` (default) — uses `io_uring` when available, falls back to `standard` and logs why otherwise. **Currently resolves to `standard` in practice**: the config surface and reactor are fully implemented and tested, but haven't yet shown a measured throughput win over the standard engine for the callers wired so far. See [I/O Engine architecture](../architecture/io-engine.md#benchmark-status) for the current benchmark status before opting in with `engine = "uring"`.

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
# rpc_token = "shared-secret"     # authenticate the internal inter-node RPC surface
# shard_read_timeout_secs = 5     # per-shard READ bound; see below
replication_factor = 3            # copies per object (also the journal/replicated tier RF)
placement_policy = "pack"         # "pack" (default) or "strict" — see below
min_free_disk_bytes = 1073741824  # 1 GB
```

**Shard read timeout.** `shard_read_timeout_secs` (default 5) bounds a
single shard fetch on the read path; on expiry the read degrades to
erasure-code reconstruction, the same path a confirmed-missing shard takes.
The client-wide `rpc_timeout_secs` stays sized for replication writes. Size
it to the worst-case whole-shard transfer on your slowest inter-node link:
too small makes healthy-but-slow peers look degraded (a peer is
short-circuited by the circuit breaker only after two consecutive
timeouts; connection failures short-circuit immediately).

**Internal RPC authentication.** `rpc_token` is a shared secret carried on
every internal inter-node RPC (shard transfer, replication, journal mirror,
topology) and required by every internal RPC endpoint when set. It must be
identical on every node. When unset, the internal surface accepts
unauthenticated requests and the server logs a startup warning: on any
network that is not fully trusted, set `rpc_token` (and preferably TLS/mTLS
under `[tls]`), since these endpoints share the public listen port and carry
object shard data. The S3 API itself is always authenticated separately via
SigV4.

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
| `[meta]` index_flush_threshold | Listing index shards are constructed at startup |
| `[io]` engine/queue_depth/rings_per_drive | Ring pools are constructed once at startup |

## Environment Variables

The following environment variables are recognized:

| Variable | Description | Overrides |
|---|---|---|
| `NEOLITH_ACCESS_KEY` | S3 access key ID | CLI `--access-key` |
| `NEOLITH_SECRET_KEY` | S3 secret access key | CLI `--secret-key` |
| `NEOLITH_MASTER_KEY` | SSE-S3 master encryption key (hex) | CLI `--master-key` |
| `NEOLITH_ENDPOINT` | Admin CLI endpoint (default: `http://localhost:9000`) | CLI `--endpoint` |
| `NEOLITH_EDITION` | Edition override: `oss`, `enterprise`, or `ai` | Config `edition` |
| `NEOLITH_ADVERTISE` | This node's advertised cluster endpoint (per-node override for shared config files, e.g. injected per pod by the Kubernetes operator) | Config `cluster.advertise` |

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
