---
sidebar_position: 2
title: "Deployment Topologies & Minimums"
---

# Deployment Topologies & Minimums

This page answers the first question every operator asks: **how many nodes and drives do I need, and what does each topology actually survive?**

The short version: Neolith's two durability mechanisms have *different* minimums, and conflating them is the usual source of confusion.

- **Replication** (the default cluster write path, `replication_factor` copies) needs **failure domains, not drives.** RF=3 wants 3 domains.
- **Erasure coding** (`[erasure]`) needs **`data_shards + parity_shards` drives**, and the ratio must be sized so that losing one whole domain stays within the parity budget.

If you come from MinIO, note the difference: there the **drive** is the failure domain, which is where the "minimum 4 drives" rule comes from. In a Neolith *multi-node* cluster the **node** (or rack/zone, if labeled) is the coarse failure domain, so the binding minimum is node count — not drive count.

## Failure domains

A failure domain is a unit that can fail together. Neolith spreads copies/shards across domains so a single failure can't take out enough of them to lose data. Domains are ordered broadest-to-narrowest via topology labels:

```
zone → rack → host → drive
```

- **Single node:** the only meaningful domain is the **drive**.
- **Multi-node:** the **node/host** is the coarse domain; label racks and zones for wider spread.

The `[cluster] placement_policy` setting governs how strictly this spread is enforced:

- `pack` (default) — spread where possible, pack onto shared domains otherwise. Use for single-node, dev, and small clusters.
- `strict` — refuse a write that cannot spread across distinct domains (`507 Insufficient Storage`), and refuse to *start* if the scheme can never be satisfied by the cluster size.

## Topologies at a glance

| Topology | Failure domain | Minimum | Survives | Use for |
|---|---|---|---|---|
| **Laptop / single node, 1 drive** | none | `data_dir`, `placement_policy = "pack"`, `fsync = true` | **Crash / power-cut** (not device loss) | Dev, test, CI |
| **Single node, N drives (SNMD)** | drive | `drives = [...]` with `data_shards + parity_shards ≤ N` | **Drive loss** (not whole-node / power loss) | Single-box production, edge |
| **3 nodes, ≥1 drive each** | node | 3 peers, `replication_factor = 3` (or EC sized to 3 domains) | **1 full node loss** | First highly-available topology |
| **Larger, rack/zone-aware** | rack / zone | Topology labels + LRC or wide RS | **Rack / zone loss** | Scale-out clusters |

## 1. Single node, single drive (laptop / dev)

```toml
[storage]
data_dir = "/data/neolith"

[cluster]
placement_policy = "pack"   # one domain only; strict would refuse to start

[durability]
fsync = true                # crash-consistency on the local disk
```

With one drive there is **no redundancy**. `fsync` protects acknowledged writes against a power-cut losing them from the OS page cache (crash-*consistency*), but it cannot protect against the drive itself failing. Erasure coding across a single drive only adds bitrot/partial-corruption protection, not device-loss protection. This is a development and test mode.

## 2. Single node, multiple drives (SNMD)

```toml
[storage]
drives = ["/mnt/disk1", "/mnt/disk2", "/mnt/disk3", "/mnt/disk4"]

[erasure]
codec = "reed-solomon"
data_shards = 2
parity_shards = 2          # 2+2 = 4 shards across 4 drives → survive 1 drive loss

[durability]
fsync = true
```

Here the **drive is the failure domain** — the MinIO-equivalent topology. You need at least `data_shards + parity_shards` drives (4 for 2+2, 6 for 4+2, etc.). It survives drive failure but **not** loss or power-cut of the whole box, because every drive shares one power rail and one kernel. A single node is therefore never a highly-available deployment, regardless of drive count.

## 3. Three-node cluster (minimum HA)

```toml
[cluster]
advertise = "https://node1.neolith.local:9000"
peers = ["https://node2.neolith.local:9000", "https://node3.neolith.local:9000"]
replication_factor = 3
placement_policy = "strict"   # 3 nodes = 3 domains, satisfiable for RF=3

[durability]
fsync = true
```

For the **replicated path, three nodes with one drive each (3 drives total) is enough.** Quorum is `replication_factor / 2 + 1 = 2`, so a write is acknowledged once 2 of 3 nodes have it durably; losing any one node afterward still leaves a surviving copy. You do **not** need 4–8 drives for durable replicated writes.

Drive count starts to matter only if you erasure-code on three nodes, and the trap is the **ratio, not the raw count**. Shards spread across the 3 node-domains, so for whole-node-failure tolerance choose a ratio where total shards is a multiple of 3 and parity ≥ total/3:

- **RS 4+2** (6 shards, 2 per node) survives one node down — the natural 3-node EC.
- The standard **LRC ratios (10+4+2 = 16 shards, 12+3+3 = 18)** want ~16–18 drives across more domains; they are for *larger* clusters, not a 3-node minimum. On 3 nodes they would place 6 shards/node, and a node loss exceeds their fault-tolerance floor.

## 4. Larger, rack/zone-aware clusters

Label nodes with their physical topology so placement can spread across racks and zones, and use LRC (lower repair I/O) or a wide RS ratio. With enough domains, `strict` placement gives you rack- or zone-loss survival. This is where LRC's local-parity fast path (≈75% less I/O for single-shard repair) pays off.

## What each topology survives

| Topology | Crash / power-cut (with `fsync`) | Drive loss | Node loss | Rack / zone loss |
|---|:--:|:--:|:--:|:--:|
| Single node, 1 drive | ✅ | ❌ | ❌ | ❌ |
| Single node, N drives (EC) | ✅ | ✅ | ❌ | ❌ |
| 3 nodes (RF=3 or RS 4+2) | ✅ | ✅ | ✅ (1) | ❌ |
| Rack/zone-aware (labeled) | ✅ | ✅ | ✅ | ✅ |

:::note Roadmap
The upcoming **segment store** (Phase 28: a replicated group-commit journal that acks on a quorum of `fsync`'d log appends, with background flush to erasure-coded stripes) changes the *small-object* write path but not these minimums — the journal is replication-based (needs failure domains) and the settled EC tier still needs `k + m` drives. The failure-domain-vs-drive distinction on this page carries forward unchanged.
:::
