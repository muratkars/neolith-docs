---
sidebar_position: 7
title: "Observability"
---

# Observability

Neolith Enterprise provides deep observability through OpenTelemetry integration, pre-built Grafana dashboards, Prometheus alerting rules, drive-level health monitoring, and distributed tracing.

## Metrics

Neolith exposes Prometheus-compatible metrics on the `/metrics` endpoint. Metrics cover all layers of the stack, from HTTP request handling to disk I/O.

### Key Metrics

| Metric | Type | Description |
|---|---|---|
| `neolith_http_requests_total` | Counter | Total HTTP requests by method, path, status |
| `neolith_http_request_duration_seconds` | Histogram | Request latency distribution |
| `neolith_http_request_size_bytes` | Histogram | Request body size distribution |
| `neolith_http_response_size_bytes` | Histogram | Response body size distribution |
| `neolith_objects_total` | Gauge | Total objects stored per bucket |
| `neolith_storage_bytes_total` | Gauge | Total storage used (raw, before erasure coding) |
| `neolith_storage_capacity_bytes` | Gauge | Total storage capacity |
| `neolith_erasure_encode_duration_seconds` | Histogram | Erasure encoding latency |
| `neolith_erasure_decode_duration_seconds` | Histogram | Erasure decoding latency |
| `neolith_heal_operations_total` | Counter | Heal operations by type and result |
| `neolith_heal_bytes_repaired_total` | Counter | Total bytes repaired |
| `neolith_replication_lag_seconds` | Gauge | Replication lag per remote site |
| `neolith_tier_transitions_total` | Counter | Tier transitions by source and destination |
| `neolith_disk_read_bytes_total` | Counter | Disk read bytes per drive |
| `neolith_disk_write_bytes_total` | Counter | Disk write bytes per drive |
| `neolith_disk_read_latency_seconds` | Histogram | Per-drive read latency |
| `neolith_disk_write_latency_seconds` | Histogram | Per-drive write latency |
| `neolith_disk_smart_temperature_celsius` | Gauge | Drive temperature from SMART |
| `neolith_disk_smart_reallocated_sectors` | Gauge | Reallocated sector count from SMART |
| `neolith_cluster_nodes_total` | Gauge | Cluster size by node status |
| `neolith_cluster_topology_version` | Gauge | Current topology version |

## Grafana Dashboards

Three pre-built Grafana dashboards are included in the `deploy/` directory:

### 1. Cluster Overview Dashboard

**File**: `deploy/grafana-cluster-overview.json`

Panels:
- Cluster health status (node count, online/offline)
- Aggregate request rate (QPS) by operation type
- P50/P95/P99 latency heatmap
- Storage utilization (used/capacity with projection)
- Network throughput (ingress/egress)
- Top buckets by request rate
- Active heal/rebalance operations

### 2. Node Detail Dashboard

**File**: `deploy/grafana-node-detail.json`

Panels:
- Per-node CPU, memory, and I/O utilization
- Per-drive read/write IOPS and throughput
- Per-drive latency percentiles (P50/P95/P99)
- Drive SMART health indicators (temperature, reallocated sectors, wear leveling)
- Erasure coding encode/decode throughput
- Local heal queue depth and repair rate
- Go/Rust runtime metrics (for Neolith: allocator stats)

### 3. S3 API Dashboard

**File**: `deploy/grafana-s3-api.json`

Panels:
- Request rate by S3 operation (GET, PUT, DELETE, LIST, HEAD, COPY)
- Error rate by status code (4xx, 5xx)
- Request latency by operation type
- Object size distribution (upload and download)
- Multipart upload activity
- SigV4 authentication success/failure rate
- Top clients by request count

### Importing Dashboards

```bash
# Import via Grafana API
curl -X POST http://grafana:3000/api/dashboards/db \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GRAFANA_API_KEY" \
  -d @deploy/grafana-cluster-overview.json
```

Or import manually through the Grafana UI: Dashboards > Import > Upload JSON file.

## Prometheus Alert Rules

Eight alert rules are included in `deploy/prometheus-alerts.yml`:

```yaml
groups:
  - name: neolith
    rules:
      # 1. Node down for more than 5 minutes
      - alert: NeolithNodeDown
        expr: up{job="neolith"} == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Neolith node {{ $labels.instance }} is down"

      # 2. Storage utilization above 85%
      - alert: NeolithStorageHigh
        expr: >
          neolith_storage_bytes_total / neolith_storage_capacity_bytes > 0.85
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Storage utilization above 85% on {{ $labels.instance }}"

      # 3. Drive latency P99 above 100ms
      - alert: NeolithDriveLatencyHigh
        expr: >
          histogram_quantile(0.99, rate(neolith_disk_write_latency_seconds_bucket[5m])) > 0.1
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Drive write P99 latency above 100ms on {{ $labels.instance }}"

      # 4. Heal queue depth growing
      - alert: NeolithHealQueueGrowing
        expr: >
          deriv(neolith_heal_queue_depth[30m]) > 10
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "Heal queue is growing on {{ $labels.instance }}"

      # 5. S3 error rate above 1%
      - alert: NeolithS3ErrorRate
        expr: >
          rate(neolith_http_requests_total{status=~"5.."}[5m])
          / rate(neolith_http_requests_total[5m]) > 0.01
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "S3 error rate above 1% on {{ $labels.instance }}"

      # 6. Replication lag above threshold
      - alert: NeolithReplicationLag
        expr: neolith_replication_lag_seconds > 300
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Replication lag above 5 minutes to {{ $labels.remote_site }}"

      # 7. Drive SMART warning (reallocated sectors)
      - alert: NeolithDriveSmartWarning
        expr: neolith_disk_smart_reallocated_sectors > 0
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Drive {{ $labels.drive }} has reallocated sectors on {{ $labels.instance }}"

      # 8. Drive temperature above 60C
      - alert: NeolithDriveTemperature
        expr: neolith_disk_smart_temperature_celsius > 60
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Drive {{ $labels.drive }} temperature above 60C on {{ $labels.instance }}"
```

## Drive Health Monitoring

Neolith Enterprise monitors drive health at two levels:

### SMART Monitoring

The storage engine periodically reads SMART (Self-Monitoring, Analysis and Reporting Technology) attributes from attached drives:

| SMART Attribute | Metric | Significance |
|---|---|---|
| Temperature | `neolith_disk_smart_temperature_celsius` | Overheating indicates cooling failure or excessive workload |
| Reallocated Sectors | `neolith_disk_smart_reallocated_sectors` | Non-zero indicates media degradation, early warning of failure |
| Wear Leveling Count | `neolith_disk_smart_wear_leveling` | SSD endurance remaining |
| Power-On Hours | `neolith_disk_smart_power_on_hours` | Drive age for warranty/replacement planning |
| Uncorrectable Errors | `neolith_disk_smart_uncorrectable_errors` | Data integrity risk |

### Drive Latency Tracking

Every I/O operation is timed at the drive level. The latency histogram enables detecting drives that are degrading before they fail completely:

- **Normal**: P99 < 5 ms (NVMe) or < 20 ms (SATA SSD)
- **Degraded**: P99 > 50 ms consistently: triggers proactive data migration
- **Failing**: P99 > 500 ms or I/O errors: triggers immediate heal + decommission

The `CapacityScanner` background task reports drive health and projects storage growth using linear regression, alerting operators before capacity runs out. It reads drive info using the `df` command with no unsafe code.

## Distributed Tracing

Neolith Enterprise integrates with OpenTelemetry for distributed tracing across multi-node clusters:

```toml
[enterprise.observability]
enabled = true

[enterprise.observability.tracing]
enabled = true
exporter = "otlp"  # or "jaeger", "zipkin"
endpoint = "http://otel-collector:4317"
sample_rate = 0.01  # 1% sampling in production
service_name = "neolith"
```

Each request generates a trace that spans across:
1. **Gateway proxy**: Request parsing, authentication, routing decision
2. **Storage node**: Object retrieval/storage, erasure coding, encryption
3. **Replication**: Cross-site data transfer (if applicable)
4. **Heal**: Repair operations triggered by read-repair

Trace context is propagated via the `traceparent` header (W3C Trace Context standard) across all inter-node HTTP/2 RPC calls on port 9000.
