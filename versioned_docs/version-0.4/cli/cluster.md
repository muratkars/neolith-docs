---
sidebar_position: 3
title: "Cluster Commands"
---

# Cluster Commands

The `neolith cluster` subcommand group provides read-only inspection of a running Neolith cluster's state. These commands connect to a Neolith server's Admin API and display cluster information without modifying any state.

## Common Options

All cluster commands accept:

| Option | Default | Env Var | Description |
|---|---|---|---|
| `--endpoint <URL>` | `http://localhost:9000` | `NEOLITH_ENDPOINT` | Server endpoint to connect to |
| `--output <FORMAT>` | `text` | N/A | Output format: `text` or `json` |

## `neolith cluster info`

Display server edition, version, and enabled features.

### Synopsis

```
neolith cluster info [--endpoint URL] [--output text|json]
```

### Text Output

```bash
$ neolith cluster info --endpoint http://node1:9000

  Edition: Neolith OSS
  Version: 0.4.0

  Nodes:      4
  Online:     4
  Local Node: https://node1.neolith.local:9000
  Partitions: 16384

Features:
  FEATURE                ENABLED  MIN EDITION
  s3-api                 yes      oss
  erasure-coding         yes      oss
  compression            yes      oss
  encryption             yes      oss
  batch-api              yes      oss
  etl-transforms         yes      oss
  object-versioning      yes      oss
  lifecycle-rules        yes      oss
  bucket-notifications   yes      oss
  web-console            yes      oss
  multi-tenancy          no       enterprise
  cross-site-replication no       enterprise
  oidc-federation        no       enterprise
  ldap-auth              no       enterprise
```

The features table shows which capabilities are available at each edition level. Features marked "no" in the ENABLED column require upgrading to a higher edition.

### JSON Output

```bash
$ neolith cluster info --endpoint http://node1:9000 --output json
```

```json
{
  "edition": "oss",
  "version": "0.4.0",
  "cluster": {
    "node_count": 4,
    "online_count": 4,
    "local_node_id": "https://node1.neolith.local:9000",
    "partitions": 16384
  },
  "features": [
    {
      "name": "s3-api",
      "enabled": true,
      "min_edition": "oss"
    },
    {
      "name": "erasure-coding",
      "enabled": true,
      "min_edition": "oss"
    }
  ]
}
```

### Single-Node Mode

When the server is running without cluster configuration, the cluster section is omitted:

```bash
$ neolith cluster info

  Edition: Neolith OSS
  Version: 0.4.0

  Single-node mode (no cluster)

Features:
  ...
```

## `neolith cluster status`

Display detailed cluster topology including all known nodes, their health state, and partition ownership.

### Synopsis

```
neolith cluster status [--endpoint URL] [--output text|json]
```

### Example

```bash
$ neolith cluster status --endpoint http://node1:9000
```

```json
{
  "nodes": [
    {
      "id": "https://node1.neolith.local:9000",
      "status": "online",
      "drives": ["/mnt/disk1", "/mnt/disk2", "/mnt/disk3", "/mnt/disk4"],
      "last_heartbeat": "2026-03-15T10:30:45Z"
    },
    {
      "id": "https://node2.neolith.local:9000",
      "status": "online",
      "drives": ["/mnt/disk1", "/mnt/disk2", "/mnt/disk3", "/mnt/disk4"],
      "last_heartbeat": "2026-03-15T10:30:44Z"
    }
  ]
}
```

### Node Status Values

| Status | Description |
|---|---|
| `online` | Node is healthy and serving requests |
| `offline` | Node is unreachable (missed heartbeats) |
| `decommissioning` | Node is draining data before removal |
| `suspect` | Node heartbeat is delayed but not yet timed out |

### How Topology Works

Neolith uses a static peer list defined in the TOML configuration. Each node periodically polls its peers via HTTP/2 heartbeat requests on the `/_neolith/v1/topology` RPC endpoint. The topology includes:

- **Node list**: All known nodes with their health status.
- **Partition map**: TCH (Table of Content Hashing) assigns 16,384 partitions across nodes using HRW (Highest Random Weight) for balanced distribution with failure-domain spread.
- **Topology version**: Incremented on node add/remove or status change, used for split-brain detection.

### Split-Brain Detection

The `cluster status` output can reveal split-brain conditions. If two node groups have divergent topology versions or non-overlapping online node sets, Neolith detects and logs a split-brain warning. The `merge_topologies` procedure unions node sets, takes the higher version for status conflicts, and sets `version = max + 1`.

## Usage in Scripts

Combine `--output json` with `jq` for scripted health checks:

```bash
# Check all nodes are online
OFFLINE=$(neolith cluster status --output json | \
  jq '[.nodes[] | select(.status != "online")] | length')

if [ "$OFFLINE" -gt 0 ]; then
  echo "WARNING: $OFFLINE nodes are not online"
  exit 1
fi

# Get node count
NODE_COUNT=$(neolith cluster info --output json | jq '.cluster.node_count')
echo "Cluster has $NODE_COUNT nodes"
```

## API Endpoints

The cluster commands use these Admin API endpoints:

| Command | Method | Endpoint |
|---|---|---|
| `cluster info` | GET | `/_neolith/v1/info` |
| `cluster status` | GET | `/_neolith/admin/v1/nodes` |
