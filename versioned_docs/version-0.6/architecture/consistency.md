---
sidebar_position: 6
title: Consistency Model
---

# Consistency Model

Neolith provides strong consistency within a write quorum using Hybrid Logical Clocks (HLC) rather than a consensus protocol like Raft or Paxos. This section covers the consistency guarantees, failure handling, and convergence mechanisms.

## Hybrid Logical Clocks (HLC)

HLC combines the best properties of physical and logical clocks:

- **Physical component**: Ties events to real wall-clock time
- **Logical component**: Provides total ordering even when physical clocks are identical
- **No coordination**: Each node maintains its own clock independently

### HLC Format

Neolith uses a 64-bit HLC packed into an `AtomicU64` for lock-free access:

```
Bits 63-16:  Physical timestamp (milliseconds since epoch)  [48 bits]
Bits 15-0:   Logical counter                                [16 bits]
```

- 48 bits of milliseconds provide ~8,900 years of range
- 16 bits of logical counter allow 65,536 events per millisecond per node
- `AtomicU64` provides lock-free reads and updates on all platforms

### HLC Update Rules

The HLC follows the Lamport/Kulkarni rules adapted for hybrid clocks:

**Local event** (new write):
```
physical = max(hlc.physical, now_ms())
if physical == hlc.physical:
    logical = hlc.logical + 1
else:
    logical = 0
hlc = pack(physical, logical)
```

**Receive event** (incoming replication with remote HLC):
```
physical = max(hlc.physical, remote.physical, now_ms())
if physical == hlc.physical == remote.physical:
    logical = max(hlc.logical, remote.logical) + 1
elif physical == hlc.physical:
    logical = hlc.logical + 1
elif physical == remote.physical:
    logical = remote.logical + 1
else:
    logical = 0
hlc = pack(physical, logical)
```

This guarantees:
- **Monotonicity**: HLC never goes backward on any node
- **Causality**: If event A happens before event B, then `hlc(A) < hlc(B)`
- **Bounded drift**: HLC is never more than max clock skew ahead of real time

### HLC in Metadata

Every object version stores its HLC timestamp in `ObjectMeta.hlc_timestamp` (type `Option<u64>`). This is used for:

- Write quorum conflict resolution
- Read-repair version comparison
- Last-Writer-Wins delete semantics
- Split-brain merge ordering

## Write Quorum

Writes require acknowledgment from a quorum of N/2+1 nodes (where N is the replication factor).

### Write Sequence

```
Client PUT
  |
  [1] Write locally (shards + metadata)
  |
  [2] Stamp with local HLC
  |
  [3] Fan-out replicate to all remote peers in parallel
  |
  [4] Wait for N/2+1 total acknowledgments (including local)
  |
  [5a] Quorum achieved  -> return 200 OK to client
  [5b] Quorum failed    -> rollback local write, return 503
```

### Local Write First

Neolith always writes locally before replicating. This ensures:

- The writing node has a copy even if network partitions occur during replication
- Latency is bounded by the slowest quorum member, not the slowest node overall
- The local write serves as the "vote" of the writing node

### Rollback on Quorum Failure

If the write fails to achieve quorum (fewer than N/2+1 acknowledgments):

1. The local write is rolled back (metadata and shards deleted)
2. The client receives HTTP 503 (Service Unavailable)
3. Remote nodes that received the write will eventually clean up via the orphan scanner

This ensures that a partially-replicated write is never visible to clients.

## Read Path

### Standard Read

A GET request reads from the local node if it has the data:

1. Locate the object via TCH (key -> partition -> node -> drive)
2. Read metadata (MetaView for HEAD, full ObjectMeta for GET)
3. Read K shards, verify BLAKE3 checksums
4. EC decode if any shards are degraded
5. Decrypt and decompress
6. Return response to client

### Read-Repair

After serving the response (without adding client-visible latency), Neolith performs background read-repair:

1. Select one remote replica node
2. Fetch only the HLC timestamp from the remote (lightweight RPC)
3. Compare local HLC with remote HLC:
   - **Local is newer**: Push local version to remote (heal the remote)
   - **Remote is newer**: Fetch remote version and update local (heal local)
   - **Equal**: No action needed

Read-repair provides eventual convergence of all replicas. Over time, reads naturally heal any inconsistencies without a dedicated anti-entropy protocol.

## Last-Writer-Wins Delete

Deletes in a distributed system are challenging because a delete message can arrive before or after a write message due to network reordering. Neolith uses LWW semantics:

