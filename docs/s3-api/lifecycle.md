---
sidebar_position: 7
title: "Lifecycle Rules"
---

# Lifecycle Rules

Lifecycle rules automate the expiration, cleanup and tiering of objects in a bucket. Neolith supports expiration by age or by date for current versions, noncurrent version expiration, removal of expired delete markers, `Transition` rules (several per rule, by age or by date) that move an object's bytes to a remote S3-compatible tier while the object stays readable at its key, and aborting incomplete multipart uploads.

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
| `Status` | `Enabled` or `Disabled`; anything else is rejected |
| `Filter.Prefix` | Apply rule only to keys matching this prefix |
| `Filter.Tag` | Apply rule only to objects carrying this tag (`Key` and `Value`) |
| `Filter.And` | Combine a `Prefix` with one or more `Tag` elements; every predicate must match |
| `Expiration.Days` | Delete the current version once it is N days old (N is a positive integer) |
| `Expiration.Date` | Delete the current version once this ISO 8601 instant has passed (`2026-03-01T00:00:00Z`; a bare `2026-03-01` is midnight UTC) |
| `Expiration.ExpiredObjectDeleteMarker` | Remove a delete marker that has no noncurrent versions behind it; exclusive with `Days` and `Date`, and not allowed with a `Tag` filter |
| `NoncurrentVersionExpiration.NoncurrentDays` | Delete noncurrent versions after N days |
| `Transition.Days` or `Transition.Date` | When the transition fires (exactly one of the two) |
| `Transition.StorageClass` | The target class; must be a class the deployment knows (see Storage class names below). A rule may hold several `Transition` elements, one per class |
| `AbortIncompleteMultipartUpload.DaysAfterInitiation` | Abort in-flight multipart uploads under the rule's prefix once they are N days old; not allowed with a `Tag` filter |

`NoncurrentVersionTransition` is refused with `501 NotImplemented`: noncurrent versions are not moved between storage classes, and a rule naming it is rejected rather than accepted and ignored.

### Filter with Tags

Rules can filter by both prefix and tags. In XML:

```xml
<Filter>
  <And>
    <Prefix>data/</Prefix>
    <Tag><Key>status</Key><Value>processed</Value></Tag>
  </And>
</Filter>
```

A single predicate needs no `And`: `<Filter><Prefix>data/</Prefix></Filter>` or `<Filter><Tag>...</Tag></Filter>`. The same rule as `mc` JSON:

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
2. For each bucket, abort every in-flight multipart upload that an `AbortIncompleteMultipartUpload` rule covers (prefix match, initiated at least `DaysAfterInitiation` days ago); journal-staged parts are freed first, as `AbortMultipartUpload` does
3. For each object, evaluate each rule's filter (prefix, tags)
4. For a matching object whose current state is a delete marker, apply `ExpiredObjectDeleteMarker`: the marker is removed when every version of the key is a marker, and left alone when a live noncurrent version stands behind it
5. For a matching live object, expire it when `Days` or `Date` has passed (hard delete for unversioned, delete marker for versioned), expire noncurrent versions past `NoncurrentDays`, and apply the transition whose trigger fired latest among those that have fired (an object past several thresholds goes straight to the deepest class)

The scanner logs its actions and skips disabled rules. The multipart upload TTL (`[multipart] upload_ttl_secs`, 24 hours by default) still applies to every bucket as a floor; a lifecycle rule lets a bucket abort earlier or later than that.

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
      <Days>30</Days>
      <StorageClass>STANDARD_IA</StorageClass>
    </Transition>
    <Transition>
      <Days>90</Days>
      <StorageClass>GLACIER</StorageClass>
    </Transition>
    <Transition>
      <Date>2027-01-01T00:00:00Z</Date>
      <StorageClass>DEEP_ARCHIVE</StorageClass>
    </Transition>
  </Rule>
