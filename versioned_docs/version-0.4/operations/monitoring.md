---
sidebar_position: 1
title: "Monitoring & Metrics"
---

# Monitoring & Metrics

Neolith exposes Prometheus-compatible metrics on the `/metrics` endpoint and supports structured logging via the `tracing` framework. This page covers the available metrics, Grafana dashboard setup, and distributed tracing with request IDs.

## Prometheus Metrics

Metrics are served at `GET /metrics` in Prometheus text exposition format. This endpoint does not require authentication.

```bash
curl http://localhost:9000/metrics
```

### Request Metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `neolith_requests_total` | Counter | `method`, `status` | Total S3 API requests |
| `neolith_request_duration_seconds` | Histogram | `method` | Request latency in seconds |

The histogram uses these bucket boundaries (in seconds):
```
0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0
```

These buckets provide high resolution at the sub-millisecond range where most object storage operations complete.

**Example queries:**

```promql
# Request rate by method
rate(neolith_requests_total[5m])

# p99 latency for GET requests
histogram_quantile(0.99, rate(neolith_request_duration_seconds_bucket{method="GET"}[5m]))

# Error rate (non-2xx responses)
sum(rate(neolith_requests_total{status!~"2.."}[5m])) / sum(rate(neolith_requests_total[5m]))
```

### Throughput Metrics

| Metric | Type | Description |
|---|---|---|
| `neolith_bytes_received_total` | Counter | Total bytes received in PUT request bodies |
| `neolith_bytes_sent_total` | Counter | Total bytes sent in GET response bodies |

```promql
# Ingress bandwidth
rate(neolith_bytes_received_total[5m]) / 1024 / 1024  # MB/s

# Egress bandwidth
rate(neolith_bytes_sent_total[5m]) / 1024 / 1024  # MB/s
```

### Object Operation Metrics

| Metric | Type | Description |
|---|---|---|
| `neolith_objects_stored_total` | Counter | Total objects stored (PUT) |
| `neolith_objects_retrieved_total` | Counter | Total objects retrieved (GET) |
| `neolith_objects_deleted_total` | Counter | Total objects deleted (DELETE) |

### Listing Cache Metrics

| Metric | Type | Description |
|---|---|---|
| `neolith_listing_cache_hits` | Counter | Cache hits for LIST operations |
| `neolith_listing_cache_misses` | Counter | Cache misses requiring disk scan |

```promql
# Cache hit ratio
neolith_listing_cache_hits / (neolith_listing_cache_hits + neolith_listing_cache_misses)
```

### Compression Metrics

| Metric | Type | Description |
|---|---|---|
| `neolith_compression_bytes_in` | Counter | Bytes before compression |
| `neolith_compression_bytes_out` | Counter | Bytes after compression |
| `neolith_compression_skipped` | Counter | Objects skipped (incompressible) |

```promql
# Compression ratio
1 - (rate(neolith_compression_bytes_out[5m]) / rate(neolith_compression_bytes_in[5m]))

# Skip rate (how often smart-skip activates)
rate(neolith_compression_skipped[5m]) / rate(neolith_objects_stored_total[5m])
```

### Encryption Metrics

| Metric | Type | Description |
|---|---|---|
| `neolith_encryption_ops_total` | Counter | Objects encrypted (PUT with SSE) |
| `neolith_decryption_ops_total` | Counter | Objects decrypted (GET with SSE) |

### Authentication Metrics

| Metric | Type | Description |
|---|---|---|
| `neolith_auth_success_total` | Counter | Successful SigV4 authentications |
| `neolith_auth_failure_total` | Counter | Failed authentication attempts |

```promql
# Auth failure rate
rate(neolith_auth_failure_total[5m]) / (rate(neolith_auth_success_total[5m]) + rate(neolith_auth_failure_total[5m]))
```

### Process Metrics

| Metric | Type | Description |
|---|---|---|
| `neolith_process_rss_bytes` | Gauge | Resident set size in bytes |
| `neolith_process_open_fds` | Gauge | Number of open file descriptors |
| `neolith_uptime_seconds` | Gauge | Server uptime in seconds |

Process metrics are updated every 15 seconds by a background task.

## Grafana Dashboard Setup

### Prometheus Configuration

Add Neolith as a scrape target in your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'neolith'
    scrape_interval: 15s
    static_configs:
      - targets:
        - 'node1:9000'
        - 'node2:9000'
        - 'node3:9000'
        - 'node4:9000'
    # If TLS is enabled
    scheme: https
    tls_config:
      ca_file: /etc/prometheus/neolith-ca.pem
