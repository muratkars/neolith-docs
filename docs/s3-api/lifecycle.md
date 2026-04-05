---
sidebar_position: 7
title: "Lifecycle Rules"
---

# Lifecycle Rules

Lifecycle rules automate the expiration and cleanup of objects in a bucket. Neolith supports expiration-based lifecycle policies for both current and noncurrent object versions.

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

**AWS CLI:**

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
aws --endpoint-url http://localhost:9000 s3api put-bucket-lifecycle-configuration \
  --bucket my-bucket \
  --lifecycle-configuration file://lifecycle.json
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

**AWS CLI:**

```bash
aws --endpoint-url http://localhost:9000 s3api get-bucket-lifecycle-configuration \
  --bucket my-bucket
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

**AWS CLI:**

```bash
aws --endpoint-url http://localhost:9000 s3api delete-bucket-lifecycle \
  --bucket my-bucket
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

## Common Use Cases

### Log Retention (30 days)

```bash
aws --endpoint-url http://localhost:9000 s3api put-bucket-lifecycle-configuration \
  --bucket logs-bucket \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "log-retention",
      "Status": "Enabled",
      "Filter": {"Prefix": ""},
      "Expiration": {"Days": 30}
    }]
  }'
```

### Temp File Cleanup (24 hours)

```bash
aws --endpoint-url http://localhost:9000 s3api put-bucket-lifecycle-configuration \
  --bucket staging-bucket \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "temp-cleanup",
      "Status": "Enabled",
      "Filter": {"Prefix": "tmp/"},
      "Expiration": {"Days": 1}
    }]
  }'
```

### Version History Retention (keep 90 days of noncurrent versions)

```bash
aws --endpoint-url http://localhost:9000 s3api put-bucket-lifecycle-configuration \
  --bucket versioned-bucket \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "version-cleanup",
      "Status": "Enabled",
      "Filter": {"Prefix": ""},
      "NoncurrentVersionExpiration": {"NoncurrentDays": 90}
    }]
  }'
```

## Limitations

| Feature | Status |
|---|---|
| Expiration (Days) | Supported |
| Expiration (Date) | Supported |
| NoncurrentVersionExpiration | Supported |
| Transition (storage class) | Not supported (single storage class) |
| AbortIncompleteMultipartUpload | Handled by multipart 24h TTL |
| ExpiredObjectDeleteMarker | Not yet supported |
