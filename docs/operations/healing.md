---
sidebar_position: 2
title: "Self-Healing"
---

# Self-Healing

Neolith continuously monitors and repairs data integrity issues without operator intervention. The healing subsystem detects corrupted or missing erasure-coded shards, prioritizes repairs by criticality, and reconstructs data using the remaining healthy shards.

## Healing Modes

### Reactive Healing (On-Read)

When a GET request encounters a corrupted shard (BLAKE3 checksum mismatch) or a missing shard, the server:

1. **Returns the data immediately** using the remaining healthy shards and EC reconstruction
2. **Queues a background repair** for the damaged shard

This ensures read availability is never compromised by data degradation. The client gets its data without delay, and the repair happens asynchronously.

### Background Scanner

A background scanner proactively walks all objects across all buckets, verifying every shard's BLAKE3 checksum. This catches corruption that has not yet been encountered by a read operation.

**Scanner characteristics:**
- **30-day scan cycle**: All objects are verified once every 30 days
- **Per-object throttle**: Configurable delay (`inter_object_delay_ms`, default 50ms) between objects to limit I/O impact
- **Bucket discovery**: Uses `MetaStore::list_buckets()` which scans the root data directory, skipping hidden directories (`.neolith`)
- **Resumable**: If the server restarts, the scanner starts from the beginning of the current cycle

Start or stop the scanner via CLI:

```bash
# Start a full scan
neolith admin heal trigger --full-scan

# Stop the scanner
neolith admin heal stop
```

### Deep Scan

Beyond checksum verification, deep scan performs full EC decode verification. This catches subtle issues like:
- Bitrot in checksums themselves
- Metadata corruption that causes incorrect shard reassembly
- Hardware errors that corrupt data between the checksum check and the application

Configuration:

```toml
[deep_scan]
# Delay between scanning individual objects
inter_object_delay_ms = 50

# Maximum concurrent EC decode verifications
max_concurrent_verifies = 2
```

Deep scan is more I/O-intensive than checksum-only scanning because it reads all shards and performs a full Reed-Solomon or LRC decode.

## Priority Queue

Repairs are prioritized using a three-level ordering:

### 1. Criticality (Highest Priority)

Objects with fewer surviving shards are repaired first. An object missing 3 of 4 parity shards is more urgent than one missing 1 shard, because it is closer to data loss if another shard fails.

### 2. Hotness (Second Priority)

Frequently accessed objects are repaired before cold data. The `HotnessTracker` maintains an LFU (Least Frequently Used) counter for each object:

- Every GET increments the object's access counter
- **Cold-half eviction**: When the tracker reaches capacity, the least-accessed half of entries are evicted. This keeps the tracker bounded in memory while maintaining accurate hotness scores for frequently accessed data
- Hot objects get priority because their corruption is more likely to impact workloads

### 3. Age (Third Priority)

Among objects with equal criticality and hotness, older objects (earlier `modified_at` timestamps) are repaired first. This prevents recently-corrupted objects from starving old corruption.

## Queue Management

### Bounded Queue

The heal queue is bounded at 100,000 entries (configurable). This prevents unbounded memory growth if a large number of corruptions are detected simultaneously (e.g., after a drive failure).

When the queue is full, new repair requests are dropped. The background scanner will re-discover them on the next scan cycle.

### Retry with Exponential Backoff

Failed repairs are retried with exponential backoff:

- First retry: 1 second
- Second retry: 2 seconds
- Third retry: 4 seconds
- Fourth retry: 8 seconds
- Fifth retry: 16 seconds
- Max retries: configurable (default 5)

After exhausting retries, the item is moved to quarantine for manual investigation.

## Repair Process

### Shard Scanning

The `scan_shards()` function reads and verifies every shard for a given object:

1. Read each shard file from disk
2. Compute BLAKE3 checksum over the shard data
3. Compare against the stored checksum in the FlatBuffer metadata
4. Mark each shard as `healthy`, `corrupted`, or `missing`

**Parallel shard I/O**: Uses `tokio::task::JoinSet` for parallel shard reads, achieving ~10x throughput on NVMe drives compared to sequential reads.

### Shard Reconstruction

The `write_repaired_shards()` function reconstructs damaged shards:

1. Collect all healthy shards (must have at least `data_shards` healthy shards for Reed-Solomon, or `group_size` for LRC local repair)
2. Run EC decode to reconstruct the missing/corrupted data
3. Write the reconstructed shards to disk
4. Update checksums in the metadata