</LifecycleConfiguration>
```

A rule may hold several transitions, each by age (`Days`) or by date (`Date`), one per storage class. On each scan the object moves to the class whose trigger fired latest among those that have fired: an object already 100 days old goes straight to `GLACIER`, not through `STANDARD_IA` first.

### Storage class names

A storage class is accepted, on `PutObject`, `CopyObject`, `CreateMultipartUpload` and in a `Transition`, when it is one of:

- an S3 canonical name: `STANDARD`, `REDUCED_REDUNDANCY`, `STANDARD_IA`, `ONEZONE_IA`, `INTELLIGENT_TIERING`, `GLACIER`, `GLACIER_IR`, `DEEP_ARCHIVE`, `EXPRESS_ONEZONE`, `OUTPOSTS`, `SNOW`
- the `name` of a configured `[[tiers]]` target (a transition to it moves the bytes)
- a class with a storage-class erasure-coding override (a write to it uses that scheme)

Anything else is refused with `400 InvalidStorageClass`, so a typo cannot become a permanent label that no rule targets and no listing explains. A tier name is 1 to 64 ASCII letters, digits, `_`, `-` or `.`; the server refuses to start on any other name, because the name is what clients see as the class.

The class an object carries is visible everywhere: `x-amz-storage-class` on `HEAD` and `GET` (omitted for `STANDARD`), `<StorageClass>` in `ListObjects`, `ListObjectsV2` and `ListObjectVersions`, and `<StorageClass>` in `ListMultipartUploads` for an upload in flight. A multipart upload initiated with `x-amz-storage-class` completes as an object of that class; under the journal storage scheme its part stripes use the journal's own erasure scheme, so a storage-class erasure-coding override applies to single `PUT`s and to multipart objects on the file-staging path, not to journal-staged multipart parts.

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

Only `provider = "s3"` has a transport. A `[[tiers]]` entry with `provider = "gcs"` or `"azure"`, an unknown provider string, an empty endpoint or bucket, or a name declared twice is refused at startup: the server does not boot until the configuration is fixed. An earlier build accepted GCS and Azure targets, reported their uploads as successful and dropped the local copy; if you ran transitions to such a target on that build, treat those objects as lost and restore them from a backup.

### Moving between tiers, deleting, and local copies

- **Two rules, two tiers.** A later `Transition` to a class that has its own tier target moves the bytes from the current tier to the new one (read from the current tier, upload, repoint the record, delete the previous tier's copy). A later `Transition` to a class with no tier target only relabels the storage class and keeps the tier pointer.
- **Delete releases the remote copy.** `DELETE` of a tiered object (single or batch) and lifecycle expiration remove the remote copy along with the record. In a versioned bucket a delete creates a marker and keeps the version, so the remote copy stays with it.
- **Local bytes win.** If a record names a tier but the object's bytes are also present locally (a record written by an earlier build, which never removed the data file), reads serve the local copy and never contact the tier.
- **Concurrent writes win.** A `PUT` that lands on the key while its bytes are being uploaded is kept: the transition notices, discards its upload and leaves the record alone; the object is evaluated again on the next scan.
- **Large objects stream.** A whole-object or ranged `GET` of an uncompressed, unencrypted tiered object streams from the tier to the client without being buffered on the node; `content-length` comes from the tier's response.

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
| Filter (Prefix, Tag, And) | Supported |
| Expiration (Days) | Supported |
| Expiration (Date) | Supported |
| ExpiredObjectDeleteMarker | Supported: removes a marker with no noncurrent versions behind it |
| NoncurrentVersionExpiration | Supported |
| Transition (storage class, several per rule, Days or Date) | Supported: metadata-only without a tier target, moves bytes to an S3-compatible tier with one (see above); the class must be a known one |
| NoncurrentVersionTransition | Refused with `501 NotImplemented` |
| AbortIncompleteMultipartUpload | Supported: acted on by the scanner; the multipart TTL remains a floor for every bucket |
