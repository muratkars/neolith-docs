---
sidebar_position: 6
title: "Versioning"
---

# Versioning

Bucket versioning allows you to preserve, retrieve, and restore every version of every object in a bucket. When enabled, Neolith keeps all versions of an object rather than overwriting them, and DELETE operations create delete markers instead of removing data.

## Enabling Versioning

**Request:**

```
PUT /<bucket>?versioning HTTP/1.1
Host: localhost:9000
Content-Type: application/xml

<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Status>Enabled</Status>
</VersioningConfiguration>
```

**AWS CLI:**

```bash
# Enable versioning
aws --endpoint-url http://localhost:9000 s3api put-bucket-versioning \
  --bucket my-bucket \
  --versioning-configuration Status=Enabled

# Suspend versioning (preserves existing versions, stops creating new ones)
aws --endpoint-url http://localhost:9000 s3api put-bucket-versioning \
  --bucket my-bucket \
  --versioning-configuration Status=Suspended
```

**curl:**

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  -X PUT \
  -H "Content-Type: application/xml" \
  -d '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>' \
  "http://localhost:9000/my-bucket?versioning"
```

## Getting Versioning Status

**AWS CLI:**

```bash
aws --endpoint-url http://localhost:9000 s3api get-bucket-versioning \
  --bucket my-bucket
```

**Response (200 OK):**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Status>Enabled</Status>
</VersioningConfiguration>
```

Possible status values:
- **(empty)** - Versioning has never been enabled
- **Enabled** - Versioning is active
- **Suspended** - Versioning is paused (existing versions preserved)

## How Versioning Works

### Storage Layout

When versioning is enabled, Neolith stores versions in a `v/` subdirectory under the object's metadata directory:

```
<data-root>/<bucket>/<hashed-key>/
  meta.neo          # Always points to the latest version
  data.dat          # Data for the latest version
  v/
    <version-id-1>.neo   # Metadata for version 1
    <version-id-1>.dat   # Data for version 1
    <version-id-2>.neo   # Metadata for version 2
    <version-id-2>.dat   # Data for version 2
```

Each version is identified by a unique version ID. The `meta.neo` file always reflects the current (latest) version.

### Configuration Sidecar

Versioning state is stored in a `.versioning.json` sidecar file in the bucket directory. The versioning status is cached in `AppState.versioning_cache` for fast lookup.

## Uploading to a Versioned Bucket

When you upload an object to a versioned bucket, the response includes the version ID:

```bash
aws --endpoint-url http://localhost:9000 s3api put-object \
  --bucket my-bucket \
  --key config.json \
  --body config-v1.json
```

**Response:**

```json
{
  "ETag": "\"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4\"",
  "VersionId": "abc123def456"
}
```

Upload another version:

```bash
aws --endpoint-url http://localhost:9000 s3api put-object \
  --bucket my-bucket \
  --key config.json \
  --body config-v2.json
```

```json
{
  "ETag": "\"b2c3d4e5f6a7b2c3d4e5f6a7b2c3d4e5\"",
  "VersionId": "ghi789jkl012"
}
```

## Retrieving Specific Versions

**AWS CLI:**

```bash
# Get latest version (default)
aws --endpoint-url http://localhost:9000 s3api get-object \
  --bucket my-bucket \
  --key config.json \
  latest.json

# Get a specific version
aws --endpoint-url http://localhost:9000 s3api get-object \
  --bucket my-bucket \
  --key config.json \
  --version-id "abc123def456" \
  old-version.json
```

**curl:**

```bash
# Get specific version
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  "http://localhost:9000/my-bucket/config.json?versionId=abc123def456"
```

## Listing Object Versions

**AWS CLI:**

```bash
# List all versions of all objects
aws --endpoint-url http://localhost:9000 s3api list-object-versions \
  --bucket my-bucket

# List versions with prefix filter
aws --endpoint-url http://localhost:9000 s3api list-object-versions \
  --bucket my-bucket \
  --prefix "config"
```

**Response (200 OK):**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>my-bucket</Name>
  <Prefix></Prefix>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>false</IsTruncated>
  <Version>
    <Key>config.json</Key>
    <VersionId>ghi789jkl012</VersionId>
    <IsLatest>true</IsLatest>
    <LastModified>2026-03-15T14:00:00.000Z</LastModified>
    <ETag>"b2c3d4e5f6a7b2c3d4e5f6a7b2c3d4e5"</ETag>
    <Size>2048</Size>
    <StorageClass>STANDARD</StorageClass>
  </Version>
  <Version>
    <Key>config.json</Key>
    <VersionId>abc123def456</VersionId>
    <IsLatest>false</IsLatest>
    <LastModified>2026-03-15T12:00:00.000Z</LastModified>
    <ETag>"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"</ETag>
    <Size>1024</Size>
    <StorageClass>STANDARD</StorageClass>
  </Version>
</ListVersionsResult>
```

## Delete Markers

When you delete an object in a versioned bucket, Neolith does not remove the data. Instead, it creates a **delete marker** - a zero-size version with `is_delete_marker=true`.

```bash
# Delete an object (creates a delete marker)
aws --endpoint-url http://localhost:9000 s3api delete-object \
  --bucket my-bucket \
  --key config.json
```

**Response:**

```json
{
  "DeleteMarker": true,
  "VersionId": "mno345pqr678"
}
```

After a delete marker is created:

- `GET /bucket/key` returns `404 Not Found`
- `GET /bucket/key?versionId=abc123def456` still returns the old version
- The delete marker appears in `list-object-versions` output

### Listing Shows Delete Markers

```xml
<DeleteMarker>
  <Key>config.json</Key>
  <VersionId>mno345pqr678</VersionId>
  <IsLatest>true</IsLatest>
  <LastModified>2026-03-15T16:00:00.000Z</LastModified>
</DeleteMarker>
```

## Permanently Deleting a Version

To permanently remove a specific version (including delete markers), specify the version ID:

```bash
# Permanently delete a specific version
aws --endpoint-url http://localhost:9000 s3api delete-object \
  --bucket my-bucket \
  --key config.json \
  --version-id "abc123def456"

# Remove a delete marker (restores the object)
aws --endpoint-url http://localhost:9000 s3api delete-object \
  --bucket my-bucket \
  --key config.json \
  --version-id "mno345pqr678"
```

## Versioning with Lifecycle Rules

Lifecycle rules are version-aware. See [Lifecycle Rules](./lifecycle.md) for details on:

- Expiring current versions after N days
- Expiring noncurrent versions (`NoncurrentVersionExpiration`)
- How delete markers interact with lifecycle expiration

## Internal Details

- Version data is stored and retrieved using `store_versioned_object_data`, which runs the full compress-then-encrypt-then-store pipeline per version.
- The versioning cache (`AppState.versioning_cache`) avoids re-reading the `.versioning.json` sidecar on every request.
- In a multi-node cluster, versioned PUTs and DELETEs use HLC timestamps for conflict resolution.
