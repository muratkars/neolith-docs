---
sidebar_position: 5
title: "Backup & Archive"
---

# Backup and Archive

Neolith provides the durability, encryption, and lifecycle management features required for backup and archival storage. Erasure coding protects data against drive and node failures with lower overhead than replication. Server-side encryption secures data at rest. Object versioning enables point-in-time recovery. Lifecycle rules automate retention and expiration. Bucket forks create lightweight snapshots without copying data.

## Erasure Coding Durability

Neolith uses Reed-Solomon (RS) and Locally Repairable Codes (LRC) to protect data against hardware failures. Unlike replication (which stores 2-3 full copies), erasure coding splits data into data shards and parity shards, achieving the same durability with significantly less overhead.

### Durability Profiles

| Configuration | Data Shards | Parity Shards | Overhead | Tolerates |
|---|---|---|---|---|
| RS(4, 2) | 4 | 2 | 1.5x | 2 drive failures |
| RS(8, 4) | 8 | 4 | 1.5x | 4 drive failures |
| RS(10, 4) | 10 | 4 | 1.4x | 4 drive failures |
| LRC(10, 4, 2) | 10 | 4 global + 2 local | 1.6x | 4 global + fast local repair |

LRC adds local parity shards that enable single-shard repair by reading only a subset of shards (typically 5 instead of 10), reducing repair I/O by ~75%.

### Self-Healing

Neolith continuously monitors data integrity:

- **Background scanner**: Walks all objects on a 30-day cycle, verifying BLAKE3 checksums for every shard
- **On-read verification**: Every GET checks shard integrity. Corrupted shards are repaired immediately and the object is returned without error
- **Priority repair queue**: Failed shards are ranked by criticality (remaining parity margin), hotness (access frequency), and age. Critical repairs run first
- **Automatic reconstruction**: Missing or corrupt shards are reconstructed from surviving shards and written back to healthy drives

No manual intervention is required. Neolith heals itself.

## Encryption at Rest

All backup data can be encrypted at the storage layer before it touches disk.

### SSE-S3 (Server-Managed Keys)

Neolith manages the encryption keys. Each object gets a unique Data Encryption Key (DEK) derived via HKDF from a master key. The master key is configured at server startup:

```bash
# Start server with master key (from environment variable)
export NEOLITH_MASTER_KEY="your-256-bit-hex-key"
neolith server start /data

# Upload with SSE-S3 encryption
aws --endpoint-url http://neolith:9000 s3 cp backup.tar.gz s3://backups/ \
  --sse AES256
```

Encryption details:

- **Algorithm**: AES-256-GCM with 64KB AEAD blocks
- **Key derivation**: HKDF from master key, per-object unique DEK
- **Crypto library**: aws-lc-rs (FIPS 140-3 capable)

### SSE-C (Customer-Provided Keys)

You provide the encryption key with each request. Neolith never stores the key - only a BLAKE3 hash for verification:

```bash
# Generate a 256-bit key
KEY=$(openssl rand -base64 32)
KEY_MD5=$(echo -n "$KEY" | openssl dgst -md5 -binary | base64)

# Upload with customer key
aws --endpoint-url http://neolith:9000 s3api put-object \
  --bucket backups \
  --key database-dump.sql.gz \
  --body database-dump.sql.gz \
  --sse-customer-algorithm AES256 \
  --sse-customer-key "$KEY" \
  --sse-customer-key-md5 "$KEY_MD5"
```

SSE-C is ideal for backup workloads where you want to control key rotation and revocation independently of the storage system.

### Encryption Comparison

| Feature | SSE-S3 | SSE-C |
|---|---|---|
| Key management | Server-side (master key) | Client-side (per-request) |
| Key storage | Master key in config/env | You manage keys externally |
| Transparency | Automatic decrypt on GET | Must provide key on GET |
| Use case | General encryption at rest | Compliance, key rotation, multi-tenant |

## Object Versioning for Point-in-Time Recovery

Versioning retains every version of every object, enabling recovery from accidental deletion or corruption.

### Enabling Versioning

