---
sidebar_position: 5
title: "Audit Logging"
---

# Audit Logging

Neolith Enterprise's `neolith-audit` crate provides a tamper-evident audit logging system based on hash-chain integrity. Every API operation is recorded in an append-only log that can be independently verified for completeness and authenticity.

## Hash-Chain Design

Neolith's audit log is structured as a hash chain. Each log entry includes the BLAKE3 hash of the previous entry, creating a cryptographic chain that makes tampering detectable:

```
Entry N-1                     Entry N                       Entry N+1
┌────────────────────┐       ┌────────────────────┐       ┌────────────────────┐
│ timestamp          │       │ timestamp          │       │ timestamp          │
│ operation          │       │ operation          │       │ operation          │
│ principal          │       │ principal          │       │ principal          │
│ resource           │       │ resource           │       │ resource           │
│ result             │       │ result             │       │ result             │
│ prev_hash: H(N-2)  │──>    │ prev_hash: H(N-1)  │──>    │ prev_hash: H(N)    │
│ hash: H(N-1)       │       │ hash: H(N)         │       │ hash: H(N+1)       │
└────────────────────┘       └────────────────────┘       └────────────────────┘
```

If any entry is modified, deleted, or inserted out of order, the hash chain breaks. Verification walks the chain from the genesis entry and confirms that each entry's `prev_hash` matches the preceding entry's `hash`.

## What Gets Logged

Every API operation that modifies state is logged. Read operations are logged when audit-level logging is enabled:

| Operation Category | Operations Logged |
|---|---|
| **Object writes** | PutObject, DeleteObject, CopyObject, CompleteMultipartUpload |
| **Object reads** | GetObject, HeadObject (when verbose audit enabled) |
| **Bucket management** | CreateBucket, DeleteBucket, PutBucketVersioning, PutBucketLifecycle |
| **Access control** | PutBucketPolicy, PutBucketCors, PutObjectLockConfiguration |
| **Authentication** | Login, STS GetSessionToken, failed authentication attempts |
| **Admin operations** | Heal, Rebalance, Decommission, Pool management |
| **Compliance** | Legal hold changes, retention changes, Object Lock configuration |
| **Tenant management** | Tenant creation, deletion, quota changes |

## Audit Entry Structure

Each audit entry contains:

```json
{
  "sequence": 1042,
  "timestamp": "2026-03-15T14:30:00.123456Z",
  "operation": "PutObject",
  "principal": {
    "type": "iam_user",
    "id": "AKIAIOSFODNN7EXAMPLE",
    "tenant_id": "acme-corp"
  },
  "resource": {
    "type": "object",
    "bucket": "training-data",
    "key": "dataset/batch-001.tar.lz4",
    "version_id": "v_01HQXYZ..."
  },
  "request": {
    "method": "PUT",
    "uri": "/training-data/dataset/batch-001.tar.lz4",
    "source_ip": "10.0.1.42",
    "user_agent": "aws-sdk-rust/1.0",
    "request_id": "req_550e8400-e29b..."
  },
  "result": {
    "status": 200,
    "bytes_transferred": 104857600,
    "duration_ms": 245
  },
  "metadata": {
    "content_type": "application/octet-stream",
    "encryption": "AES256",
    "etag": "a1b2c3d4..."
  },
  "prev_hash": "b3a1d9f2e4c6...",
  "hash": "7f2e4a1c8b3d..."
}
```

## Searching the Audit Log

The audit log supports indexed queries across multiple dimensions:

```bash
# Search by time range
curl "http://localhost:9000/_neolith/admin/v1/audit/search?\
start=2026-03-01T00:00:00Z&\
end=2026-03-15T23:59:59Z"

# Search by principal
curl "http://localhost:9000/_neolith/admin/v1/audit/search?\
principal=AKIAIOSFODNN7EXAMPLE"

# Search by operation type
curl "http://localhost:9000/_neolith/admin/v1/audit/search?\
operation=DeleteObject&\
bucket=production-data"

# Search by resource
curl "http://localhost:9000/_neolith/admin/v1/audit/search?\
bucket=compliance-records&\
key_prefix=financial/"

# Combined filters
curl "http://localhost:9000/_neolith/admin/v1/audit/search?\
operation=PutObject&\
tenant_id=acme-corp&\
start=2026-03-14T00:00:00Z&\
limit=100"
```

Search results include pagination via cursor-based tokens:

```json
{
  "entries": [...],
  "next_cursor": "eyJzZXF1ZW5jZSI6MTA0Mn0=",
  "total_count": 15234
}
```

## Verification

The hash chain can be verified independently to prove that the audit log has not been tampered with:

```bash
# Verify the entire chain
curl -X POST "http://localhost:9000/_neolith/admin/v1/audit/verify"

# Response
{
  "verified": true,
  "entries_checked": 1042,
  "first_sequence": 1,
  "last_sequence": 1042,
  "genesis_hash": "a1b2c3d4...",
  "latest_hash": "7f2e4a1c..."
}
```

If the chain is broken (a gap, modification, or insertion is detected), the verification response reports the exact location of the break:

```json
{
  "verified": false,
  "entries_checked": 523,
  "break_at_sequence": 524,
  "expected_prev_hash": "b3a1d9f2...",
  "actual_prev_hash": "MISMATCH",
  "error": "Hash chain break detected at sequence 524"
}
```

## Export

Audit logs can be exported for external analysis, long-term archival, or feeding into SIEM systems:

| Format | Use Case |
|---|---|
| **JSON Lines** | Machine-readable, one entry per line, suitable for log aggregation (Elasticsearch, Splunk) |
| **CSV** | Spreadsheet analysis, regulatory reporting |
| **Parquet** | Analytics-optimized columnar format, suitable for data lake integration |

```bash
# Export as JSON Lines
curl "http://localhost:9000/_neolith/admin/v1/audit/export?\
format=jsonl&\
start=2026-01-01T00:00:00Z&\
end=2026-03-31T23:59:59Z" \
  -o audit-q1-2026.jsonl

# Export as CSV
curl "http://localhost:9000/_neolith/admin/v1/audit/export?\
format=csv&\
start=2026-03-01T00:00:00Z" \
  -o audit-march-2026.csv
```

## Retention and Rotation

Audit logs have their own retention policy, independent of object lifecycle:

```toml
[enterprise.audit]
enabled = true
verbose_reads = false  # Log GET/HEAD operations
retention_days = 2555  # 7 years for SEC 17a-4(f)
rotation_size_mb = 1024  # Rotate log files at 1 GiB
rotation_interval_hours = 24  # Or rotate every 24 hours
hash_algorithm = "blake3"
export_on_rotation = true
export_format = "jsonl"
export_path = "/var/neolith/audit/archive/"
```

## Security Considerations

- **Append-only**: The audit subsystem only supports append operations. There is no API to delete or modify audit entries.
- **Separate storage**: Audit logs are stored separately from object data. A storage node failure does not destroy the audit trail.
- **Access control**: Only principals with the `neolith:AuditRead` permission can search or export audit logs. Only `neolith:AuditAdmin` can configure audit settings.
- **Hash chain**: Even if an attacker gains write access to the audit storage, any modification is detectable via chain verification.
- **Immutable export**: Exported audit logs include the hash chain, enabling offline verification without access to the running cluster.
