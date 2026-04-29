---
sidebar_position: 10
title: "S3 over RDMA / RoCEv2"
sidebar_label: "RDMA / RoCEv2"
---

# S3 over RDMA / RoCEv2

Neolith Enterprise v0.6 introduces an optional RDMA data plane that lets compatible clients move object payloads at wire speed — bypassing the CPU copy overhead of the TCP/IP stack for PUT and GET operations. The S3 control plane (authentication, bucket operations, metadata) always travels over HTTP; only the object payload benefits from RDMA.

:::info Enterprise feature
RDMA requires an **Enterprise** or **AI** edition license and a Linux host with a RoCEv2-capable NIC. All other platforms compile and run normally using the TCP fallback.
:::

## How It Works

Neolith uses a **dual-transport architecture**:

```
Client                         Neolith Cell (Enterprise)
  │                                       │
  │  PUT /bucket/key  (HTTP headers)      │
  │──────────────────────────────────────>│
  │                                       │
  │  x-neolith-rdma-connection-id: <uuid> │
  │  x-neolith-rdma-rkey: <uint32>        │
  │  x-neolith-rdma-addr: <uint64 hex>    │
  │  x-neolith-rdma-len:  <uint64>        │
  │                                       │
  │       ← RDMA READ (IBV_WR_RDMA_READ) ─│ (server pulls from client MR)
  │                                       │
  │  HTTP 200 OK  (no body transfer)      │
  │<──────────────────────────────────────│
```

For **PUT** (upload): the server issues an **RDMA READ** to pull data from the client's pre-registered memory region into its own buffers — the object payload never travels over TCP.

For **GET** (download): the server issues an **RDMA WRITE** to push data directly into the client's memory — the response body is empty.

When RDMA headers are absent or conditions are not met (object too small, transport error with `fallback_to_tcp = true`), Neolith falls back to the normal HTTP body path transparently. Clients receive the same S3 API semantics regardless of which transport was used.

## Prerequisites

### Hardware

| Component | Requirement |
|---|---|
| NIC | Mellanox/NVIDIA ConnectX-4 Lx or newer (RoCEv2 capable) |
| Kernel | Linux 5.4+ with `ib_core`, `rdma_ucm`, `mlx5_core` |
| User-space | `libibverbs-dev`, `rdma-core`, `ibverbs-providers` |
| Fabric | RoCEv2 requires Priority Flow Control (PFC) and ECN on switch ports |

ConnectX-3 and older NICs support only RoCEv1 (non-routable L2). RoCEv2 is strongly recommended for any network with multiple switches.

### Network Requirements

RoCEv2 is UDP-encapsulated and routable, but it is **not loss-tolerant by design**. Configure your switch fabric before enabling RDMA:

1. **Priority Flow Control (PFC)** — prevent packet drops on RDMA priority queues:
   ```
   # Cumulus Linux example (priority 3 = RDMA)
   net add interface swp1 pfc priority 3
   net add interface swp1 pfc tx on rx on
   ```

2. **Explicit Congestion Notification (ECN)** — signal congestion without drops:
   ```
   # Cumulus Linux example
   net add qos marking dscp 26 cos 3
   net add interface swp1 ecn mode on
   ```

3. **DCQCN** — most ConnectX NICs implement DCQCN congestion control automatically. Verify with `mlnx_qos -i <interface>`.

4. **MTU** — set jumbo frames (9000 bytes) end-to-end for best performance:
   ```bash
   ip link set eth1 mtu 9000
   ```

Without PFC, RDMA traffic will experience retransmissions and queue pair errors that force fallback to TCP.

## Enabling RDMA

### Step 1 — Verify Hardware

Before enabling RDMA, verify that the NIC and kernel drivers are working:

```bash
# List RDMA devices
ibv_devices

# Query device capabilities
ibv_devinfo -d mlx5_0

# Check GID table (find RoCEv2 entries)
show_gids

# Verify port state is ACTIVE
ibv_devinfo -d mlx5_0 | grep -i "state\|speed\|gid"
```

