---
sidebar_position: 3
title: "Replication & Tiering"
---

# Replication & Tiering

Neolith Enterprise provides active-active cross-site replication and intelligent data tiering to meet durability, performance, and cost requirements across multi-site and multi-tier deployments.

## Active-Active Replication

Unlike primary-secondary replication models where writes go to a single site, Neolith Enterprise supports active-active replication. Both sites accept writes simultaneously, and conflicts are resolved using Hybrid Logical Clocks (HLC).

### How It Works

1. **Write path**: When an object is written to Site A, the storage engine assigns an HLC timestamp and replicates the object metadata and data to Site B asynchronously.
2. **Conflict resolution**: If the same key is written to both sites concurrently, the HLC timestamp determines the winner. The write with the higher HLC timestamp (most recent physical + logical clock) wins. This is a Last-Writer-Wins (LWW) policy.
3. **Convergence**: Both sites eventually converge to the same state. The replication protocol ensures that all writes are delivered at least once, and HLC ordering ensures deterministic conflict resolution.

```
Site A (US-East)                    Site B (EU-West)
┌──────────────┐                   ┌──────────────┐
│ Neolith Node │ <── replicate ──> │ Neolith Node │
│  HLC: T1     │                   │  HLC: T2     │
│              │                   │              │
│ PUT obj1 @T3 │ ──────────────>   │ recv obj1 @T3│
│              │   <──────────────  │ PUT obj1 @T4 │
│ conflict:    │                   │ conflict:     │
│ T4 > T3, T4  │                   │ T4 > T3, T4  │
│ wins         │                   │ wins          │
└──────────────┘                   └──────────────┘
```

### HLC Timestamps

Neolith uses a 64-bit Hybrid Logical Clock:
- **48 bits**: Physical time (milliseconds since epoch, good for ~8900 years)
- **16 bits**: Logical counter (65536 events per millisecond)

HLC timestamps are stored in `ObjectMeta.hlc_timestamp` and propagated via the `x-neolith-hlc` header in replication RPC calls. Every node maintains a monotonic HLC using `AtomicU64` for lock-free reads.

### Replication RPC Protocol

Replication uses the same HTTP/2 transport as all other Neolith communication (single port 9000):

- **Endpoint**: `POST /_neolith/v1/replicate/{bucket}/{key}`
- **Body**: `[meta_bytes | data_bytes]` concatenated
- **Headers**:
  - `x-neolith-meta-size`: Byte length of the metadata prefix (demarcation between meta and data)
  - `x-neolith-hlc`: HLC timestamp of the write
- **Delete replication**: `DELETE /_neolith/v1/replicate/{bucket}/{key}` with `x-neolith-hlc` header. The receiving node only deletes if the incoming HLC is greater than the stored HLC (LWW delete).

### Configuration

```toml
[enterprise.replication]
enabled = true
mode = "active-active"  # or "active-passive"

[[enterprise.replication.sites]]
name = "us-east"
endpoint = "https://neolith-us-east.example.com:9000"
access_key = "REPL_ACCESS_KEY"
secret_key = "REPL_SECRET_KEY"

[[enterprise.replication.sites]]
name = "eu-west"
endpoint = "https://neolith-eu-west.example.com:9000"
access_key = "REPL_ACCESS_KEY"
secret_key = "REPL_SECRET_KEY"

[enterprise.replication.policy]
async_replication = true
max_replication_lag_seconds = 60
retry_interval_seconds = 5
max_retries = 10
```

## Data Tiering

Neolith Enterprise's data tiering engine (`neolith-tier`) automatically moves data between storage tiers based on access patterns, age, and configurable policies.

### Tier Architecture

The tiering system consists of three components:

| Component | Role |
|---|---|
| `TierClient` | Client interface for tier transitions, communicates with storage backends |
| `TierScanner` | Background task that evaluates objects against tiering rules and schedules transitions |
| `TierStub` | Stub/placeholder for objects that have been tiered to cold storage, enabling transparent recall |

### Storage Tiers

| Tier | Typical Media | Use Case | Access Latency |
|---|---|---|---|
| **Hot** | NVMe SSD | Active datasets, ML training, frequent reads | < 1 ms |
| **Warm** | SATA SSD / HDD | Infrequent access, cost optimization | 1-10 ms |
| **Cold** | Cloud storage / tape | Archival, compliance retention | 100 ms - minutes |

### Tiering Policies

Tiering rules are defined per bucket and evaluated by the TierScanner:

```toml
[enterprise.tiering]
enabled = true
scan_interval_hours = 6

[[enterprise.tiering.rules]]
name = "hot-to-warm"
source_tier = "hot"
destination_tier = "warm"
condition = "last_access_age > 30d"
min_object_size = "1MiB"

[[enterprise.tiering.rules]]
name = "warm-to-cold"
source_tier = "warm"
destination_tier = "cold"
condition = "last_access_age > 90d"

[[enterprise.tiering.rules]]
name = "cold-recall"
source_tier = "cold"
destination_tier = "hot"
condition = "on_access"  # Transparent recall on GET
```

### Tier Transition Flow

1. **TierScanner** runs as a background task, scanning object metadata at a configurable interval.
2. For each object, it evaluates the tiering rules in order. If a rule matches (e.g., last access was 45 days ago and the rule threshold is 30 days), the scanner schedules a transition.
3. The **TierClient** executes the transition: it reads the object from the source tier, writes it to the destination tier, and updates the metadata to reflect the new location.
4. For cold-tier transitions, a **TierStub** is left in the hot/warm tier. The stub contains enough metadata to locate and recall the object transparently.
5. When a GET request hits a TierStub, the system transparently recalls the object from cold storage. The object is served to the client and optionally promoted back to a warmer tier.

### Cross-Site Data Protection

Combining replication with tiering enables sophisticated data protection strategies:

- **Active-active + tiering**: Both sites independently tier data based on local access patterns. A hot object in US-East might be warm in EU-West if European users access it less frequently.
- **Disaster recovery**: Cold-tier data replicated to a remote site provides cost-effective DR without maintaining full hot copies at both sites.
- **Compliance**: Tiering policies can enforce data residency by restricting which tiers (and therefore which physical locations) are available for specific tenants or buckets.

### Monitoring

Tiering metrics are exposed via Prometheus:

| Metric | Description |
|---|---|
| `neolith_tier_transitions_total` | Total tier transitions by source/destination |
| `neolith_tier_bytes_migrated_total` | Total bytes moved between tiers |
| `neolith_tier_recall_latency_seconds` | Cold-tier recall latency histogram |
| `neolith_tier_scanner_duration_seconds` | Time to complete a full tiering scan |
| `neolith_tier_stub_count` | Number of TierStub objects per tier |
