---
sidebar_position: 2
title: "Neolith vs Ceph"
---

# Neolith vs Ceph

Ceph and Neolith represent fundamentally different philosophies in storage system design. Ceph is a unified block+file+object platform with exabyte-scale proven deployments. Neolith is a focused object storage system designed for simplicity, safety, and AI-native workloads.

## At a Glance

| Dimension | Ceph | Neolith |
|---|---|---|
| **Language** | C++ (~3M lines) | Rust (~50K lines) |
| **License** | LGPL 2.1 / 3.0 | Apache 2.0 |
| **First Release** | 2006 (20 years) | 2026 |
| **Production Scale** | Exabyte-proven (CERN, Bloomberg) | New project |
| **Storage Types** | Block (RBD) + File (CephFS) + Object (RGW) | Object only |
| **Erasure Coding** | RS, LRC, CLAY, SHEC | RS, LRC |
| **Metadata** | RADOS + RocksDB (per-OSD) | Per-shard FlatBuffers (no embedded DB) |
| **Binary** | 6+ daemons (MON, OSD, MDS, MGR, RGW, MDS) | Single binary |
| **Memory Safety** | Manual C++ (CVE history) | Rust ownership (memory-safety CVEs impossible) |
| **Cluster Protocol** | Custom RADOS messaging + Paxos | HTTP/2 + FlatBuffers on port 9000 |

## Architecture Comparison

### Ceph: CRUSH + Monitors + OSDs

Ceph's architecture is built around several interacting daemons:

```
┌────────────┐  ┌────────────┐  ┌────────────┐
│   MON (3+) │  │   MGR (2+) │  │ MDS (2+ if │
│   Paxos    │  │  Dashboard │  │  CephFS)   │
│  Cluster   │  │  Telemetry │  │  Metadata  │
│    Map     │  │  Modules   │  │   Server   │
└──────┬─────┘  └──────┬─────┘  └──────┬─────┘
       │               │               │
       └───────────────┬┘               │
                       │                │
       ┌───────────────▼────────────────▼──┐
       │        RADOS Cluster              │
       │  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ │
       │  │ OSD │ │ OSD │ │ OSD │ │ OSD │ │
       │  │RocksDB│RocksDB│RocksDB│RocksDB│ │
       │  └─────┘ └─────┘ └─────┘ └─────┘ │
       └───────────────────────────────────┘
              │
       ┌──────▼──────┐
       │     RGW     │  <-- S3/Swift API gateway
       │  (separate  │
       │   daemon)   │
       └─────────────┘
```

Ceph requires a minimum of 3 monitors for quorum, at least 3 OSDs for data placement, a manager for orchestration, and RGW (RADOS Gateway) as a separate daemon for S3 API access. CephFS adds MDS daemons for file metadata.

The CRUSH algorithm determines data placement. CRUSH maps are computed by clients and OSDs to locate data without a centralized lookup, enabling massive scale. However, CRUSH map management, PG (Placement Group) tuning, and pool configuration add significant operational complexity.

### Neolith: Symmetric Peers + TCH

Neolith uses a fundamentally simpler architecture:

```
┌─────────────────────────────────────┐
│       Neolith Node (single binary)  │
│  ┌──────────┐  ┌──────────────────┐ │
│  │  S3 API  │  │  Storage Engine  │ │
│  │  (Axum)  │  │  (Shards + Meta) │ │
│  └────┬─────┘  └────────┬─────────┘ │
│       │                 │           │
│  ┌────▼─────────────────▼─────────┐ │
│  │     TCH (Topology-Consistent   │ │
│  │     Hashing) + HRW Selection   │ │
│  └────────────────────────────────┘ │
└─────────────────────────────────────┘
```

Every node runs the same binary and can serve any role. Cluster topology uses static TOML peer configuration with heartbeat polling. Data placement uses TCH: `BLAKE3(bucket/key) mod 16384` partitions with HRW (Highest Random Weight) node selection and failure-domain spread.

No monitors. No separate gateway daemon. No RocksDB. No Paxos. No placement group tuning.

## Erasure Coding

Both systems support advanced erasure coding, but the implementations differ:

| EC Feature | Ceph | Neolith |
|---|---|---|
| Reed-Solomon | Yes (jerasure, ISA-L) | Yes (reed-solomon-simd, mandatory SIMD) |
| LRC | Yes (local recovery codes) | Yes (LrcCodec with per-group RS) |
| CLAY | Yes (coupled-layer) | Not yet |
| SHEC | Yes (shingled) | Not yet |
| Min config | 2+1 | 2+1 |
| Typical config | 4+2 or 8+3 | 4+2 or 10+4 with LRC groups |
| Repair I/O (LRC) | ~75% reduction | ~75% reduction |

Ceph's erasure coding has the broadest algorithm support, including CLAY codes that minimize repair bandwidth to the theoretical minimum. Neolith's LRC implementation (10,4,2,5 or 12,3,3,4 ratios) provides the most impactful optimization: local repair reads only `group_size` shards instead of the full `data_shards` count, reducing repair I/O by approximately 75% for single-shard failures.

Neolith's heal engine uses a `try_lrc_local_repair()` fast path before falling back to global RS decode, ensuring single-shard failures are repaired with minimal I/O.

## Metadata Architecture

| Aspect | Ceph | Neolith |
|---|---|---|
| Storage | RocksDB per OSD | Per-shard FlatBuffer files |
| Serialization | Internal RADOS encoding | FlatBuffers (zero-copy) |
| Embedded DB | Yes (RocksDB LSM tree) | No embedded DB |
| Compaction | Background LSM compaction | None needed |
| Recovery | RocksDB WAL replay | File-level consistency |
| Scale concern | RocksDB memory + compaction pressure | File count (inode limits on ext4) |

Ceph's reliance on RocksDB per OSD adds operational complexity: LSM compaction can cause I/O spikes, RocksDB memory usage must be tuned, and recovery requires WAL replay. Neolith avoids all of this by using simple per-shard metadata files with FlatBuffer serialization.

## Operational Complexity

This is where Neolith's design philosophy diverges most sharply from Ceph.

### Ceph Operations Checklist

A Ceph deployment requires managing:
- Monitor quorum (3-5 nodes, Paxos consensus)
- OSD daemon lifecycle (add, remove, reweight)
- Placement Group (PG) count tuning (too few = hotspots, too many = memory pressure)
- CRUSH map design (failure domains, device classes, rules)
- Pool creation and configuration (replication vs EC, PG count, min_size)
- RocksDB tuning (block cache, WAL, compaction)
- CephFS MDS configuration (if file storage needed)
- RGW zone/zonegroup configuration (if multi-site)
- Manager module configuration (dashboard, telemetry, orchestrator)
- BlueStore configuration (block.db, block.wal placement)
- Network configuration (public + cluster networks)

Many of these are day-1 decisions that are difficult to change later (PG count, CRUSH topology, BlueStore layout).

### Neolith Operations Checklist

A Neolith deployment requires:
- One TOML config file per node (peers, drives, port)
- Start the binary
- (Enterprise) Provide a license file

Cluster operations are managed via the Admin API or CLI:
```bash
neolith server start                  # Start a node
neolith cluster status                # View cluster health
neolith admin heal start              # Start a heal
neolith admin pool create my-pool     # Create a storage pool
neolith admin rebalance start         # Rebalance data
```

No PG tuning. No CRUSH map editing. No RocksDB knobs. No separate daemon management.

## Memory Safety

Ceph's ~3 million lines of C++ have accumulated memory-safety vulnerabilities over its 20-year history. Buffer overflows, use-after-free, and other memory safety issues appear periodically in CVE databases.

Neolith uses Rust with `deny(unsafe_code)` at the workspace level (changed from `forbid` to `deny` only to accommodate FlatBuffer-generated code). Memory-safety vulnerabilities are architecturally impossible in Neolith's codebase. There is no C/C++ in the data path.

## When to Choose Ceph

- You need unified block + file + object storage (single platform for VMs, containers, and S3)
- Exabyte-scale deployments with proven production track record
- Advanced erasure coding (CLAY, SHEC) is required
- CephFS for POSIX-compatible shared filesystems
- Large existing Ceph operational team and tooling
- You are already running OpenStack or Kubernetes with Rook

## When to Choose Neolith

- Object storage is the primary requirement (no block/file needed)
- Operational simplicity is a priority (no PG tuning, no monitor quorum, no RocksDB)
- Memory safety and Rust's security guarantees matter
- AI/ML workloads need batch GET, ETL-on-GET, and PyTorch integration
- Apache 2.0 licensing (vs LGPL/GPL)
- Small team without dedicated Ceph expertise
- Single-binary deployment with minimal operational overhead
- Predictable performance without GC pauses or LSM compaction spikes
