---
sidebar_position: 3
title: "Backup & DR"
---

# Backup & Disaster Recovery

Neolith provides multiple layers of data protection, from erasure coding (inherent redundancy) to object versioning (point-in-time recovery) to cross-site replication (Enterprise). This page covers backup strategies and disaster recovery planning.

## Inherent Data Protection

### Erasure Coding

Every object stored in Neolith is erasure-coded across multiple drives. The default configuration (Reed-Solomon 8+4) splits each object into 8 data shards and 4 parity shards, tolerating up to 4 simultaneous drive failures without data loss.

| EC Configuration | Storage Overhead | Drive Failures Tolerated |
|---|---|---|
| RS 4+2 | 1.5x | 2 |
| RS 8+4 | 1.5x | 4 |
| RS 12+3 | 1.25x | 3 |
| LRC 10+4+2 | 1.6x | 4 (global), fast local repair for single failures |

Erasure coding is not a backup - it protects against hardware failures but not against accidental deletion, software bugs, or site-level disasters.

### Self-Healing

The background scanner continuously verifies data integrity (BLAKE3 checksums) and automatically repairs corrupted shards from parity data. See [Self-Healing](./healing) for details.

## Object Versioning

Object versioning is the primary mechanism for point-in-time recovery within a single Neolith cluster.

### Enabling Versioning

```python
import boto3

s3 = boto3.client("s3", endpoint_url="http://localhost:9000",
                   aws_access_key_id="key", aws_secret_access_key="secret")

s3.put_bucket_versioning(
    Bucket="production-data",
    VersioningConfiguration={"Status": "Enabled"},
)
```

### How Versioning Works

When versioning is enabled:

- **PUT**: Creates a new version. The `meta.neo` file always points to the latest version. Previous versions are stored in the `v/` subdirectory with UUID-based version IDs.
- **DELETE**: Creates a delete marker (`is_delete_marker=true` in metadata) instead of removing data. The object appears deleted to LIST and GET, but previous versions remain accessible via version ID.
- **GET with version ID**: Retrieves a specific version, bypassing the latest pointer.

### Recovering Deleted Objects

```python
# List versions (including delete markers)
response = s3.list_object_versions(Bucket="production-data", Prefix="important-file.txt")

# Find the most recent non-delete-marker version
for version in response.get("Versions", []):
    if not version.get("IsDeleteMarker", False):
        print(f"Recovering version: {version['VersionId']}")
        # Copy the old version to the current key
        s3.copy_object(
            Bucket="production-data",
            Key="important-file.txt",
            CopySource={
                "Bucket": "production-data",
                "Key": "important-file.txt",
                "VersionId": version["VersionId"],
            },
        )
        break
```

### Recovering from Accidental Overwrites

With versioning enabled, every PUT creates a new version. To revert to a previous version:

```python
# List all versions of an object
response = s3.list_object_versions(
    Bucket="production-data",
    Prefix="config.json",
)

for v in response.get("Versions", []):
    print(f"Version: {v['VersionId']} Modified: {v['LastModified']} Size: {v['Size']}")

# Restore a specific version
s3.copy_object(
    Bucket="production-data",
    Key="config.json",
    CopySource={
        "Bucket": "production-data",
        "Key": "config.json",
        "VersionId": "target-version-id",
    },
)
```

## Lifecycle Rules for Version Cleanup

Without lifecycle rules, versioning accumulates storage indefinitely. Configure lifecycle rules to automatically expire old versions:

```python
s3.put_bucket_lifecycle_configuration(
    Bucket="production-data",
    LifecycleConfiguration={
        "Rules": [
            {
                "ID": "expire-old-versions",
                "Prefix": "",
                "Status": "Enabled",
                "NoncurrentVersionExpiration": {
                    "NoncurrentDays": 30,
                },
            },
        ],
    },
)
```

This keeps the last 30 days of versions for all objects. The background lifecycle scanner runs hourly and evaluates rules against each object's metadata and tags.

Rules support filtering by:
- **Prefix**: Apply rules to specific key prefixes
- **Tags**: Apply rules based on object tags (e.g., `retention=7d`)

