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

**Throughput option for regenerable data:** on a local/scratch deployment whose data is regenerable (training scratch, intermediate data, dev/test, a cache), you can set `fsync = false` to trade the power-fail guarantee for substantially higher write throughput — large-object PUT can be several times faster. It does **not** affect process-crash safety (only power/OS-crash), so for jobs you'd restart after a power loss anyway it's often the right call. Never use it for primary data. See [Durability](./configuration.md#durability) for the full trade-off.

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

## Single-datacenter durability: a worked example

The minimums above tell you *what survives*. This section works out *how many nines* a common single-DC build actually delivers, and why a single site caps the result no matter how wide your erasure code is. For the underlying durability formula (`MTTDL` and the conversion to nines) see [Neocloud Multi-Region Storage](../use-cases/neocloud#durability-formula-the-control-panel).

**The build:** one datacenter, 3 racks x 3 servers = **9 hosts**, 12 NVMe drives each, scheme **RS(8,4)** (12 shards, tolerates 4 losses).

### Step 1: check the placement fit first

RS(8,4) is a 12-wide stripe, but you have only 9 hosts, and the **host is the failure domain** (one shard per host). 12 shards cannot be placed one-per-host on 9 hosts:

- `placement_policy = "strict"` **refuses to start** (it needs at least `data_shards + parity_shards` = 12 hosts).
- `placement_policy = "pack"` runs but stacks **2 shards on 3 of the hosts**, so a single server failure can cost 2 of the 12 shards.
- With 3 racks the 12 shards spread **4 per rack**, so losing one rack removes exactly 4 = M shards: you survive a rack outage with **zero margin** (any further drive or host failure during the rack-down window is data loss).

So this layout delivers RS(8,4) only in its weakest geometry. The numbers below reflect that.

### Step 2: durability by failure mode

Estimates use these assumptions (tune them for your hardware): NVMe drive AFR 1%/yr, whole-server AFR 3%/yr, rack-level (ToR/PDU) 2%/yr, repair time 8 h (drive) to 24 h (host/rack), and a single-facility catastrophic-loss rate of 0.1%/yr.

| Failure mode | What the layout tolerates | Approx. durability |
|---|---|---:|
| Independent **drive** failures | any 4 of the 12 shard-drives | ~18 nines |
| **Host** (server) failures | ~2 servers (the 2-shard hosts = 4 shards) | ~7 nines |
| **Rack** failures | 1 rack (4 shards = M, **zero margin**) | ~5.5 nines |
| **Datacenter** catastrophe | nothing (no copy elsewhere) | ~3 nines |

### Step 3: combine

Durability is dominated by the weakest term:

```
P_loss_total ~= P_DC + P_rack + P_host + P_drive
             ~= 1e-3 + 3e-6 + 5e-8 + 3e-19
             ~= 1e-3
```

- **End-to-end (honest, advertisable): ~3 nines.** The single datacenter sets the ceiling.
- **Hardware-only, assuming the building survives: ~5 nines**, limited by the 3-rack zero-margin geometry, not the drives. The drives alone would give ~18 nines.

The 4-parity erasure code is doing ~18-nine work against drive failures, but it is throttled down to ~5 by the rack layout and to ~3 by the single site. A single facility cannot exceed roughly 4 to 5 nines of durability regardless of stripe width, which is the same reason AWS S3 spreads every object across 3 or more Availability Zones.

### Step 4: how to improve it

| Change | Effect |
|---|---|
| **4 racks x 3 servers = 12 hosts** | RS(8,4) now fits one shard per host (`strict` works); 3 shards/rack means a rack loss leaves margin 1, not 0. Hardware durability rises to ~9-10 nines. |
| **Add a second site** (even same metro) | Removes the ~3-nine datacenter ceiling and reaches 11+ nines. The only way past ~5 nines. See [Replication & Tiering](../enterprise/replication). |
| **Add drives only** (to existing 9 hosts) | Adds capacity but **no** failure domains: durability is unchanged. Capacity and durability scale on different axes. |

Bottom line: as specified (3 racks, 9 hosts, single DC, 8:4) you are at **~3 nines** end-to-end, ~5 if you count hardware only and trust the building. Going to **4 racks / 12 hosts** is nearly free and lifts hardware durability to ~9-10 nines; reaching S3-grade 11 nines requires at least one more independent site.

:::note Roadmap
The upcoming **segment store** (Phase 28: a replicated group-commit journal that acks on a quorum of `fsync`'d log appends, with background flush to erasure-coded stripes) changes the *small-object* write path but not these minimums — the journal is replication-based (needs failure domains) and the settled EC tier still needs `k + m` drives. The failure-domain-vs-drive distinction on this page carries forward unchanged.
:::
