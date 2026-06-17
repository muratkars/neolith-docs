---
sidebar_position: 2
title: "Limits Reference"
---

# Limits Reference

Neolith enforces limits at multiple levels to protect against resource exhaustion, ensure S3 compatibility, and maintain predictable performance. This page documents every limit, its default, whether it is configurable, and what happens at the boundary.

## Runtime Introspection

Query all effective limits from a running server:

```bash
# Admin API
curl http://localhost:9000/_neolith/admin/v1/limits | jq .

# CLI
neolith admin limits
```

The response includes each limit's name, current value, source (config or S3 spec), and whether it can be changed via config reload.

---

## S3 Request Limits

| Limit | Default | Config key | Range | Boundary behavior |
|-------|---------|-----------|-------|-------------------|
| Max single-PUT body size | 512 MiB | `server.max_body_size_bytes` | 1 MiB - 5 GiB | HTTP 413 Payload Too Large |
| Max POST body size | 512 MiB | (same as PUT) | 1 MiB - 5 GiB | S3 error: body exceeds maximum |
| Max object key length | 1024 bytes | `server.max_key_length` | 1 - 2048 | S3 error: InvalidObjectName |
| Max tags per object | 10 | `server.max_tags_per_object` | 1 - 50 | S3 error: invalid request |
| Max tag key length | 128 bytes | (fixed) | - | S3 error: tag key too long |
| Max tag value length | 256 bytes | (fixed) | - | S3 error: tag value too long |
| Max bucket tags | 50 | (fixed) | - | S3 error: too many tags |
| SigV4 clock skew | 900s (15 min) | `server.max_clock_skew_seconds` | 60 - 3600 | S3 error: RequestTimeTooSkewed |
| Presigned URL max expiry | 7 days | (S3 spec) | - | S3 error: invalid expiry |
| STS session duration | 900 - 43200s | (S3 spec) | - | Clamped to range |

### Notes

- **Large file uploads**: Files over 512 MiB (or your configured limit) must use S3 multipart upload. The web console automatically switches to multipart for files >= 64 MiB.
- **Key length**: Increasing beyond 1024 may break S3 SDK clients that assume the spec limit.
- **Clock skew**: Lowering below 300s may reject clients with minor NTP drift.

---

## Multipart Upload Limits

| Limit | Default | Config key | Range | Boundary behavior |
|-------|---------|-----------|-------|-------------------|
| Min part size | 5 MiB | (S3 spec) | - | S3 error on complete |
| Max parts per upload | 10,000 | (S3 spec) | - | S3 error: InvalidPart |
| Max concurrent uploads | 10,000 | `multipart.max_concurrent_uploads` | 1+ | HTTP 503 Service Unavailable |
| Upload TTL | 24 hours | `multipart.upload_ttl_secs` | 1+ | Expired uploads auto-cleaned |
| Part spill threshold | 1 MiB | `multipart.spill_threshold_bytes` | 1+ | Parts above threshold spill to disk |

### Notes

- **Spill threshold** must not exceed `server.max_body_size_bytes` (validated at startup).
- The cleanup task runs every 5 minutes and removes uploads older than the TTL.

---

## Concurrency and Throughput Limits

| Limit | Default | Config key | Range | Boundary behavior |
|-------|---------|-----------|-------|-------------------|
| LIST parallelism | 32 | `server.list_parallelism` | 1 - 256 | Semaphore-bounded; excess waits |
| Global rate limit | 10,000 ops/s | `rate_limit.global_ops_per_sec` | 1+ | HTTP 429 Too Many Requests |
| Per-credential rate limit | 1,000 ops/s | `rate_limit.per_credential_ops_per_sec` | 1+ | HTTP 429 Too Many Requests |
| Rate limit burst multiplier | 2.0x | `rate_limit.burst_multiplier` | 1.0+ | Token bucket allows burst up to N*multiplier |
| Heal concurrency | 4 | `heal.max_concurrent` | 1+ | Excess heals queued |
| Heal queue size | 100,000 | `heal.max_queue_size` | 0+ | Excess dropped with warning |
| Batch fetch concurrency | 32 | (fixed) | - | Semaphore-bounded |

