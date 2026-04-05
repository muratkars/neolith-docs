---
sidebar_position: 4
title: "Admin Commands"
---

# Admin Commands

The `neolith admin` subcommand group provides administrative operations that can mutate cluster state. These commands connect to a running Neolith server via its Admin API endpoints under `/_neolith/admin/v1/`.

All admin commands accept `--endpoint <URL>` (default: `http://localhost:9000`, or `NEOLITH_ENDPOINT` env var).

## Heal Commands

Neolith continuously monitors data integrity and repairs corrupted or missing erasure-coded shards. The heal commands let you inspect the healing queue, trigger manual repairs, and stop active heal operations.

### `neolith admin heal status`

Display the current state of the healing subsystem: queue depth, items healed, items failed, and whether a background scan is running.

```
neolith admin heal status [--endpoint URL] [--output text|json]
```

**Example output:**

```json
{
  "queue_depth": 42,
  "items_healed": 1523,
  "items_failed": 3,
  "scanner_running": true,
  "scanner_progress": "bucket-images/photo-00384.jpg",
  "scan_cycle_days": 30
}
```

The background scanner walks all objects over a 30-day cycle, verifying BLAKE3 checksums for every shard. Corrupted or missing shards are enqueued for repair with priority ordering: criticality (fewer surviving shards = higher priority) > hotness (frequently accessed objects first) > age (older objects first).

### `neolith admin heal trigger`

Manually trigger a heal operation. By default, triggers a targeted heal. Use `--full-scan` to start a complete background scan of all objects.

```
neolith admin heal trigger [--endpoint URL] [--full-scan] [--bucket BUCKET] [--key KEY]
```

**Options:**

| Option | Description |
|---|---|
| `--full-scan` | Start a full background scan of all buckets and objects |
| `--bucket <NAME>` | Heal only objects in a specific bucket |
| `--key <KEY>` | Heal a specific object (requires `--bucket`) |

**Examples:**

```bash
# Start a full background scan
neolith admin heal trigger --full-scan

# Heal a specific bucket
neolith admin heal trigger --bucket my-training-data

# Heal a specific object
neolith admin heal trigger --bucket my-bucket --key models/checkpoint-42.pt
```

**Response:**

```json
{
  "status": "triggered",
  "full_scan": false,
  "bucket": "my-bucket",
  "key": "models/checkpoint-42.pt"
}
```

### `neolith admin heal stop`

Stop any active heal operations. This cancels the background scanner and drains the heal queue. Pending repairs are not lost - they will be re-discovered on the next scan.

```
neolith admin heal stop [--endpoint URL]
```

```bash
$ neolith admin heal stop
{
  "status": "stopped",
  "pending_items_cancelled": 42
}
```

## Rebalance Commands

When nodes are added or removed, data distribution across the cluster may become uneven. Rebalance migrates partitions to achieve balanced distribution according to the TCH placement algorithm.

### `neolith admin rebalance start`

Start a rebalance operation. The server computes the ideal partition placement and begins migrating data.

```
neolith admin rebalance start [--endpoint URL] [--concurrency N] [--throttle-mbps N]
```

**Options:**

| Option | Default | Description |
|---|---|---|
| `--concurrency` | 4 | Maximum concurrent partition migrations |
| `--throttle-mbps` | 100 | Bandwidth throttle in MB/s to limit impact on foreground traffic |

**Example:**

```bash
# Start rebalance with default settings
neolith admin rebalance start

# Aggressive rebalance during maintenance window
neolith admin rebalance start --concurrency 16 --throttle-mbps 500

# Gentle rebalance during production hours
neolith admin rebalance start --concurrency 2 --throttle-mbps 50
```

```json
{
  "status": "started",
  "concurrency": 4,
  "throttle_mbps": 100,
  "partitions_to_migrate": 1024
}
```

### `neolith admin rebalance status`

Check the progress of a running rebalance.

```
neolith admin rebalance status [--endpoint URL] [--output text|json]
```

```json
{
  "running": true,
  "partitions_migrated": 512,
  "partitions_total": 1024,
  "bytes_migrated": 53687091200,
  "elapsed_seconds": 3600,
  "estimated_remaining_seconds": 3600
}
```

### `neolith admin rebalance stop`

Stop a running rebalance. Already-migrated partitions remain in their new locations; the rebalance can be resumed later.

```
neolith admin rebalance stop [--endpoint URL]
```

## Decommission

### `neolith admin decommission <NODE_ID>`

Remove a node from the cluster. The server migrates all data off the node before marking it as decommissioned. This is a long-running operation.

```
neolith admin decommission <NODE_ID> [--endpoint URL] [--force]
```

**Arguments:**

| Argument | Description |
|---|---|
| `<NODE_ID>` | The node identifier (typically its advertised endpoint URL) |

**Options:**

| Option | Description |
|---|---|
| `--force` | Force decommission even if the node is unreachable. Data on the unreachable node will be reconstructed from parity shards on other nodes. |

**Examples:**

