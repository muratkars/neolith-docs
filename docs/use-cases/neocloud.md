---
sidebar_position: 6
title: "Neocloud Multi-Region Storage"
---

# Neocloud Multi-Region Storage

A *neocloud* is a GPU-centric cloud built on a fleet of high-density NVMe storage servers spread across several US regions. The goal is an AWS S3-like service — the same API, the same "11 nines" durability promise, the same regional model — but running on your own hardware at a fraction of the cost.

This page shows how to map a neocloud's physical hierarchy onto Neolith's failure domains, how to choose erasure-coding (EC) schemes and EC set sizes, and — most importantly — gives you the **durability and storage-efficiency formulas with adjustable variables** so you can dial in the trade-off for each tier yourself.

## Reference topology

The analysis below assumes a topology of this shape (yours can be larger; these are the documented minimums):

```
Region   (≥ 4, US)              WAN-separated; highest correlated-failure boundary
  DC     (≥ 1 per region)       shared power / cooling / core network
    Rack (≥ 3 per DC)           shared ToR switch + PDU
      Server (≥ 3 per rack)     THE Neolith failure domain (the "node")
        NVMe  (≥ 24 per server) capacity + parallelism (High-Performance tier)
```

Mapping to Neolith's topology labels (`zone → rack → host → drive`, see [Deployment Topologies](../operations/deployment-topologies)):

| Physical unit | Neolith label | Role in durability |
|---|---|---|
| Region | (separate cluster) | Geo boundary — protected by [cross-site replication](../enterprise/replication), not EC |
| Datacenter | `zone` | Coarse spread domain inside a region |
| Rack | `rack` | ToR/PDU correlated-failure domain |
| Server | `host` | **The EC failure domain** — at most one shard per host |
| NVMe drive | `drive` | Stores shards; sets capacity and rebuild parallelism |

:::note The node is the failure domain
Unlike MinIO, where the **drive** is the failure domain, Neolith spreads each object's shards across **distinct hosts** (and, when labeled, distinct racks/zones). Your 24 drives per server are about capacity and rebuild throughput — *not* stripe width. One host holds shards from many thousands of different stripes across its drives. See [Erasure Coding](../architecture/erasure-coding) and [Deployment Topologies](../operations/deployment-topologies).
:::

## Recommended architecture

A neocloud spans regions, but the High-Performance NVMe tier cannot afford WAN latency on the write path. The recommended pattern is therefore **two layers of redundancy**:

1. **Intra-region erasure coding** for component durability and local performance. Every read and write stays inside the region and runs at full NVMe speed. A single `RS(8,4)` pool already delivers ~15 nines against independent component failures (see the formula below).
2. **Cross-region active-active replication** ([Neolith Enterprise](../enterprise/replication)) for *region-loss* protection and disaster recovery. Each region is its own EC cluster; buckets are asynchronously replicated to one or two peer regions with HLC-based last-writer-wins conflict resolution.

```
   Region us-east           Region us-west           Region us-central
 ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
 │  EC pool RS(8,4)  │ ⇄  │  EC pool RS(8,4)  │ ⇄  │  EC pool RS(8,4)  │
 │  local reads/     │     │  local reads/     │     │  local reads/     │
 │  writes @ NVMe    │     │  writes @ NVMe    │     │  writes @ NVMe    │
 └──────────────────┘     └──────────────────┘     └──────────────────┘
        async HLC replication (RPO > 0) across regions for DR
```

Why not one *stretched* cluster across regions? Because EC write quorum would then cross the WAN on every PUT, destroying High-Performance-tier latency. Reserve stretched/geo-EC layouts for a cold/capacity tier where WAN latency is acceptable.

## Sizing EC and EC sets for the topology

In Neolith an **EC set** is the set of `N = K + M` hosts that a given stripe lands on, chosen deterministically by tiered consistent hashing within a **pool** (a group of nodes + drives sharing one EC config). Two rules govern sizing.

### Rule 1 — enough hosts to place the stripe

With `placement_policy = "strict"`, a write is refused unless all `N = K + M` shards can land on distinct hosts. So the pool needs **at least `K + M` hosts**.