Expected output for a healthy RoCEv2 port:
```
port_state: PORT_ACTIVE (4)
link_layer: Ethernet
active_speed: 100 Gb/s (16)
active_mtu: 4096 (5)
```

### Step 2 — Set Environment Variables

Neolith Enterprise reads RDMA configuration from environment variables. Set these before starting the server:

```bash
# Required: enable the RDMA data plane
export NEOLITH_RDMA_ENABLED=true

# Optional: specify device (auto-selects first PORT_ACTIVE device if unset)
export NEOLITH_RDMA_DEVICE=mlx5_0

# Optional: GID index for RoCEv2 (index 3 is the RoCEv2 IPv4 GID on most ConnectX NICs)
# Use `show_gids` to find the correct index for your setup
export NEOLITH_RDMA_GID_INDEX=3

# Optional: maximum concurrent RC queue pairs (default 128)
export NEOLITH_RDMA_MAX_QP=256

# Optional: MR pool size in MiB (default 512 MiB; 0 = ODP / on-demand paging)
export NEOLITH_RDMA_MR_POOL_MB=1024

# Optional: fall back to TCP if RDMA setup fails (default true; set false only in validated environments)
export NEOLITH_RDMA_FALLBACK_TCP=true

# Optional: minimum object size (KiB) to use RDMA path (default 256 KiB)
# Objects smaller than this always go over TCP — RDMA setup overhead exceeds the benefit
export NEOLITH_RDMA_MIN_OBJ_KB=256
```

| Environment Variable | Default | Description |
|---|---|---|
| `NEOLITH_RDMA_ENABLED` | `false` | Master switch — must be `true` to activate |
| `NEOLITH_RDMA_DEVICE` | auto | ibverbs device name (`mlx5_0`, `rxe0`, …) |
| `NEOLITH_RDMA_PORT` | `1` | RDMA device port number |
| `NEOLITH_RDMA_GID_INDEX` | `3` | GID table index for RoCEv2 |
| `NEOLITH_RDMA_MAX_QP` | `128` | Maximum concurrent RC queue pairs |
| `NEOLITH_RDMA_MR_POOL_MB` | `512` | Pre-registered MR pool in MiB |
| `NEOLITH_RDMA_FALLBACK_TCP` | `true` | Fall back to TCP on RDMA errors |
| `NEOLITH_RDMA_MIN_OBJ_KB` | `256` | Minimum object size for RDMA path |

### Step 3 — Build with RDMA Support

The RDMA transport requires the `rdma` Cargo feature (Linux only). This links `libibverbs` at compile time:

```bash
# Install libibverbs development headers
sudo apt-get install libibverbs-dev rdma-core   # Debian/Ubuntu
sudo dnf install libibverbs-devel rdma-core     # Fedora/RHEL

# Build with RDMA support
cargo build --release -p neolith-enterprise-server --features rdma
```

Without the `rdma` feature, the crate compiles on all platforms and uses `MockRdmaTransport` — all operations fall back to HTTP/TCP. This lets you build and test on macOS/Windows developer machines while deploying the real RDMA transport to Linux.

### Step 4 — Start the Enterprise Server

```bash
NEOLITH_RDMA_ENABLED=true \
NEOLITH_RDMA_DEVICE=mlx5_0 \
NEOLITH_LICENSE_FILE=/etc/neolith/license.lic \
neolith-enterprise server start /data --license-file /etc/neolith/license.lic
```

You should see log lines like:
```
INFO neolith_rdma::verbs: RDMA transport initialized device=mlx5_0 port_state=UP speed="100 Gb/s"
INFO neolith_rdma::manager: RDMA transport active (ibverbs)
```

If hardware is not available or the `rdma` feature is not compiled in:
```
WARN neolith_rdma::manager: RDMA requested but ibverbs not available on this platform; using mock
```

## Kubernetes (CRD) Configuration

