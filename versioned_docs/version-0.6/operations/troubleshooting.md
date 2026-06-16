---
sidebar_position: 6
title: "Troubleshooting"
---

# Troubleshooting

This page covers common issues, diagnostic tools, and resolution procedures for Neolith deployments.

## Health Check

The first diagnostic step is always the health endpoint:

```bash
$ curl http://localhost:9000/health
{"status":"ok"}
```

If the health check fails:
- **Connection refused**: The server is not running or is listening on a different port
- **Connection timeout**: Firewall blocking port 9000, or server is overloaded
- **TLS error**: Server has TLS enabled but you are using `http://` instead of `https://`

## Common Issues

### SIMD Not Available

**Symptom**: Server fails to start with an error about SIMD support.

**Cause**: Neolith requires SIMD instructions (AVX2 on x86_64, NEON on aarch64) for erasure coding. There is no scalar fallback.

**Resolution**:
```bash
# Check CPU SIMD support (x86_64)
grep -o 'avx2' /proc/cpuinfo | head -1

# Check CPU SIMD support (aarch64)
grep -o 'neon\|asimd' /proc/cpuinfo | head -1
```

If running in a VM, ensure the hypervisor exposes SIMD instructions to the guest. For Docker, use `--privileged` or ensure the host CPU has SIMD support (containers share the host CPU).

### Port Already in Use

**Symptom**: Server fails to start with "address already in use".

```
Error: error binding to 0.0.0.0:9000: address already in use
```

**Resolution**:
```bash
# Find what is using port 9000
lsof -i :9000
# or
ss -tlnp | grep 9000

# Either stop the conflicting process, or use a different port
neolith server start --listen 0.0.0.0:9001 /data
```

### Disk Full (507 Insufficient Storage)

**Symptom**: PUT requests fail with HTTP 507.

**Cause**: Neolith performs a pre-write `statvfs` check with a 1 MB reserve. If the filesystem has less than 1 MB of free space, the write is rejected immediately. Additionally, if the write encounters `ENOSPC` during I/O, it is converted to a 507 response.

**Resolution**:
```bash
# Check disk space
df -h /mnt/disk*

# If disk is genuinely full, free space by:
# 1. Deleting unnecessary objects
# 2. Running lifecycle rules (if configured)
# 3. Adding more drives and expanding the pool
neolith admin pool expand pool-1 --drives /mnt/newdisk1,/mnt/newdisk2
```

### Configuration Validation Error

**Symptom**: Server fails to start with a config error.

```
Error: TOML parse error: entropy_threshold must be 0.0-8.0, got 9.0
```

**Resolution**: Check the config file against the [Configuration Reference](../cli/configuration). Common validation rules:
- `entropy_threshold` must be 0.0-8.0
- `data_shards` must be >= 1
- `parity_shards` must be >= 1
- For Reed-Solomon, `data_shards + parity_shards` must be ≤ 255
- `listen` must be a valid `host:port` address

### Authentication Failures

**Symptom**: All requests return HTTP 403 `AccessDenied`.

**Diagnosis**:
```bash
# Check if auth is enabled
curl -v http://localhost:9000/health 2>&1 | grep "x-amz-request-id"
# If x-amz-request-id is present, the server is running

# Check auth failure metrics
curl http://localhost:9000/metrics | grep auth_failure
```

**Common causes**:
1. **Wrong credentials**: Verify `NEOLITH_ACCESS_KEY` / `NEOLITH_SECRET_KEY` match what was used to start the server
2. **Clock skew**: SigV4 requires the client clock to be within 15 minutes of the server. Check with `date` on both machines
3. **Missing headers**: SigV4 requires `x-amz-date`, `x-amz-content-sha256`, and `Host` headers
4. **STS token expired**: If using temporary credentials, check the expiration time

### TLS Handshake Failure

**Symptom**: Clients cannot connect to the TLS-enabled server.

```
curl: (35) error:1401E0F4:SSL routines:CONNECT_CR_SRVR_HELLO:tlsv1 alert internal error
```

**Diagnosis**:
```bash
# Test TLS with openssl
openssl s_client -connect localhost:9000 -tls1_3

# Check certificate validity
openssl x509 -in /etc/neolith/tls/server.pem -noout -dates

# Check certificate chain
openssl verify -CAfile ca.pem /etc/neolith/tls/server.pem
```

**Common causes**:
1. **TLS 1.2 client**: Neolith only supports TLS 1.3. Update the client.
2. **Expired certificate**: Regenerate or renew the certificate
3. **Wrong CA**: Client must trust the CA that signed the server certificate
4. **mTLS without client cert**: If `ca_file` is configured, clients must present a valid certificate

### Objects Not Appearing in LIST

**Symptom**: PUT succeeds but LIST does not show the object.

**Cause**: The listing cache may be stale if the server crashed without persisting the cache.

**Resolution**:
```bash
# The listing cache is automatically rebuilt on startup
# If the cache seems stale, restart the server
systemctl restart neolith
```

The listing cache is an in-memory structure backed by a persistent snapshot (`.neolith/listing-cache.bin`). On startup, the server either loads the snapshot or performs a full disk scan. Both are safe operations that will bring the cache into a consistent state.

## Diagnostic Tools

### Log Levels

