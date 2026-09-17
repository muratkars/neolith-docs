---
sidebar_position: 7
title: "Lifecycle Rules"
---

# Lifecycle Rules

Lifecycle rules automate the expiration, cleanup and tiering of objects in a bucket. Neolith supports expiration-based policies for both current and noncurrent object versions, and `Transition` rules that move an object's bytes to a remote S3-compatible tier while the object stays readable at its key.

## Configuring Lifecycle Rules

### PutBucketLifecycleConfiguration

**Request:**

```
PUT /<bucket>?lifecycle HTTP/1.1
Host: localhost:9000
Content-Type: application/xml

<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Rule>
    <ID>expire-logs-30d</ID>
    <Status>Enabled</Status>
    <Filter>
      <Prefix>logs/</Prefix>
    </Filter>
    <Expiration>
      <Days>30</Days>
    </Expiration>
  </Rule>
</LifecycleConfiguration>
```

**mc:**

```bash
# Create a lifecycle configuration file
cat > lifecycle.json << 'EOF'
{
  "Rules": [
    {
      "ID": "expire-logs-30d",
      "Status": "Enabled",
      "Filter": {
        "Prefix": "logs/"
      },
      "Expiration": {
        "Days": 30
      }
    },
    {
      "ID": "expire-temp-1d",
      "Status": "Enabled",
      "Filter": {
        "Prefix": "tmp/"
      },
      "Expiration": {
        "Days": 1
      }
    },
    {
      "ID": "cleanup-old-versions",
      "Status": "Enabled",
      "Filter": {
        "Prefix": ""
      },
      "NoncurrentVersionExpiration": {
        "NoncurrentDays": 90
      }
    }
  ]
}
EOF

# Apply lifecycle configuration
mc ilm import myn/my-bucket < lifecycle.json
```

**curl:**

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  -X PUT \
  -H "Content-Type: application/xml" \
  -d @lifecycle.xml \
  "http://localhost:9000/my-bucket?lifecycle"
```

### GetBucketLifecycleConfiguration

**mc:**

```bash
mc ilm export myn/my-bucket
```

**Response (200 OK):**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Rule>
    <ID>expire-logs-30d</ID>
    <Status>Enabled</Status>
    <Filter>
      <Prefix>logs/</Prefix>
    </Filter>
    <Expiration>
      <Days>30</Days>
    </Expiration>
  </Rule>
  <Rule>
    <ID>cleanup-old-versions</ID>
    <Status>Enabled</Status>
    <Filter>
      <Prefix></Prefix>
    </Filter>
    <NoncurrentVersionExpiration>
      <NoncurrentDays>90</NoncurrentDays>
    </NoncurrentVersionExpiration>
  </Rule>
</LifecycleConfiguration>
```

### DeleteBucketLifecycleConfiguration

**mc:**

```bash
mc ilm rm --all --force myn/my-bucket
```

**curl:**

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  -X DELETE \
  "http://localhost:9000/my-bucket?lifecycle"
```

**Response:** `204 No Content` on success.

## Lifecycle Rule Structure

### LifecycleRule Fields

| Field | Description |
|---|---|
| `ID` | Unique identifier for the rule |
| `Status` | `Enabled` or `Disabled` |
| `Filter.Prefix` | Apply rule only to keys matching this prefix |
| `Filter.Tag` | Apply rule only to objects with matching tags |
| `Expiration.Days` | Delete current version after N days |
| `Expiration.Date` | Delete current version after this date |
| `NoncurrentVersionExpiration.NoncurrentDays` | Delete noncurrent versions after N days |

### Filter with Tags

Rules can filter by both prefix and tags:

```json
{
  "ID": "expire-processed",
  "Status": "Enabled",
  "Filter": {
    "And": {
      "Prefix": "data/",
      "Tags": [
        {"Key": "status", "Value": "processed"}
      ]
    }
  },
  "Expiration": {
    "Days": 7
  }
}
```

## Expiration Behavior

### Unversioned Buckets

For buckets without versioning enabled, expiration performs a **hard delete** - the object metadata and data are permanently removed.

### Versioned Buckets

For versioned buckets, expiration creates a **delete marker** on the current version rather than deleting data. This is consistent with the S3 specification:

- `Expiration.Days` on a versioned bucket: creates a delete marker for the current version
- `NoncurrentVersionExpiration.NoncurrentDays`: permanently deletes noncurrent versions older than N days

### Example: Version Lifecycle

```
Day 0:  PUT config.json (version v1) - v1 is current
Day 10: PUT config.json (version v2) - v2 is current, v1 is noncurrent
Day 15: PUT config.json (version v3) - v3 is current, v2 noncurrent (5d), v1 noncurrent (15d)