### LRC Local Repair Fast Path

For objects using LRC (Locally Repairable Codes), single-shard failures can be repaired using only the local group's shards:

- **Standard RS repair**: Reads all `data_shards` remaining shards (e.g., 10 shards for RS 10+4)
- **LRC local repair**: Reads only `group_size` shards from the damaged shard's local group (e.g., 5 shards for LRC 10+4+2, group_size=5)

This reduces repair I/O by ~50-75%. The heal engine calls `try_lrc_local_repair()` first for single-shard failures. If local repair fails (e.g., two shards in the same group are damaged), it falls back to global RS decode.

## Quarantine

Objects that fail repair after all retries are moved to quarantine for forensic analysis:

```
<data_dir>/.neolith/quarantine/
  <bucket>/
    <key>/
      meta.neo    # Preserved metadata
      shard-0.dat # Preserved corrupted shard data
      shard-1.dat
      ...
```

Configuration:

```toml
[quarantine]
# Enable quarantine (default: true)
enabled = true

# Maximum age of quarantined files before auto-cleanup
max_age_days = 7

# Maximum total quarantine directory size
max_size_gb = 1
```

Quarantined objects are preserved for manual investigation. After `max_age_days`, they are automatically cleaned up. If the quarantine directory exceeds `max_size_gb`, the oldest entries are removed first.

## Heal Throttling

To prevent healing from overwhelming foreground I/O (the "thundering herd" problem after a drive failure), Neolith provides configurable heal throttling:

```toml
[heal_throttle]
# Enable throttling (default: true)
enabled = true

# Maximum heal I/O budget in bytes per second
# Default: 50 MB/s - generous enough for timely repair, gentle enough for production traffic
io_budget_bytes_per_sec = 52428800

# Maximum concurrent heals per drive
# Limits seeks on spinning disks, less relevant for NVMe
max_concurrent_per_drive = 2
```

The heal engine tracks I/O consumption against the budget and pauses when the budget is exceeded. This ensures that foreground traffic (client GETs and PUTs) is not starved by background repair activity.

## Monitoring Heal Status

### CLI

```bash
$ neolith admin heal status
{
  "queue_depth": 42,
  "items_healed": 1523,
  "items_failed": 3,
  "scanner_running": true,
  "scanner_progress": "bucket-images/photo-00384.jpg",
  "scan_cycle_days": 30
}
```

### Metrics

The heal subsystem exposes its state via the Admin API. For Prometheus integration, scrape the heal status endpoint periodically:

```bash
# Get heal status as JSON
curl http://localhost:9000/_neolith/admin/v1/heal/status
```

### HealStats

The `HealStats` structure tracks all healing counters:

- `items_healed`: Total objects successfully repaired
- `items_failed`: Total objects that failed repair
- `shards_repaired`: Total individual shards reconstructed
- `bytes_repaired`: Total bytes of shard data reconstructed
- `queue_depth`: Current number of pending repair items
- `scanner_position`: Current object being scanned

## Graceful Shutdown

Background heal tasks use `tokio_util::sync::CancellationToken` for graceful shutdown:

1. On SIGTERM/SIGINT, the main server cancels the heal token
2. The background scanner stops at the next object boundary
3. The heal worker drains the current in-progress repair
4. Pending queue items are preserved in the queue (re-discovered on next startup)

No repair work is lost due to shutdown. The scanner will restart from the beginning of the cycle on next startup, and any corrupted objects will be re-discovered.

## Failure Scenarios & Operator Response

What a hardware failure actually does to your data depends on the placement invariant: in a multi-node cluster the **host is the failure domain**, so any given stripe has at most one shard on any one server. A server's many drives therefore hold shards belonging to thousands of *different* stripes, and losing a drive degrades each affected stripe by exactly one shard. See [Neocloud Multi-Region Storage](../use-cases/neocloud) for how this maps onto a regional topology and the durability formula.

The table below summarizes severity for the default `RS(8,4)` scheme (12 shards, tolerates 4 losses). "Margin" is how many further shard losses a stripe can absorb before data loss.