## Backup Strategies

### Strategy 1: Versioning + Lifecycle (Same Cluster)

Best for: Protection against accidental deletion or overwrites.

```
[Enable versioning] --> [Set lifecycle: keep 30 days] --> [Automatic cleanup]
```

Advantages:
- Zero operational overhead
- Instant recovery via version ID
- Automatic cleanup of old versions

Limitations:
- Does not protect against cluster-level disasters
- Does not protect against data corruption at the application level

### Strategy 2: Cross-Bucket Copy (Same Cluster)

Best for: Isolating backup data from production data.

```bash
# Periodic backup via aws-cli sync
aws --endpoint-url http://localhost:9000 \
  s3 sync s3://production-data/ s3://backup-production/ \
  --delete
```

Advantages:
- Backup is in a separate bucket (different access controls)
- Simple to implement with standard tools

Limitations:
- Same cluster - does not protect against site-level disasters
- Double storage usage

### Strategy 3: Cross-Cluster Replication

Best for: Site-level disaster recovery.

For OSS deployments, use periodic sync between clusters:

```bash
# Cron job: sync production cluster to DR cluster
aws --endpoint-url http://production:9000 \
  s3 sync s3://production-data/ - | \
aws --endpoint-url http://dr-site:9000 \
  s3 sync - s3://production-data-replica/
```

For Neolith Enterprise, cross-site replication is built-in and operates continuously.

### Strategy 4: Filesystem-Level Backup

Best for: Full cluster recovery from bare metal.

Back up the entire data directory using filesystem tools:

```bash
# ZFS snapshot (if using ZFS)
zfs snapshot tank/neolith@daily-$(date +%Y%m%d)

# rsync (for any filesystem)
rsync -av /mnt/disk1/ /backup/disk1/
```

When restoring:
1. Stop the Neolith server
2. Restore the data directories
3. Start the server - it will rebuild the listing cache from disk
4. The lazy migration scanner will upgrade any v1 (bincode) metadata to v2 (FlatBuffers)

## Disaster Recovery Plan

### RPO and RTO

| Strategy | RPO (Data Loss Window) | RTO (Recovery Time) |
|---|---|---|
| Versioning (same cluster) | 0 (no data loss for overwrites/deletes) | Seconds (version restore) |
| Cross-bucket copy | Sync interval (e.g., 1 hour) | Minutes (bucket redirect) |
| Cross-cluster sync | Sync interval | Minutes to hours |
| Enterprise replication | Near-zero (continuous) | Minutes (failover) |
| Filesystem backup | Backup interval | Hours (full restore) |

### Recovery Procedures

#### Drive Failure

1. Replace the failed drive
2. Start the server (if not already running)
3. Trigger a full heal scan: `neolith admin heal trigger --full-scan`
4. Monitor progress: `neolith admin heal status`
5. Healing reconstructs all shards that were on the failed drive

#### Node Failure

1. If the node is recoverable: restart it and trigger a heal scan
2. If the node is permanently lost:
   - Decommission it: `neolith admin decommission <node-id> --force`
   - Neolith reconstructs all data from parity shards on surviving nodes
   - Add a replacement node to the cluster
   - Trigger rebalance: `neolith admin rebalance start`

#### Site-Level Disaster

1. Redirect traffic to the DR site
2. If using cross-cluster sync: data since last sync is lost
3. If using Enterprise replication: minimal data loss (continuous sync)
4. Rebuild the primary site from the DR copy when ready

## Data Integrity Verification

Beyond the automatic background scanner, you can manually verify data integrity:

```bash
# Trigger a targeted heal on a specific bucket
neolith admin heal trigger --bucket critical-data

# Trigger a full cluster-wide scan
neolith admin heal trigger --full-scan

# Check heal status
neolith admin heal status
```

For high-value data, consider enabling deep scan (full EC decode verification) which catches issues beyond simple checksum corruption:

```toml
[deep_scan]
inter_object_delay_ms = 50
max_concurrent_verifies = 2
```