With NoncurrentVersionExpiration.NoncurrentDays = 30:
Day 40:  v1 becomes noncurrent for 30 days - deleted by lifecycle scanner
Day 45:  v2 becomes noncurrent for 35 days - deleted by lifecycle scanner
```

## Background Scanner

Neolith runs a background lifecycle scanner with a **1-hour interval**. On each scan:

1. Iterate over all buckets that have lifecycle rules
2. For each bucket, iterate over all objects
3. Evaluate each rule's filter (prefix, tags) against the object
4. For matching objects, check if the expiration condition is met
5. Expire the object (hard delete for unversioned, delete marker for versioned)

The scanner logs its actions and skips disabled rules.

## Storage Sidecar

Lifecycle configuration is stored as a `.lifecycle.json` sidecar file in the bucket directory. This avoids requiring an embedded database and keeps the system metadata alongside the bucket data.

```
<data-root>/<bucket>/
  .lifecycle.json     # Lifecycle rules
  .versioning.json    # Versioning state
  .cors.json          # CORS configuration
```

## Transitions and Cloud Tiering

A `Transition` rule names a storage class. When a configured tier target carries that name, the lifecycle scanner moves matching objects to it; without one, the transition is a metadata-only class change.

### Configuring a tier target

Tier targets are declared in the server config. The `name` is the `StorageClass` a rule refers to.

```toml
[[tiers]]
name = "GLACIER"                     # the StorageClass a Transition rule names
provider = "s3"                      # only "s3" moves bytes today (see below)
endpoint = "https://s3.example.com"  # any S3-compatible endpoint
bucket = "neolith-archive"           # objects land under <bucket>/<source-bucket>/<key>
access_key = "AKIA..."               # optional: unsigned requests when omitted
secret_key = "..."
region = "us-east-1"                 # optional, SigV4 scope only
```

Tier clients are built at startup. A target added through the admin API (`PUT /_neolith/admin/v1/tiers`) is persisted to the config and takes effect on the next start.

### A transition rule

```xml
<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Rule>
    <ID>archive-after-90d</ID>
    <Status>Enabled</Status>
    <Filter><Prefix>datasets/2025/</Prefix></Filter>
    <Transition>
      <Days>90</Days>
      <StorageClass>GLACIER</StorageClass>
    </Transition>
  </Rule>
</LifecycleConfiguration>
```

### What a transition does

1. The scanner reads the object's stored bytes and uploads them to the tier with a SigV4-signed PUT. Nothing local changes until the upload has succeeded.
2. The object's metadata record is rewritten to carry the new storage class and the tier location (tier name, remote key, timestamp, size). This record is the only pointer to the bytes from now on.
3. The local copy is dropped: the journal entry is tombstoned, inline bytes leave the record, and a separate data file is removed. The order (record first, local copy second) means there is no moment at which the key answers 404.

### Reading a tiered object

An archived object needs no restore call. It reads with a plain request at the same key:

| Request | Behaviour |
|---|---|
| `GET` | The bytes are fetched from the tier and served; `x-amz-storage-class` carries the tier's class. Compressed or encrypted objects are decompressed and decrypted as usual. |
| `HEAD` | Answered from the local record; the tier is not contacted. |
| `GET` with `Range` | For an uncompressed, unencrypted object only the requested byte range is fetched from the tier. Otherwise the whole object is fetched and the range is cut locally. |
| Batch GET (`?batch`) | Reads through the same record. |
| Conditional headers (`If-None-Match`, `If-Match`, ...) | Evaluated against the local record before the tier is contacted. |

Failure modes a client can see:

| Status | Meaning |
|---|---|
| `503 ServiceUnavailable` | The tier refused or failed the read (unreachable, 4xx or 5xx from the remote). Retry. |
| `500 InternalError` | The record names a tier this node has no client for, or the record is malformed. Fix the `[[tiers]]` configuration; a retry will not help. |

### Provider support

Only `provider = "s3"` has a transport. `gcs` and `azure` are accepted in the configuration but a transition to either is refused and logged, and the object stays where it is. An earlier build reported such uploads as successful and dropped the local copy; if you ran transitions to a GCS or Azure target on that build, treat those objects as lost and restore them from a backup.

## Common Use Cases

### Log Retention (30 days)

```bash
mc ilm import myn/logs-bucket << 'EOF'
{"Rules":[{"ID":"log-retention","Status":"Enabled","Filter":{"Prefix":""},"Expiration":{"Days":30}}]}
EOF
```

### Temp File Cleanup (24 hours)

```bash
mc ilm import myn/staging-bucket << 'EOF'
{"Rules":[{"ID":"temp-cleanup","Status":"Enabled","Filter":{"Prefix":"tmp/"},"Expiration":{"Days":1}}]}
EOF
```

### Version History Retention (keep 90 days of noncurrent versions)

```bash
mc ilm import myn/versioned-bucket << 'EOF'
{"Rules":[{"ID":"version-cleanup","Status":"Enabled","Filter":{"Prefix":""},"NoncurrentVersionExpiration":{"NoncurrentDays":90}}]}
EOF
```

## Limitations

| Feature | Status |
|---|---|
| Expiration (Days) | Supported |
| Expiration (Date) | Supported |
| NoncurrentVersionExpiration | Supported |
| Transition (storage class) | Supported: metadata-only without a tier target, moves bytes to an S3-compatible tier with one (see above) |
| AbortIncompleteMultipartUpload | Handled by multipart 24h TTL |
| ExpiredObjectDeleteMarker | Not yet supported |