| Failure | Effect on an affected stripe | Data loss? | Availability | Operator action |
|---|---|---|---|---|
| Bitrot / bad sectors | 1 shard corrupt | No | Unaffected | None (auto-repaired) |
| Single drive | 1 shard lost (4 -> 3 margin) | No | Unaffected | Replace drive, then rebalance |
| Whole node | 1 shard lost on *many* stripes | No | Unaffected | Decommission if permanent |
| Rack loss (4+ racks) | up to 3 shards lost | No | Unaffected | Restore rack, monitor heal |
| Rack loss (3 racks) | 4 shards lost (0 margin) | No, but no headroom | Unaffected | Restore urgently |
| 5+ shards before repair | stripe unrecoverable | Yes (local) | Local read fails | Recover from peer region |

### Single drive failure (common case)

A dead NVMe removes the shards stored on it, but because of the one-shard-per-host rule each affected stripe loses only one of its 12 shards (margin 4 -> 3).

- **No data loss, no unavailability.** Reads transparently reconstruct from the surviving shards via [reactive healing](#reactive-healing-on-read).
- The node still has its remaining drives and stays a valid failure domain, so the heal engine reconstructs the lost shards onto a surviving drive on the same node.
- Operator: physically replace the NVMe, then repopulate and redistribute onto the fresh drive (see [After Drive Replacement](#after-drive-replacement)).

### Bitrot and partial corruption (most frequent, least severe)

A few flipped bits in a shard, without a drive failure, are caught by the per-shard BLAKE3 checksum on read or by the background scanner / deep scan. Only the corrupted shards are rebuilt. This is routine background activity and needs no operator action.

### Whole-node failure

A dead server removes one shard from *every* stripe that had a shard on it, so a large fraction of stripes drop to margin 3 at once. Still within the parity budget, so no loss, but the heal load is heavy and [throttling](#heal-throttling) governs its impact.

- Transient (reboot): let the node rejoin; healing catches up automatically.
- Permanent: decommission and reconstruct from parity.

```bash
# Node is dead: reconstruct its shards from parity on other nodes
neolith admin decommission <node-endpoint> --force
# After hardware replacement and rejoin, redistribute:
neolith admin rebalance start
```

### Concurrent failures and the parity budget

A stripe is lost only when **more than M (4) shards** are lost before repair completes. Because shards are spread across distinct hosts and racks, that requires several drives that each hold a shard of the *same* stripe to fail inside one repair window. This is the regime the durability formula quantifies (~15 nines for `RS(8,4)` against independent failures). The defenses are spread (more racks) and a short repair window, not more parity.

### Rack, datacenter, or region loss

Correlated site failures, not independent component failures, set the real durability ceiling:

- **Rack loss** with 4+ racks per pool: each stripe loses at most 3 shards and survives with margin. With only 3 racks a stripe loses exactly 4 = M, which survives but with **zero headroom**: any concurrent drive failure during the rack-down window causes loss. Keep 4+ racks per pool for a fault-tolerant tier.
- **Region or datacenter loss** beyond local parity: recovery comes from the asynchronous replica in a peer region (see [Replication & Tiering](../enterprise/replication)). Because replication is asynchronous (RPO > 0), the most recent un-replicated writes can be lost on failover.

### MTTR is the operator's durability lever

In the durability model `MTTDL` scales as `mu^M`, where `mu = 1 / MTTR`. MTTR is set almost entirely by how fast drives are replaced and how much heal I/O budget is allowed. Halving MTTR on `RS(8,4)` raises durability roughly 16x. Operational SLAs (replace a failed NVMe within a fixed window, keep the heal queue draining, keep 4+ racks live per pool) therefore determine the number of nines directly, and cost no extra storage.

## Operational Recommendations

### After Drive Replacement

```bash
# Trigger a full scan to discover and repair all affected objects
neolith admin heal trigger --full-scan

# Monitor progress
watch neolith admin heal status
```

### During High Traffic

If heal I/O is impacting foreground latency, reduce the heal budget:

```toml
[heal_throttle]
io_budget_bytes_per_sec = 10485760   # 10 MB/s (reduced from 50 MB/s)
max_concurrent_per_drive = 1          # Single heal per drive
```

Reload configuration via `SIGHUP` - no restart needed.

### Investigating Quarantined Objects

```bash
# Check quarantine contents
ls -la <data_dir>/.neolith/quarantine/

# Examine a quarantined object's metadata
cat <data_dir>/.neolith/quarantine/<bucket>/<key>/meta.neo | hexdump -C
```

Quarantined objects indicate either hardware issues (failing drive, bad memory) or software bugs. Check drive health metrics and system logs for correlated hardware errors.