---

## Storage Limits

| Limit | Default | Config key | Boundary behavior |
|-------|---------|-----------|-------------------|
| Inline threshold | 128 KiB | `server.inline_threshold_bytes` | Objects at/below: stored in meta.fb. Above: erasure-coded |
| Min free disk space | 1 GiB | `cluster.min_free_disk_bytes` | HTTP 507 Insufficient Storage |
| Quarantine max age | 7 days | `quarantine.max_age_days` | Expired items auto-purged |
| Quarantine max size | 1 GiB | `quarantine.max_size_gb` | Oldest items evicted |
| ETL cache max size | 10 GiB | `etl.cache_max_bytes` | LRU eviction |
| Bloom filter FP rate | 0.1% | (fixed) | Affects LIST cache accuracy |

---

## Compression Limits

| Limit | Default | Config key | Range | Boundary behavior |
|-------|---------|-----------|-------|-------------------|
| Entropy threshold | 7.5 bits/byte | `compression.entropy_threshold` | 0.0 - 8.0 | Data above threshold: compression skipped |

### Notes

- Entropy is sampled from the first 4 KiB of data. Values near 8.0 indicate random/encrypted data.
- The threshold is reloadable via `SIGHUP` or the Admin API.

---

## ETL/WASM Limits

| Limit | Default | Config key | Boundary behavior |
|-------|---------|-----------|-------------------|
| WASM memory | 64 MiB | `etl.wasm_max_memory_bytes` | WASM trap: out of memory |
| WASM fuel | 10M instructions | `etl.wasm_fuel_limit` | WASM trap: out of fuel |
| WASM timeout | 30s | `etl.wasm_timeout_secs` | Transform cancelled |

---

## Batch API Limits

| Limit | Default | Config key | Boundary behavior |
|-------|---------|-----------|-------------------|
| Max batch size | 1,000 objects | `batch.max_batch_size` | Request rejected |
| Max concurrent epochs | 100 | `batch.max_concurrent_epochs` | Registration rejected |
| Prefetch memory budget | 1 GiB | `batch.memory_budget_bytes` | Backpressure (blocks until consumed) |

---

## Protocol Constants (Not Configurable)

These values are mandated by the S3 protocol specification and cannot be changed without breaking client compatibility:

| Constant | Value | Why |
|----------|-------|-----|
| `MIN_PART_SIZE` | 5 MiB | S3 spec: all parts except the last must be >= 5 MiB |
| `MAX_PARTS` | 10,000 | S3 spec: maximum parts per multipart upload |
| `MAX_PRESIGNED_EXPIRES` | 604,800s (7 days) | S3 spec: maximum presigned URL lifetime |
| `STS_MIN_DURATION` | 900s (15 min) | AWS STS spec: minimum session duration |
| `STS_MAX_DURATION` | 43,200s (12 hours) | AWS STS spec: maximum session duration |

## Structural Constants (Not Configurable)

These values are baked into the storage format. Changing them would require a data migration:

| Constant | Value | Why |
|----------|-------|-----|
| AES-GCM block size | 64 KiB | Changing breaks existing encrypted data |
| Meta header size | 10 bytes | Changing breaks existing metadata files |
| TCH partitions | 16,384 | Changing requires full data rebalance |
| TAR block size | 512 bytes | POSIX ustar specification |

---

## Validation

All configurable limits are validated at server startup. Invalid values prevent the server from starting with a descriptive error message. Cross-field consistency is also checked:

- `multipart.spill_threshold_bytes` must not exceed `server.max_body_size_bytes`

Run `neolith server start --config config.toml` to verify your configuration before deploying.