When deploying with the Neolith Kubernetes Operator, configure RDMA per-cell in the `NeoCell` CRD:

```yaml
apiVersion: neolith.io/v1alpha1
kind: NeoCell
metadata:
  name: gpu-cluster-cell-1
spec:
  replicas: 4
  image: "ghcr.io/muratkars/neolith-enterprise:0.6"
  licenseSecret: neolith-license
  network:
    rdmaEnabled: true
    rdmaDevice: "mlx5_0"         # omit for auto-select
    rdmaGidIndex: 3              # RoCEv2 IPv4 GID
    rdmaMaxQp: 256
    rdmaMrPoolMb: 1024
    rdmaFallbackTcp: true
    rdmaMinObjKb: 256
  storage:
    drives:
      - /mnt/nvme0
      - /mnt/nvme1
```

To enable cluster-wide RDMA for all cells, use the `NeoCluster` CRD:

```yaml
apiVersion: neolith.io/v1alpha1
kind: NeoCluster
metadata:
  name: ai-training-cluster
spec:
  cells:
    - name: cell-a
      rdmaEnabled: true
    - name: cell-b
      rdmaEnabled: true
  network:
    rdmaGidIndex: 3
    rdmaMrPoolMb: 2048
```

RDMA is opt-in at the cell level — cells without `rdmaEnabled: true` continue to serve standard S3 traffic over TCP, so mixed clusters are supported.

## Admin API

All RDMA management endpoints are under `/_neolith/admin/v1/rdma/` and `/_neolith/rdma/`.

### Check RDMA Status

```bash
curl -s http://localhost:9000/_neolith/admin/v1/rdma/status | jq .
```

```json
{
  "enabled": true,
  "device": "mlx5_0",
  "gid": "fe80::1:2:3:4",
  "port_state": "UP",
  "qp_active": 12,
  "mr_pool_used_mb": 48,
  "mr_pool_capacity_mb": 512,
  "fallback_count": 3,
  "errors_total": 0
}
```

| Field | Description |
|---|---|
| `enabled` | Whether RDMA is configured and enabled |
| `device` | ibverbs device name |
| `gid` | Active GID (RoCEv2 address) |
| `port_state` | Port state: `UP`, `DOWN`, `INIT` |
| `qp_active` | Current number of active RC queue pairs |
| `mr_pool_used_mb` | Memory region pool in use |
| `mr_pool_capacity_mb` | Total MR pool capacity |
| `fallback_count` | Cumulative TCP fallbacks (all reasons) |
| `errors_total` | Cumulative RDMA errors (QP errors, timeouts, etc.) |

### Enumerate RDMA Devices

```bash
curl -s http://localhost:9000/_neolith/admin/v1/rdma/devices | jq .
```

```json
[
  {
    "name": "mlx5_0",
    "fw_version": "22.39.1002",
    "port_state": "UP",
    "active_speed": "100 Gb/s",
    "active_mtu": 4096,
    "gids": [
      { "index": 0, "gid_type": "infini_band", "address": "fe80::..." },
      { "index": 1, "gid_type": "ro_ce_v1",    "address": "fe80::..." },
      { "index": 3, "gid_type": "ro_ce_v2",    "address": "10.0.1.5" }
    ]
  }
]
```

Use the `gid_type: ro_ce_v2` entry with IPv4 address and its `index` value as `NEOLITH_RDMA_GID_INDEX`.

### Manual Connection Management

These endpoints are primarily for integration testing and diagnostics. Client SDKs call them automatically.

**Establish a QP connection:**
```bash
curl -X POST http://localhost:9000/_neolith/rdma/connect \
  -H "Content-Type: application/json" \
  -d '{
    "gid": "10.0.1.10",
    "qpn": 42,
    "psn": 9000,
    "mtu": 4096
  }'
```

```json
{
  "connection_id": "550e8400-e29b-41d4-a716-446655440000",
  "gid": "10.0.1.5",
  "qpn": 48879,
  "psn": 1193046
}
```

