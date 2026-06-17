---
sidebar_position: 5
title: Cluster Topology
---

# Cluster Topology

Neolith uses a symmetric peer-to-peer architecture for clustering. Every node computes placement independently using the same deterministic algorithm, requiring no coordinator or consensus protocol.

## Tiered Consistent Hashing (TCH)

TCH is Neolith's data placement algorithm. It determines which nodes and drives store each object's shards.

### Partition Space

The key space is divided into 16,384 fixed partitions:

```
partition = BLAKE3(bucket + "/" + key) mod 16384
```

Each partition is assigned to a set of nodes using Highest Random Weight (HRW) hashing. Every node computes the same assignment independently.

### HRW Node Selection

For a given partition, each node is scored using HRW:

```
score(partition, node) = BLAKE3(partition || node_id)
```

Nodes are sorted by score in descending order. The top N nodes (where N = K + M for erasure coding) are selected to store shards for that partition.

HRW has a critical advantage over consistent hashing rings: when a node is added or removed, only ~1/N of the partitions are reassigned. This minimizes data movement during cluster expansion.

### Failure-Domain Awareness

TCH respects failure domains to ensure shards are spread across independent failure boundaries. Three levels of failure domain are supported:

| Level | Example | Purpose |
|-------|---------|---------|
| Zone | `us-east-1a` | Survive availability zone failure |
| Rack | `rack-07` | Survive rack switch/power failure |
| Host | `node-03` | Survive individual server failure |

When selecting nodes for a partition, TCH applies failure-domain constraints:

1. Sort all nodes by HRW score (highest first)
2. Select the top-scoring node
3. For each subsequent node, skip it if adding it would violate the constraint (e.g., two nodes in the same rack when `rack` is the failure domain)
4. Continue until N nodes are selected

This ensures that no two shards of the same object land in the same failure domain.

### Drive Selection

Within a selected node, shards are assigned to drives using a secondary HRW hash:

```
drive_score(partition, shard_index, drive_id) = BLAKE3(partition || shard_index || drive_id)
```

This distributes shards evenly across drives within a node and ensures deterministic placement.

## Peer Discovery

Neolith uses static TOML configuration for peer discovery:

```toml
[cluster]
node_id = "node-01"
listen = "0.0.0.0:9000"

[[cluster.peers]]
node_id = "node-02"
endpoint = "http://10.0.1.2:9000"
zone = "us-east-1b"
rack = "rack-02"

[[cluster.peers]]
node_id = "node-03"
endpoint = "http://10.0.1.3:9000"
zone = "us-east-1c"
rack = "rack-03"
```

Each node's configuration lists all other nodes in the cluster. Nodes do not need to discover each other dynamically - the topology is defined at deployment time.

## Heartbeat and Health

Nodes monitor each other via periodic heartbeat polling:

### Topology Endpoint

Each node exposes `/_neolith/v1/topology` which returns the node's view of the cluster:

```json
{
  "version": 42,
  "nodes": [
    {
      "node_id": "node-01",
      "endpoint": "http://10.0.1.1:9000",
      "status": "online",
      "zone": "us-east-1a",
      "rack": "rack-01",
      "drives": ["/mnt/disk1", "/mnt/disk2"]
    }
  ]
}
```

### Health Polling

Each node polls its peers at a configurable interval (default: 5 seconds):

1. Send GET to `/_neolith/v1/topology` on each peer
2. If the peer responds, mark it as `online`
3. If the peer fails to respond after a timeout (default: 3 seconds), mark it as `suspect`
4. After multiple consecutive failures (default: 3), mark it as `offline`

### Topology Version

The `ClusterTopology` maintains a monotonically increasing version number. The version bumps on:

- Node added to the cluster
- Node removed from the cluster
- Node status change (online/suspect/offline)

Nodes compare topology versions during heartbeat to detect and reconcile divergent views.

## Cluster Operations

### Scale-Out (Adding Nodes)

When a new node is added to the cluster:

1. Update the TOML configuration on all nodes to include the new peer
2. TCH automatically recomputes partition assignments
3. Only ~1/N of partitions need to move to the new node
4. The rebalance process moves shards in the background

### Scale-In (Removing Nodes)

When a node is decommissioned:

1. Mark the node as `decommissioning` via the admin API
2. The rebalance process moves all shards from the decommissioning node to remaining nodes
3. Once all data is migrated, the node can be safely removed
4. Update the TOML configuration on remaining nodes

### Rebalance

The rebalance process runs in the background and moves shards to match the ideal TCH placement:

- **Throttled**: Configurable I/O rate to avoid impacting production traffic
- **Resumable**: Progress is tracked and survives restarts
- **Atomic**: Each shard is moved atomically (write to destination, verify, delete from source)

### Pool Management

Drives are organized into storage pools via `PoolStore`:

```json
{
  "pools": [
    {
      "id": "pool-01",
      "drives": ["/mnt/disk1", "/mnt/disk2"],
      "status": "active"
    },
    {
      "id": "pool-02",
      "drives": ["/mnt/disk3", "/mnt/disk4"],
      "status": "read_only"
    }
  ]
}
```

Pool status can be:

| Status | Behavior |
|--------|----------|
| `active` | Reads and writes |
| `read_only` | Reads only, no new writes |
| `decommissioning` | Reads only, data being migrated out |

Pool configuration is stored in `.neolith/pools.json` and managed via the admin API.

## Network Protocol

Inter-node communication uses HTTP/2 over the same port (9000) as client traffic:

### RPC Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/_neolith/v1/topology` | GET | Heartbeat and topology exchange |
| `/_neolith/v1/replicate/{bucket}/{key}` | PUT | Write replication |
| `/_neolith/v1/replicate/{bucket}/{key}` | DELETE | Delete replication |
| `/_neolith/v1/shard/{bucket}/{key}/{shard}` | GET | Shard read (for repair) |

### Replication Protocol

Write replication uses a compact binary format:

- Body: `[meta_bytes | data_bytes]` concatenated
- `x-neolith-meta-size` header: byte offset where meta ends and data begins
- `x-neolith-hlc` header: HLC timestamp for causal ordering

The RPC client (`RpcClient`) uses `reqwest` with HTTP/2, connection pooling, and optional mTLS via `reqwest::Identity`.