```

### Dashboard Panels

Neolith ships with pre-built Grafana dashboards in the `deploy/` directory. Import them into your Grafana instance.

**Recommended panels:**

#### Overview Dashboard
- **Request Rate**: `sum(rate(neolith_requests_total[5m])) by (method)` - stacked area chart
- **Error Rate**: `sum(rate(neolith_requests_total{status!~"2.."}[5m]))` - single stat with threshold alerts
- **Throughput**: `rate(neolith_bytes_sent_total[5m]) + rate(neolith_bytes_received_total[5m])` - area chart in MB/s
- **Uptime**: `neolith_uptime_seconds` per node

#### Latency Dashboard
- **GET p50/p99/p999**: Three lines from `histogram_quantile()` on the same chart
- **PUT p50/p99/p999**: Separate from GET to distinguish read vs write latency
- **Latency Heatmap**: `neolith_request_duration_seconds_bucket` as a heatmap

#### Storage Dashboard
- **Objects Stored Rate**: `rate(neolith_objects_stored_total[5m])`
- **Compression Ratio**: Gauge showing current compression effectiveness
- **Cache Hit Ratio**: Gauge for listing cache efficiency
- **Memory Usage**: `neolith_process_rss_bytes` per node
- **Open FDs**: `neolith_process_open_fds` per node (alert if approaching ulimit)

## Structured Logging

Neolith uses the `tracing` crate with `tracing-subscriber` for structured, leveled logging.

### Configuration

Log level is configured in three ways (in priority order):

1. **`RUST_LOG` environment variable** (highest priority):
   ```bash
   RUST_LOG=debug neolith server start /data
   RUST_LOG="neolith=debug,tower=warn,hyper=info" neolith server start /data
   ```

2. **Config file** `[logging]` section:
   ```toml
   [logging]
   level = "info"
   format = "json"
   ```

3. **Default**: `info`

### Log Levels

| Level | Description | Use Case |
|---|---|---|
| `error` | Unrecoverable errors, data corruption | Always on |
| `warn` | Degraded conditions (disk slow, auth disabled) | Always on |
| `info` | Normal operations (startup, shutdown, config reload) | Production |
| `debug` | Per-request details, cache hits/misses | Development/troubleshooting |
| `trace` | Low-level I/O, shard reads/writes | Performance analysis |

### Output Formats

**Text format** (default, human-readable):
```
2026-03-15T10:30:00.000Z  INFO neolith_server::core: starting neolith server listen=0.0.0.0:9000 drives=["/mnt/disk1", "/mnt/disk2"]
2026-03-15T10:30:00.100Z  INFO neolith_server::core: cluster mode enabled node_id=https://node1:9000 peers=3 partitions=16384
2026-03-15T10:30:00.200Z  INFO neolith_server::core: neolith server ready listen=0.0.0.0:9000 edition="Neolith OSS" tls=false
```

**JSON format** (machine-parseable, for log aggregation):
```json
{"timestamp":"2026-03-15T10:30:00.000Z","level":"INFO","target":"neolith_server::core","message":"starting neolith server","listen":"0.0.0.0:9000","drives":["/mnt/disk1","/mnt/disk2"]}
```

Configure JSON format:
```toml
[logging]
format = "json"
```

## Request IDs

Every S3 API request is assigned a unique UUID v4 request ID via an outermost Axum middleware layer. The request ID is returned in two response headers:

| Header | Description |
|---|---|
| `x-amz-request-id` | Primary request ID (UUID v4) |
| `x-amz-id-2` | Secondary request ID (same value, for S3 compatibility) |

### Using Request IDs

Request IDs enable end-to-end tracing across the client and server:

```bash
# The request ID is in the response headers
$ curl -v http://localhost:9000/my-bucket/test.txt 2>&1 | grep x-amz-request-id
< x-amz-request-id: 550e8400-e29b-41d4-a716-446655440000

# Search server logs for this request
grep "550e8400-e29b-41d4-a716-446655440000" /var/log/neolith/server.log
```

In JSON log format, the request ID is included as a structured field, making it queryable in log aggregation systems (Elasticsearch, Loki, CloudWatch).

### Error Correlation

S3 error responses include the request ID in the XML body:

```xml
<Error>
  <Code>NoSuchKey</Code>
  <Message>The specified key does not exist.</Message>
  <RequestId>550e8400-e29b-41d4-a716-446655440000</RequestId>
</Error>
```

Clients should log the request ID from error responses to enable server-side investigation.

## Health Check

The `/health` endpoint returns a simple JSON response indicating server readiness:

```bash
$ curl http://localhost:9000/health
{"status":"ok"}
```

Use this endpoint for:
- Load balancer health checks
- Kubernetes liveness/readiness probes
- Monitoring system uptime checks

The health endpoint does not require authentication and always returns HTTP 200 when the server is running.

## Alerting Recommendations

| Alert | Condition | Severity |
|---|---|---|
| High error rate | Error rate > 1% for 5 minutes | Warning |
| High error rate | Error rate > 5% for 5 minutes | Critical |
| High latency | p99 GET > 1s for 5 minutes | Warning |
| High latency | p99 GET > 5s for 5 minutes | Critical |
| Auth failures spike | Auth failures > 100/min for 5 minutes | Warning |
| Memory pressure | RSS > 80% of available RAM | Warning |
| FD exhaustion | Open FDs > 80% of ulimit | Critical |
| Node down | Health check failing for 30 seconds | Critical |
| Cache degradation | Cache hit ratio < 50% for 15 minutes | Warning |