```bash
# Enable versioning on the backup bucket
aws --endpoint-url http://neolith:9000 s3api put-bucket-versioning \
  --bucket backups \
  --versioning-configuration Status=Enabled
```

### Recovery Scenarios

**Accidental deletion**: When versioning is enabled, DELETE creates a delete marker instead of removing data. The previous version is still accessible:

```bash
# Oops - accidentally deleted a backup
aws --endpoint-url http://neolith:9000 s3 rm s3://backups/database-daily.sql.gz

# List versions to find it
aws --endpoint-url http://neolith:9000 s3api list-object-versions \
  --bucket backups \
  --prefix database-daily.sql.gz

# Restore by deleting the delete marker
aws --endpoint-url http://neolith:9000 s3api delete-object \
  --bucket backups \
  --key database-daily.sql.gz \
  --version-id "delete-marker-version-id"
```

**Accidental overwrite**: Use `get-object --version-id` to retrieve the specific version from before the overwrite.

**Point-in-time recovery**: List versions with `list-object-versions` and filter by `LastModified` timestamp to find the exact state at any point in time.

## Lifecycle Rules for Automated Expiration

Lifecycle rules enforce retention policies without manual intervention:

```bash
aws --endpoint-url http://neolith:9000 s3api put-bucket-lifecycle-configuration \
  --bucket backups \
  --lifecycle-configuration '{
    "Rules": [
      {
        "ID": "daily-backup-retention",
        "Status": "Enabled",
        "Filter": {"Prefix": "daily/"},
        "Expiration": {"Days": 30},
        "NoncurrentVersionExpiration": {"NoncurrentDays": 7}
      },
      {
        "ID": "weekly-backup-retention",
        "Status": "Enabled",
        "Filter": {"Prefix": "weekly/"},
        "Expiration": {"Days": 365},
        "NoncurrentVersionExpiration": {"NoncurrentDays": 30}
      },
      {
        "ID": "archive-retention",
        "Status": "Enabled",
        "Filter": {"Prefix": "archive/"},
        "NoncurrentVersionExpiration": {"NoncurrentDays": 2555}
      }
    ]
  }'
```

### Retention Strategy

| Backup Type | Current Retention | Version Retention | Key Prefix |
|---|---|---|---|
| Hourly snapshots | 7 days | 1 day | `hourly/` |
| Daily backups | 30 days | 7 days | `daily/` |
| Weekly backups | 1 year | 30 days | `weekly/` |
| Monthly archives | Never (manual) | 7 years | `archive/` |

The background lifecycle scanner runs hourly, evaluating rules against object metadata and cleaning up expired objects automatically.

## Bucket Forks for Snapshot-Based Backup

Bucket forks create instant, zero-copy snapshots of a bucket's state. Unlike versioning (which tracks changes over time), a fork captures the complete state at a single point in time:

```bash
# Create a snapshot fork before a risky migration
curl -X POST http://neolith:9000/production-data?fork \
  -d '{"name": "production-data-snapshot-20260328"}'

# The fork is now an independent copy-on-write snapshot
# Any changes to production-data do NOT affect the fork

# If the migration goes wrong, read from the snapshot
aws --endpoint-url http://neolith:9000 s3 cp \
  s3://production-data-snapshot-20260328/critical-table.parquet ./restored.parquet

# Clean up old snapshots with lifecycle rules or manual deletion
```

### Forks vs. Versioning

| Feature | Versioning | Bucket Forks |
|---|---|---|
| Granularity | Per-object | Entire bucket |
| Storage cost | Each version stored independently | Copy-on-write (shared data) |
| Point-in-time | Must reconstruct from version history | Instant snapshot of full state |
| Use case | Protect individual objects | Pre-migration snapshots, environment cloning |
| Cleanup | Lifecycle rules per version | Delete the fork bucket |

Both features can be used together: versioning protects against individual object changes, while forks protect against broad operational mistakes.

Data durability is ensured at every layer: erasure coding tolerates hardware failures, checksums detect silent corruption, encryption protects confidentiality, versioning enables recovery, and lifecycle rules enforce retention policy.
