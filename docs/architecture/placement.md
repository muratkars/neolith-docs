---
sidebar_position: 5.5
title: Placement and Durability
---

# Placement and Durability

Neolith spreads each object's shards across failure domains so that losing a
whole domain (a drive, a node, a rack, or a zone) does not lose data. Placement
stays deterministic and coordinator-free: every node computes the same
assignment from the same gossiped topology. This page covers how you choose the
domain to tolerate, how placement adapts to cluster shape, how reads stay
correct across topology changes, and how to migrate data onto a better spread
after you add capacity.

For the underlying hashing (partitions, HRW node selection), see
[Cluster Topology](./cluster.md).

## The tolerate target

`[placement] tolerate` declares the failure-domain level shards must spread
across to survive losing one domain:

| Level | Meaning | Edition |
| --- | --- | --- |
| `auto` | Coarsest level with enough distinct instances (default) | OSS |
| `drive` | Distinct drives (`drive:N` caps shards per node) | OSS |
| `node` | Distinct nodes | OSS |
| `rack` | Distinct racks | Enterprise |
| `zone` | Distinct zones | Enterprise |

```toml
[placement]
tolerate = "auto"
```

`auto` picks the coarsest level that has at least `parity + 1` distinct
instances (so the cluster survives losing one domain at that level), and on the
OSS edition it never selects `rack` or `zone`. On an unlabeled single-node box it
resolves to `drive`; on a multi-node cluster it resolves to `node`.

`tolerate` chooses *which* level is enforced. What happens when the level cannot
be met is set by the cluster placement policy (below).

## Failure-domain labels

In a multi-node cluster, declare each node's domains with `[[cluster.nodes]]`.
When present it supersedes `peers`: each node lists its `zone`, `rack`, and
`drives`, so placement can spread across racks and zones and across distinct
drives within a node. The local node is the entry whose `advertise` matches the
node's own.

```toml
[cluster]
advertise = "http://node1:9000"
placement_policy = "strict"

[[cluster.nodes]]
advertise = "http://node1:9000"
zone = "us-east-1a"
rack = "r1"
drives = ["/mnt/d1", "/mnt/d2"]

[[cluster.nodes]]
advertise = "http://node2:9000"
zone = "us-east-1a"
rack = "r2"
drives = ["/mnt/d1", "/mnt/d2"]
```

Without labels every node has an empty domain, so spread degenerates to
"distinct nodes" (the historical behavior). Labels are the prerequisite for
rack- and zone-level isolation.

## Budgeted spread and balanced fill

For a scheme with `T` total shards (`data + parity`) over `D` domains at the
enforced level, placement caps each domain at `ceil(T / D)` shards and never
lets a single domain hold more than the parity budget (so losing one domain
never takes more than `parity` shards). Leftover shards after the budgeted pass
go to the least-loaded domain, which converges to an even split: 12 shards over
3 racks lands 4 / 4 / 4, not 6 / 3 / 3. Selection stays HRW-deterministic, so a
topology change still reshuffles only about `1 / (N + 1)` of partitions.

## Pack vs strict

When the enforced level cannot be met (too few domains for the scheme), the
cluster `placement_policy` decides:

- **`strict`** refuses the write with `507 Insufficient Storage`, and a startup
  guardrail fails fast when the scheme, cluster size, and `tolerate` target are
  unsatisfiable. Misconfiguration is caught at boot, not at first data loss.
- **`pack`** (default) places anyway with reduced fault isolation and records
  the partition as under-protected so it is visible and recoverable later.

## Reads stay correct across topology changes

Object metadata records the erasure layout but not node locations, so reads
recompute placement. To keep that correct when the cluster changes shape,
Neolith stamps each partition with the cluster epoch and persists a
deterministic topology snapshot per epoch. Reads resolve placement over the
partition's *pinned* snapshot rather than the live topology, so adding or
removing a node does not mislocate existing data. Until a partition has been
stamped, reads fall back to recomputing over the live topology (identical to the
historical behavior), and read-repair plus HLC remain the safety net for the
residual cross-epoch window. Snapshots are derived from the gossiped topology,
so they are identical on every node and need no extra coordination.

## Observing protection

`GET /_neolith/admin/v1/placement/protection` reports how many tracked
partitions are under-protected (a single failure domain holds more shards than
the fault-tolerance budget), with the achieved tolerance level and a bounded
sample. It also lists **re-spread candidates**: under-protected partitions that
the current topology could now place better, for example after you add a rack.

## Re-spread: migrating onto a better placement

When you add failure domains, existing data stays where it was placed until you
re-spread it. Trigger a node-local re-spread pass with the rebalance API:

```bash
neolith admin rebalance start
neolith admin rebalance status
neolith admin rebalance stop
```

`rebalance start` migrates under-protected partitions onto their improved
placement. It is **loss-free by construction**: each object is copied up to its
new placement and confirmed at write quorum *before* the partition's epoch is
advanced to serve reads from the new placement. No copy is removed during this
pass, so an interrupted migration leaves reads on the old placement and a re-run
resumes safely. `rebalance status` reports objects moved and completion. When
there are no under-protected, now-fixable partitions, the pass is a no-op.

## OSS vs Enterprise

`drive`, `drive:N`, and `node` tolerance are available in OSS. `rack` and `zone`
tolerance are Enterprise features (matching rack-aware placement); under OSS,
`strict` refuses a `rack`/`zone` target and `auto` never selects them.

## Reference topologies

- **Single node, many drives** (`tolerate = "drive"`): shards land on distinct
  drives; tolerates losing any `parity` drives. No node-loss protection (one
  node).
- **Multi-node, one rack** (`tolerate = "node"` or `auto`): shards on distinct
  nodes; tolerates losing any `parity` nodes.
- **Three or more racks** (`tolerate = "rack"`, Enterprise): shards budgeted
  across racks (`<= ceil(T / racks)` and `<= parity` per rack) with at least
  `parity + 1` racks; tolerates losing a full rack. With fewer racks, `strict`
  refuses and `pack` records under-protection.

See [Deployment Topologies and Minimums](../operations/deployment-topologies.md)
for drive and node minimums per topology.