```bash
# Graceful decommission (node is online, data migrates off)
neolith admin decommission https://node4.neolith.local:9000

# Force decommission (node is dead, reconstruct from parity)
neolith admin decommission https://node4.neolith.local:9000 --force
```

```json
{
  "status": "decommissioning",
  "node_id": "https://node4.neolith.local:9000",
  "forced": false,
  "partitions_to_evacuate": 4096
}
```

## Node Info

### `neolith admin node <NODE_ID>`

Display detailed information about a specific node.

```
neolith admin node <NODE_ID> [--endpoint URL]
```

```bash
$ neolith admin node https://node2.neolith.local:9000
```

```json
{
  "node_id": "https://node2.neolith.local:9000",
  "status": "online",
  "drives": ["/mnt/disk1", "/mnt/disk2", "/mnt/disk3", "/mnt/disk4"],
  "partitions_owned": 4096,
  "objects_stored": 1250000,
  "bytes_used": 5368709120000,
  "last_heartbeat": "2026-03-15T10:30:44Z"
}
```

## Pool Commands

Storage pools group nodes and drives with a shared erasure coding configuration. Pools allow heterogeneous hardware (different drive sizes, different EC ratios) within a single cluster.

### `neolith admin pool list`

List all storage pools and their status.

```
neolith admin pool list [--endpoint URL] [--output text|json]
```

```json
{
  "pools": [
    {
      "id": "pool-1",
      "name": "nvme-pool",
      "status": "active",
      "nodes": ["node1", "node2", "node3", "node4"],
      "drives": ["/mnt/nvme1", "/mnt/nvme2"],
      "ec_ratio": "8:4"
    },
    {
      "id": "pool-2",
      "name": "hdd-archive",
      "status": "active",
      "nodes": ["node3", "node4"],
      "drives": ["/mnt/hdd1", "/mnt/hdd2", "/mnt/hdd3"],
      "ec_ratio": "12:3"
    }
  ]
}
```

### `neolith admin pool add`

Create a new storage pool with specified nodes, drives, and erasure coding ratio.

```
neolith admin pool add [--endpoint URL] --name <NAME> --nodes <N1,N2,...> --drives <D1,D2,...> [--ec-ratio N:M]
```

**Options:**

| Option | Default | Description |
|---|---|---|
| `--name` | (required) | Human-readable pool name |
| `--nodes` | (required) | Comma-separated node IDs |
| `--drives` | (required) | Comma-separated drive paths |
| `--ec-ratio` | `8:4` | Erasure coding ratio as `data:parity` |

**Example:**

```bash
neolith admin pool add \
  --name nvme-fast \
  --nodes node1,node2,node3,node4 \
  --drives /mnt/nvme1,/mnt/nvme2 \
  --ec-ratio 8:4
```

The EC ratio determines storage efficiency and fault tolerance:
- `8:4` (default): 67% efficiency, tolerates 4 drive failures
- `12:3`: 80% efficiency, tolerates 3 drive failures
- `4:2`: 67% efficiency, suitable for smaller deployments

### `neolith admin pool info <POOL_ID>`

Display detailed information about a specific pool.

```
neolith admin pool info <POOL_ID> [--endpoint URL]
```

### `neolith admin pool expand <POOL_ID>`

Add nodes and/or drives to an existing pool. New capacity is available immediately; a rebalance spreads existing data to the new resources.

```
neolith admin pool expand <POOL_ID> [--endpoint URL] --nodes <N1,N2,...> --drives <D1,D2,...>
```

**Example:**

```bash
# Add two more nodes to an existing pool
neolith admin pool expand pool-1 \
  --nodes node5,node6 \
  --drives /mnt/nvme1,/mnt/nvme2
```

Pool status values:

| Status | Description |
|---|---|
| `active` | Pool is healthy and serving I/O |
| `read_only` | Pool accepts reads but rejects writes |
| `decommissioning` | Pool is draining data before removal |

## API Endpoints

All admin commands map to REST API endpoints:

| Command | Method | Endpoint |
|---|---|---|
| `heal status` | GET | `/_neolith/admin/v1/heal/status` |
| `heal trigger` | POST | `/_neolith/admin/v1/heal/trigger` |
| `heal stop` | POST | `/_neolith/admin/v1/heal/stop` |
| `rebalance start` | POST | `/_neolith/admin/v1/rebalance/start` |
| `rebalance status` | GET | `/_neolith/admin/v1/rebalance/status` |
| `rebalance stop` | POST | `/_neolith/admin/v1/rebalance/stop` |
| `decommission` | POST | `/_neolith/admin/v1/node/{id}/decommission` |
| `node` | GET | `/_neolith/admin/v1/node/{id}/status` |
| `pool list` | GET | `/_neolith/admin/v1/pools` |
| `pool add` | POST | `/_neolith/admin/v1/pools` |
| `pool info` | GET | `/_neolith/admin/v1/pools/{id}` |
| `pool expand` | POST | `/_neolith/admin/v1/pools/{id}/expand` |