A minimal DC of 3 racks × 3 servers = **9 hosts cannot run `RS(8,4)`** (needs 12). Either shrink the scheme (`RS(4,2)`, `RS(6,3)`), grow the DC, or accept `placement_policy = "pack"` (which drops the spread guarantee — not recommended for a durability tier). For a comfortable `RS(8,4)` tier, target **≥ 4 racks × ≥ 4 servers = 16 hosts per pool.**

### Rule 2 — spread so a whole rack/DC loss stays within the parity budget

If a stripe of `N` shards is spread evenly across `D` domains at some level (e.g. racks), each domain holds at most `⌈N/D⌉` shards. To survive losing `g` whole domains **and** still tolerate `h` additional independent shard failures during the rebuild:

```
g · ⌈N/D⌉ + h  ≤  M
```

Worked for `RS(8,4)` (N=12, M=4) at the rack level:

| Racks (D) | Shards/rack ⌈N/D⌉ | Survives 1 rack loss? | Extra failures tolerated while rack is down (h) |
|---:|:---:|:---:|:---:|
| 3 | 4 | Yes — but **zero margin** (4 = M) | 0 |
| 4 | 3 | Yes | 1 |
| 6 | 2 | Yes | 2 |

**3 racks survives a rack outage with no headroom** — a single drive blip during the multi-hour rack rebuild causes data loss. **4+ racks is the practical minimum** for a rack-fault-tolerant tier.

## Durability formula (the control panel)

Per-stripe mean time to data loss (single-repair Markov approximation: loss occurs when `M+1` of `N` domains fail within one repair window):

```
              μ^M
MTTDL  ≈  ───────────────────────────         [years]
          C(N, M+1) · (M+1) · λ^(M+1)
```

Convert to the durability figure you quote to customers:

```
P_loss(object, year) ≈ 1 / MTTDL_stripe
nines                 = log10(MTTDL_stripe in years)
```

### Variables you adjust

| Variable | Symbol | Effect when increased | Typical range |
|---|:---:|---|---|
| Data shards | `K` | ↑ efficiency, ↑ rebuild I/O, needs more hosts | 4 – 16 |
| Parity shards | `M` | ↑ fault tolerance, ↓ efficiency | 2 – 4 |
| Total shards | `N = K + M` | hosts required per stripe | `K + M` |
| Effective shard failure rate | `λ` | ↓ durability; `λ ≈ AFR_drive + AFR_host` /year | 0.02 – 0.08 |
| Repair rate | `μ = 1 / MTTR` | ↑ durability **steeply** (enters as `μ^M`) | MTTR 2 – 24 h |
| Geo-replicas | `C` | ↑ region-loss protection, ÷ efficiency | 1 – 3 |
| Racks per pool | `D_rack` | governs rack-loss survival via Rule 2 | ≥ 4 |
| Placement policy | — | `strict` guarantees spread; `pack` favors availability | `strict` for durability tiers |

`C(N, M+1)` is the binomial coefficient ("number of ways `M+1` of `N` shards can fail").

### Worked example — `RS(8,4)`, host failure domain

Inputs: `λ = 0.04/yr` (≈ 1% drive AFR + 3% host AFR), `MTTR = 8 h` → `μ = 8760/8 = 1095/yr`.

```
μ^M        = 1095^4              ≈ 1.44e12
C(12,5)    = 792
(M+1)      = 5
λ^(M+1)    = 0.04^5              ≈ 1.02e-7
MTTDL      ≈ 1.44e12 / (792 · 5 · 1.02e-7)  ≈ 3.5e15 years per stripe
P_loss/yr  ≈ 2.8e-16            →  ~15 nines
```

:::tip Parity is not your binding constraint
`RS(8,4)` already clears ~15 nines against *independent* component failures — well past S3's 11. The real durability ceiling for a neocloud is set by **correlated and site-level failures** (rack/DC/region outages, operator error, software bugs), which this formula does **not** capture:

```
P_loss_total ≈ P_component + P_rack_corr + P_DC_corr + P_region_corr + P_operational
```