**Tear down a connection:**
```bash
curl -X POST http://localhost:9000/_neolith/rdma/disconnect/550e8400-e29b-41d4-a716-446655440000
```

## Client SDK Protocol

For clients that want to use the RDMA path, the protocol is:

### 1. Establish a Connection

POST to `/_neolith/rdma/connect` with the client's QP parameters. The server responds with its QP parameters and a `connection_id`.

### 2. Register a Memory Region

On the client side, allocate and pin a buffer with `ibv_reg_mr()`, obtaining an `rkey` and virtual `addr`.

### 3. Send the S3 Request with RDMA Headers

Include these four headers on PUT or GET requests:

```
x-neolith-rdma-connection-id: <uuid from connect response>
x-neolith-rdma-rkey:          <uint32 decimal — client MR rkey>
x-neolith-rdma-addr:          <uint64 hex — client buffer virtual address>
x-neolith-rdma-len:           <uint64 decimal — buffer size in bytes>
```

For PUT, **do not include an HTTP body** — the server reads the data via RDMA.

For GET, **discard the HTTP response body** — the server writes data directly into your buffer.

### 4. Tear Down

POST to `/_neolith/rdma/disconnect/<connection_id>` when done (typically at session teardown, not per-request).

### AWS SDK Compatibility

Standard AWS SDKs are fully compatible — they do not send the `x-neolith-rdma-*` headers, so every request uses the TCP path. You only need an RDMA-aware client to get the performance benefit.

## Monitoring

All RDMA metrics are exported to the `/metrics` Prometheus endpoint.

| Metric | Type | Description |
|---|---|---|
| `neolith_rdma_put_bytes_total` | Counter | Bytes transferred via RDMA PUT path |
| `neolith_rdma_get_bytes_total` | Counter | Bytes transferred via RDMA GET path |
| `neolith_rdma_put_ops_total` | Counter | RDMA PUT operations |
| `neolith_rdma_get_ops_total` | Counter | RDMA GET operations |
| `neolith_rdma_fallback_total{reason}` | Counter | TCP fallbacks by reason: `disabled`, `size_below_threshold`, `qp_error` |
| `neolith_rdma_errors_total{kind}` | Counter | RDMA errors by kind: `qp_error`, `mr_exhausted`, `cq_overflow`, `timeout`, `rkey_invalid` |
| `neolith_rdma_qp_active` | Gauge | Active RC queue pairs |
| `neolith_rdma_mr_pool_used_bytes` | Gauge | MR pool bytes in use |
| `neolith_rdma_mr_pool_capacity_bytes` | Gauge | MR pool total capacity |
| `neolith_rdma_connections_total` | Counter | Cumulative connection_id allocations |
| `neolith_rdma_cq_overflows_total` | Counter | CQ overflow events |

### Useful Alert Rules

```yaml
# Alert if RDMA fallback rate exceeds 5% of operations
- alert: RdmaHighFallbackRate
  expr: |
    rate(neolith_rdma_fallback_total[5m])
    / (rate(neolith_rdma_put_ops_total[5m]) + rate(neolith_rdma_get_ops_total[5m]) + 0.001)
    > 0.05
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "High RDMA fallback rate on {{ $labels.instance }}"

# Alert on QP errors
- alert: RdmaQpErrors
  expr: rate(neolith_rdma_errors_total{kind="qp_error"}[5m]) > 0
  for: 1m
  labels:
    severity: warning
  annotations:
    summary: "RDMA QP errors detected — check NIC and switch PFC config"

# Alert if MR pool is nearly exhausted
- alert: RdmaMrPoolExhausted
  expr: neolith_rdma_mr_pool_used_bytes / neolith_rdma_mr_pool_capacity_bytes > 0.9
  for: 2m
  labels:
    severity: warning
  annotations:
    summary: "RDMA MR pool >90% full — increase NEOLITH_RDMA_MR_POOL_MB"
```

## GID Index Reference

The correct GID index depends on your NIC firmware and fabric configuration. Use `show_gids` to inspect the full table:

```
$ show_gids
DEV     PORT    INDEX   GID                                     IPv4            VER     DEV
---     ----    -----   ---                                     ------------    ---     ---
mlx5_0  1       0       fe80:0000:0000:0000:0aed:7bff:fe1c:52f8                RoCE v1 eth1
mlx5_0  1       1       0000:0000:0000:0000:0000:ffff:0a00:0105 10.0.1.5        RoCE v2 eth1
mlx5_0  1       3       0000:0000:0000:0000:0000:ffff:0a00:0105 10.0.1.5        RoCE v2 eth1
```

Use the entry where `VER = RoCE v2` and the IPv4 address matches the storage network interface. Set `NEOLITH_RDMA_GID_INDEX` to the `INDEX` column value.

## Troubleshooting

### RDMA device not found

```
ERROR neolith_rdma: DeviceNotFound(None) — no RDMA devices found
```

- Run `ibv_devices` — if empty, kernel modules are not loaded.
- Load modules: `modprobe ib_core mlx5_core mlx5_ib rdma_ucm`
- Check dmesg: `dmesg | grep -i mlx5`

### Port not active

```
ERROR neolith_rdma: PortNotActive — port state is INIT, expected ACTIVE
```

- Run `ibv_devinfo | grep -i state` — the port must show `PORT_ACTIVE (4)`.
- Check that the cable is connected and the switch port is up.
- Verify RDMA subsystem: `rdma link show`

### High fallback rate / QP errors

If `neolith_rdma_fallback_total{reason="qp_error"}` is climbing:

1. **Check PFC**: Run `mlnx_qos -i eth1` — all RDMA priority queues must show PFC TX/RX enabled.
2. **Check ECN**: `ethtool -S eth1 | grep -i ecn` — counters should be non-zero but not exploding.
3. **Check link errors**: `ethtool -S eth1 | grep -i error` — hardware errors indicate a cabling or firmware issue.
4. **MTU mismatch**: All nodes on the RDMA network must have the same MTU. `ip link | grep mtu`.

### MR pool exhausted

```
WARN neolith_rdma: MrPoolExhausted — increase NEOLITH_RDMA_MR_POOL_MB
```

Increase `NEOLITH_RDMA_MR_POOL_MB`. Alternatively, set it to `0` to use On-Demand Paging (ODP) — the kernel pins pages lazily, eliminating the pool entirely at the cost of first-access latency. ODP requires ConnectX-4 Lx or newer.

### Fallback due to object size

```
DEBUG neolith_rdma: below RDMA threshold, using TCP len=131072 min=262144
```

Normal behavior for small objects. Lower `NEOLITH_RDMA_MIN_OBJ_KB` if you want to use RDMA for smaller objects (not recommended — setup overhead exceeds benefit below ~64 KiB).

## Performance Expectations

On a properly configured 100 GbE RoCEv2 fabric with NVMe storage:

| Operation | TCP | RDMA | Improvement |
|---|---|---|---|
| PUT 1 MiB | ~12 GB/s | ~20 GB/s | ~65% |
| PUT 4 MiB | ~9 GB/s | ~18 GB/s | ~100% |
| GET 1 MiB | ~14 GB/s | ~22 GB/s | ~57% |
| GET 4 MiB | ~11 GB/s | ~19 GB/s | ~73% |
| PUT latency (p99) | ~1.2 ms | ~0.4 ms | 3× |

Actual numbers depend heavily on NIC generation, switch configuration, CPU binding, and MR pool configuration. Run `warp` or `neolith-bench` against your specific setup to establish baselines.

## See Also

- [Architecture: Data Path](/docs/architecture/data-path) — overall PUT/GET pipeline
- [Enterprise Overview](/docs/enterprise/overview) — edition comparison table
- [Observability](/docs/enterprise/observability) — Prometheus metrics and Grafana dashboards
- [Operations: Monitoring](/docs/operations/monitoring) — alert rules and runbooks