### Delete Sequence

```
Client DELETE
  |
  [1] Stamp with local HLC
  |
  [2] Check: incoming HLC > stored HLC?
  |
  [3a] Yes -> delete local object, replicate delete to peers
  [3b] No  -> reject delete (stale), respond with current version
```

### Replicate Delete

The `replicate_delete` RPC includes the HLC timestamp. The receiving node:

1. Compares the incoming delete HLC with its stored HLC
2. If the delete HLC is newer, performs the delete
3. If the stored HLC is newer, ignores the delete (a newer write supersedes it)

This ensures that a write and delete on different nodes resolve consistently regardless of message ordering.

### Versioned Buckets

For buckets with versioning enabled, DELETE does not remove the object. Instead, it creates a delete marker (a metadata entry with `is_delete_marker = true`). Previous versions remain accessible by version ID.

## Split-Brain Detection and Recovery

A network partition can cause nodes to have divergent views of the cluster. Neolith detects and recovers from split-brain conditions.

### Detection

Each node maintains a `ClusterTopology` with a monotonically increasing version number. Split-brain is detected by comparing the set of online nodes, not just the version number:

```rust
fn detect_split_brain(local: &Topology, remote: &Topology) -> bool {
    local.online_nodes() != remote.online_nodes()
}
```

Two nodes with different online node sets have divergent views and are in a split-brain state.

### Merge

When a partition heals and nodes can communicate again, topologies are merged:

1. Union all nodes from both topologies
2. For conflicting node statuses, the higher version wins
3. Set the merged version to `max(local.version, remote.version) + 1`

```rust
fn merge_topologies(local: &Topology, remote: &Topology) -> Topology {
    let mut merged = Topology::new();
    merged.version = max(local.version, remote.version) + 1;

    // Union of all nodes
    for node in local.nodes.union(remote.nodes) {
        merged.add(node);
    }

    // Higher version wins for status conflicts
    for node in merged.nodes {
        if local.has(node) && remote.has(node) {
            let local_status = local.status(node);
            let remote_status = remote.status(node);
            merged.set_status(node, if local.version > remote.version {
                local_status
            } else {
                remote_status
            });
        }
    }

    merged
}
```

After merge, the read-repair mechanism gradually reconciles any data divergence.

## Orphan Scanner

Network failures and partial writes can leave orphaned temporary files on disk. The orphan scanner cleans these up:

- **Scan interval**: Periodic (configurable, default every 5 minutes)
- **Target**: Files with `.tmp` suffix in data directories
- **Max age**: 300 seconds (5 minutes). Files newer than this are left alone, as they may be in-progress writes
- **Action**: Delete orphaned `.tmp` files older than `max_age`

```rust
fn cleanup_orphans(root: &Path, max_age: Duration) {
    // Walk data directories
    // For each .tmp file:
    //   if file.modified_time + max_age < now:
    //     delete file
}
```

## Disk-Full Protection

Neolith implements two layers of protection against disk-full conditions:

### Pre-Write Check

Before every write, Neolith checks available disk space using `statvfs`:

```rust
fn check_disk_space(path: &Path, required: u64) -> Result<()> {
    let stat = statvfs(path)?;
    let available = stat.f_bavail * stat.f_frsize;
    if available < required + DISK_RESERVE {  // DISK_RESERVE = 1 MB
        return Err(Error::InsufficientStorage);
    }
    Ok(())
}
```

If the check fails, the write is rejected with HTTP 507 (Insufficient Storage) before any I/O is attempted.

### ENOSPC Catch

If the pre-write check passes but the disk fills up during the write (e.g., concurrent writes from other processes), the `ENOSPC` error is caught and converted to HTTP 507. Partial writes are cleaned up.

This two-layer approach ensures Neolith never silently corrupts data due to disk exhaustion.

## Consistency Guarantees Summary

| Scenario | Guarantee |
|----------|-----------|
| Single-node write | Atomic (write + fsync + rename) |
| Multi-node write | Quorum consistency (N/2+1) |
| Read after quorum write | Consistent (local copy exists) |
| Read from non-quorum node | Eventually consistent (read-repair) |
| Concurrent writes to same key | Last-Writer-Wins (HLC ordering) |
| Delete vs write race | LWW (higher HLC wins) |
| Network partition | Split-brain detection + merge on heal |
| Disk full | Rejected before write (507) |
| Crash during write | Atomic rename - no partial metadata |
