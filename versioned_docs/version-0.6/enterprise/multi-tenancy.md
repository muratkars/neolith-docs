---
sidebar_position: 2
title: "Multi-Tenancy & QoS"
---

# Multi-Tenancy & QoS

Neolith Enterprise provides first-class multi-tenancy with cryptographic tenant isolation, per-tenant QoS guarantees, and blast-radius containment. Multi-tenancy is not an afterthought bolted onto IAM policies: it is built into the storage engine's routing, scheduling, and resource management layers.

## Architecture

Multi-tenancy spans two Enterprise crates:

- **neolith-catalog**: Manages the tenant and cell catalog, mapping tenants to storage cells and enforcing isolation boundaries.
- **neolith-proxy**: The gateway proxy that routes requests, enforces QoS policies, and provides admission control.

```
Client Request
      |
      v
┌─────────────────┐
│  neolith-proxy   │  <-- Rate limiting, QoS scheduling, admission control
│  (Gateway Proxy) │
└────────┬────────┘
         |
         v
┌─────────────────┐
│ neolith-catalog  │  <-- Tenant lookup, cell routing, quota enforcement
│ (Tenant/Cell DB) │
└────────┬────────┘
         |
         v
┌─────────────────┐
│  neolith-server  │  <-- Storage engine (OSS core)
│  (Storage Node)  │
└─────────────────┘
```

## Tenant Catalog

The tenant catalog maintains the mapping between tenants and their assigned storage resources. Each tenant is an isolated entity with its own:

- **Namespace**: Buckets are scoped to the tenant. Two tenants can have buckets with the same name without conflict.
- **Encryption domain**: Per-tenant master key derivation ensures one tenant's data cannot be decrypted with another tenant's keys.
- **Storage cells**: A cell is a subset of cluster nodes assigned to a tenant. Cells provide failure-domain isolation: a misbehaving tenant's workload cannot impact other tenants' I/O.

```toml
# Example tenant configuration
[tenant.acme-corp]
id = "tn_01HQXYZ..."
cells = ["cell-us-east-1a", "cell-us-east-1b"]
max_buckets = 1000
max_storage_bytes = 10_995_116_277_760  # 10 TiB
encryption_key_id = "kms://keys/acme-corp-master"
```

### Cell Architecture

A cell is a logical grouping of storage nodes. Cells provide:

1. **Resource isolation**: Each cell has dedicated I/O bandwidth and CPU scheduling.
2. **Failure domain separation**: A cell maps to a rack, availability zone, or region, ensuring tenant data survives infrastructure failures.
3. **Independent scaling**: Cells can be grown or shrunk without affecting other tenants.

The catalog tracks cell membership, health, and capacity. When a tenant approaches their cell's capacity, the catalog can trigger automatic cell expansion or alert operators.

## HMAC-Based Tenant Routing

Neolith uses the TCH (Topology-Consistent Hashing) algorithm for data placement. In multi-tenant mode, tenant routing is integrated into TCH:

1. The request's tenant ID is extracted from the authentication context (SigV4 access key prefix or OIDC token claim).
2. The tenant ID is used to look up the assigned cell(s) in the catalog.
3. TCH computes `BLAKE3(bucket/key) mod 16384` to determine the partition, then uses HRW (Highest Random Weight) node selection within the tenant's cell.

This ensures that tenant data is placed only on nodes within the tenant's assigned cells, providing physical isolation without dedicated clusters.

## QoS (Quality of Service)

The neolith-proxy gateway enforces QoS at multiple levels:

### Rate Limiting

Per-tenant rate limits are enforced at the gateway proxy before requests reach the storage engine:

| Limit Type | Scope | Default | Configurable |
|---|---|---|---|
| Requests per second | Per tenant | 10,000 | Yes |
| Bandwidth (ingress) | Per tenant | 10 Gbps | Yes |
| Bandwidth (egress) | Per tenant | 10 Gbps | Yes |
| Concurrent requests | Per tenant | 1,000 | Yes |
| LIST requests/sec | Per tenant | 500 | Yes |

Rate limits use a token bucket algorithm with burst allowance. When a tenant exceeds their rate limit, the proxy returns `429 Too Many Requests` with a `Retry-After` header.

### Request Admission Control

The proxy implements admission control to prevent cluster overload:

1. **Queue depth monitoring**: Each storage node reports its pending I/O queue depth.
2. **Admission decisions**: When aggregate queue depth exceeds a threshold, the proxy begins shedding low-priority requests.
3. **Priority classes**: Requests are classified as critical (health checks, admin), high (read), normal (write), or low (list, lifecycle). Shedding starts with low-priority requests.

### Resource Quotas

Tenants have configurable resource quotas enforced by the catalog:

| Quota | Description |
|---|---|
| `max_storage_bytes` | Maximum total storage consumed across all buckets |
| `max_buckets` | Maximum number of buckets |
| `max_objects_per_bucket` | Maximum objects in a single bucket |
| `max_object_size` | Maximum size of a single object |
| `max_versions_per_object` | Maximum version history depth |
| `max_bandwidth_bps` | Maximum aggregate bandwidth |

Quota enforcement is atomic: the catalog checks quota availability before acknowledging a write. If the write would exceed a quota, the proxy returns `403 QuotaExceeded`.

### Overload Protection

When the cluster is under extreme load, the proxy activates overload protection:

1. **Backpressure**: The proxy reduces its accept rate, causing clients to see connection delays rather than errors.
2. **Circuit breaking**: If a storage node becomes unresponsive, the proxy stops routing to it and redistributes load.
3. **Graceful degradation**: Under severe load, the proxy may disable non-essential features (e.g., read-repair, background scanning) to preserve core read/write throughput.

## Tenant Isolation Guarantees

| Isolation Type | Mechanism |
|---|---|
| **Namespace** | Tenant-scoped bucket names, no cross-tenant visibility |
| **Data** | Cell-based node assignment, physical separation |
| **Encryption** | Per-tenant key derivation, independent encryption domains |
| **Performance** | Rate limiting, QoS scheduling, admission control |
| **Failure** | Cell boundaries contain blast radius |
| **Network** | Optional VLAN/network policy per cell (K8s Operator) |

## Configuration

Multi-tenancy is enabled in the server configuration:

```toml
[enterprise.multi_tenancy]
enabled = true
default_tenant = "default"
tenant_header = "x-neolith-tenant-id"

[enterprise.qos]
enabled = true
default_rps = 10000
default_bandwidth_bps = 10_000_000_000
admission_queue_depth_threshold = 5000
```

Tenant definitions can be managed via the Admin API or the Web Console:

```bash
# Create a tenant via Admin API
curl -X PUT http://localhost:9000/_neolith/admin/v1/tenants/acme-corp \
  -H "Content-Type: application/json" \
  -d '{
    "max_buckets": 1000,
    "max_storage_bytes": 10995116277760,
    "cells": ["cell-us-east-1a"],
    "rate_limit_rps": 5000
  }'
```