You drive each correlated term below target with the **spread constraint (Rule 2)** and with **cross-region replication** — not by piling on parity. And because `MTTDL ∝ μ^M`, *halving rebuild time on `RS(8,4)` raises durability ~16×* — faster [healing](../operations/healing) and LRC local repair buy more durability than extra parity, at zero space cost.
:::

## Storage efficiency formula

```
              K
   η  =  ───────────────          (usable ÷ raw capacity)
          C · (K + M)

   raw_per_usable_byte = C · (K + M) / K = C · (1 + M/K)
```

where `C` is the number of full geo-replicas (`C = 1` single region, `C = 2` one DR copy, …).

| Scheme | N = K+M | Local η | Overhead | η with `C=2` |
|---|---:|---:|---:|---:|
| `RS(4,2)` | 6 | 66.7% | 1.50× | 33.3% |
| `RS(8,3)` | 11 | 72.7% | 1.38× | 36.4% |
| **`RS(8,4)`** (default) | 12 | 66.7% | 1.50× | 33.3% |
| `RS(12,4)` | 16 | 75.0% | 1.33× | 37.5% |
| `RS(16,4)` | 20 | 80.0% | 1.25× | 40.0% |
| `LRC(12,3,3)` | 18 | 66.7% | 1.50× | — |

`RS(8,4)` and `RS(4,2)` have identical 66.7% efficiency, but `RS(8,4)` tolerates 4 failures (vs 2) and spreads thinner per host. LRC trades efficiency for ~75% less repair I/O (local-group reconstruction) — valuable at neocloud scale for taming rebuild storms, not for saving space.

## Recommended storage-class lineup

Erasure parameters resolve hierarchically (`storage_class > bucket > pool > global`), so you can offer S3-style storage classes that map to different points on the durability/efficiency curve:

```toml
# Global default — safe, fits pools of ≥ 12 hosts
[erasure]
codec         = "reed-solomon"
data_shards   = 8
parity_shards = 4

[cluster]
placement_policy = "strict"   # refuse writes that cannot spread; protects durability

# High-Performance default (≥ 4 racks × ≥ 4 servers per region)
[storage_class "HP-STANDARD"]
codec = "reed-solomon"; data_shards = 8;  parity_shards = 4   # 67%, ~15 nines local
# + replicate bucket to 1 peer region → ~33% net, survives region loss

# Minimal DCs (9–11 hosts): smaller stripe so it still spreads
[storage_class "HP-SMALL-DC"]
codec = "reed-solomon"; data_shards = 6;  parity_shards = 3   # 67%, fits 9 hosts

# Dense capacity tier (≥ 20 hosts/pool)
[storage_class "CAPACITY"]
codec = "reed-solomon"; data_shards = 12; parity_shards = 4   # 75%

# Archive — rebuild-I/O optimized at scale
[storage_class "ARCHIVE-LRC"]
codec = "lrc"; data_shards = 12; parity_shards = 3; local_parity = 3

# Maximum geo durability — 8+4 local + replicate to 2 peer regions (C=3)
[storage_class "CRITICAL"]
codec = "reed-solomon"; data_shards = 8;  parity_shards = 4   # ~22% net, survives 2 region losses
```

Configure cross-region replication per the [Replication & Tiering](../enterprise/replication) guide; size pools and racks per [Deployment Topologies](../operations/deployment-topologies); tune rebuild speed per [Healing](../operations/healing); and plan region-loss recovery per [Backup & DR](../operations/backup-dr).

## Summary

- Map **server → host** (the EC failure domain), **rack → rack**, **DC → zone**, and treat **region** as a separate cluster joined by replication.
- Run **intra-region `RS(8,4)`** for performance and ~15-nine component durability; add **cross-region async replication** for region-loss protection.
- Size pools to **`K + M` hosts minimum** and **≥ 4 racks** so a rack loss stays within the parity budget (Rule 2: `g·⌈N/D⌉ + h ≤ M`).
- Tune the trade-off with the durability formula `MTTDL ≈ μ^M / (C(N,M+1)·(M+1)·λ^(M+1))` and the efficiency formula `η = K / (C·(K+M))`.
- Remember the levers that cost no space: **faster rebuild (`μ`)** and **wider spread**, not more parity.
