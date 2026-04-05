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