Increase log verbosity for detailed diagnostics:

```bash
# Set via environment variable (highest priority)
RUST_LOG=debug neolith server start /data

# Per-crate verbosity
RUST_LOG="neolith_s3=debug,neolith_cluster=trace,tower=warn" neolith server start /data
```

Useful log level combinations:

| Scenario | RUST_LOG Value |
|---|---|
| General debugging | `debug` |
| S3 API issues | `neolith_s3=debug` |
| Cluster/RPC issues | `neolith_cluster=debug` |
| Heal/repair issues | `neolith_heal=debug` |
| Auth issues | `neolith_iam=debug` |
| Encryption issues | `neolith_crypto=debug` |
| Performance analysis | `neolith=trace` |
| Quiet mode (errors only) | `error` |

### Request Tracing

Every request receives a UUID v4 request ID in the `x-amz-request-id` response header:

```bash
$ curl -v http://localhost:9000/my-bucket/test.txt 2>&1 | grep request-id
< x-amz-request-id: 550e8400-e29b-41d4-a716-446655440000
```

Search server logs for this ID to trace the complete request lifecycle:

```bash
grep "550e8400-e29b-41d4-a716-446655440000" /var/log/neolith/server.log
```

In JSON log format, the request ID is a structured field, queryable in log aggregation systems.

### Orphan Cleanup

**Symptom**: Stale `.tmp` files accumulating in data directories.

**Cause**: Temporary files created during interrupted writes (crash, SIGKILL, power loss).

**Resolution**: Neolith includes an automatic orphan scanner (`cleanup_orphans`) that removes `.tmp` files older than 300 seconds (5 minutes). This runs as part of the background task loop.

To verify:

```bash
# Check for stale temp files
find /mnt/disk* -name "*.tmp" -mmin +5

# The scanner should clean these up automatically
# If they persist, check that the background tasks are running
```

### Admin API for Diagnostics

The Admin API provides detailed diagnostics:

```bash
# Server info (edition, version, features)
curl http://localhost:9000/_neolith/v1/info | jq .

# Cluster node status
curl http://localhost:9000/_neolith/admin/v1/nodes | jq .

# Heal status
curl http://localhost:9000/_neolith/admin/v1/heal/status | jq .

# Rebalance status
curl http://localhost:9000/_neolith/admin/v1/rebalance/status | jq .

# Pool status
curl http://localhost:9000/_neolith/admin/v1/pools | jq .

# Drain status (during shutdown)
curl http://localhost:9000/_neolith/admin/v1/drain | jq .

# Prometheus metrics
curl http://localhost:9000/metrics | grep neolith_
```

### Metrics-Based Diagnosis

| Symptom | Metric to Check | What to Look For |
|---|---|---|
| Slow GETs | `neolith_request_duration_seconds{method="GET"}` | p99 > 100ms |
| High error rate | `neolith_requests_total{status!~"2.."}` | Rate increasing |
| Memory growth | `neolith_process_rss_bytes` | Monotonically increasing |
| FD exhaustion | `neolith_process_open_fds` | Approaching ulimit |
| Cache inefficiency | `neolith_listing_cache_misses` | High miss rate |
| Compression waste | `neolith_compression_skipped` | Zero (smart skip disabled?) |
| Auth attacks | `neolith_auth_failure_total` | Sudden spike |

## Performance Issues

### Slow PUT Operations

1. **Check compression**: If objects are incompressible (images, video, pre-compressed), ensure `smart_skip = true` to avoid wasting CPU
2. **Check encryption**: SSE-S3 adds ~10% overhead for the HKDF + AES-256-GCM pipeline
3. **Check disk I/O**: `iostat -x 1` for per-drive utilization. If any drive is at 100%, it is a bottleneck
4. **Check EC overhead**: Higher parity ratios require more compute. RS 8+4 is well-balanced for most workloads

### Slow GET Operations

1. **Check listing cache**: High miss rate means objects are being scanned from disk instead of the cache
2. **Check heal activity**: Active healing consumes I/O budget. Reduce `io_budget_bytes_per_sec` if needed
3. **Check object size**: Very small objects (< 1KB) have high per-object overhead. Use the batch API instead
4. **Check encryption**: Decryption is the inverse of encryption - similar overhead

### High Memory Usage

1. **Listing cache**: Grows proportionally with the number of objects. Each entry is small (key + metadata)
2. **ETL cache index**: Grows with the number of cached transform results
3. **Prefetch buffers**: Server-side prefetch for batch API consumes memory per active epoch
4. **Multipart state**: In-progress multipart uploads hold part metadata in memory (cleaned up after 24h TTL)

## Getting Help

If the troubleshooting steps above do not resolve your issue:

1. Collect diagnostic information:
   ```bash
   neolith version
   neolith cluster info --output json > cluster-info.json
   neolith admin heal status --output json > heal-status.json
   curl http://localhost:9000/metrics > metrics.txt
   ```

2. Capture relevant logs with debug verbosity:
   ```bash
   RUST_LOG=debug neolith server start --config /etc/neolith/config.toml /mnt/disk{1...4} 2> debug.log
   ```

3. Check the GitHub Issues at [github.com/muratkars/neolith](https://github.com/muratkars/neolith) for known issues.
