---
sidebar_position: 3
title: "Bucket Operations"
---

# Bucket Operations

Neolith supports the core S3 bucket operations: create, delete, head, list buckets, and list objects (v1 and v2).

## CreateBucket

Creates a new bucket.

**Request:**

```
PUT /<bucket-name> HTTP/1.1
Host: localhost:9000
```

**AWS CLI:**

```bash
aws --endpoint-url http://localhost:9000 s3api create-bucket \
  --bucket my-bucket
```

**curl (with awscurl):**

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  -X PUT http://localhost:9000/my-bucket
```

**Response (200 OK):**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CreateBucketResult>
  <Location>/my-bucket</Location>
</CreateBucketResult>
```

**Error Responses:**

| Code | Status | Description |
|---|---|---|
| `BucketAlreadyExists` | 409 | Bucket name is already taken |
| `InvalidBucketName` | 400 | Bucket name violates naming rules |

### Bucket Naming Rules

- 3 to 63 characters long
- Lowercase letters, numbers, and hyphens only
- Must start and end with a letter or number
- No consecutive hyphens
- Not formatted as an IP address

## DeleteBucket

Deletes an empty bucket. Returns `409 BucketNotEmpty` if objects remain.

**Request:**

```
DELETE /<bucket-name> HTTP/1.1
Host: localhost:9000
```

**AWS CLI:**

```bash
aws --endpoint-url http://localhost:9000 s3api delete-bucket \
  --bucket my-bucket
```

**curl:**

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  -X DELETE http://localhost:9000/my-bucket
```

**Response:** `204 No Content` on success.

## HeadBucket

Checks whether a bucket exists and you have permission to access it. Returns no body.

**Request:**

```
HEAD /<bucket-name> HTTP/1.1
Host: localhost:9000
```

**AWS CLI:**

```bash
aws --endpoint-url http://localhost:9000 s3api head-bucket \
  --bucket my-bucket
```

**curl:**

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  -I http://localhost:9000/my-bucket
```

**Response:** `200 OK` if the bucket exists, `404 Not Found` otherwise.

## ListBuckets

Returns a list of all buckets owned by the authenticated user.

**Request:**

```
GET / HTTP/1.1
Host: localhost:9000
```

**AWS CLI:**

```bash
aws --endpoint-url http://localhost:9000 s3api list-buckets
```

**curl:**

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  http://localhost:9000/
```

**Response (200 OK):**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Owner>
    <ID>neolith</ID>
    <DisplayName>neolith</DisplayName>
  </Owner>
  <Buckets>
    <Bucket>
      <Name>my-bucket</Name>
      <CreationDate>2026-03-15T10:30:00.000Z</CreationDate>
    </Bucket>
    <Bucket>
      <Name>data-lake</Name>
      <CreationDate>2026-03-14T08:15:00.000Z</CreationDate>
    </Bucket>
  </Buckets>
</ListAllMyBucketsResult>
```

The `ListBuckets` implementation scans the root data directory, skipping hidden directories (e.g., `.neolith`).

## ListObjects v1

Lists objects in a bucket using the original S3 list API.

**Request:**

```
GET /<bucket-name> HTTP/1.1
Host: localhost:9000
```

**Query Parameters:**

| Parameter | Description | Default |
|---|---|---|
| `prefix` | Filter results to keys beginning with this prefix | (none) |
| `delimiter` | Group keys using this delimiter (typically `/`) | (none) |
| `marker` | Start listing after this key (pagination) | (none) |
| `max-keys` | Maximum number of keys to return | 1000 |

**AWS CLI:**

```bash
# List all objects in a bucket
aws --endpoint-url http://localhost:9000 s3api list-objects \
  --bucket my-bucket

# List with prefix filter
aws --endpoint-url http://localhost:9000 s3api list-objects \
  --bucket my-bucket \
  --prefix "photos/2026/"

# List with delimiter (folder-like view)
aws --endpoint-url http://localhost:9000 s3api list-objects \
  --bucket my-bucket \
  --delimiter "/"
```

**curl:**

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  "http://localhost:9000/my-bucket?prefix=photos/&delimiter=/&max-keys=100"
```

**Response (200 OK):**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>my-bucket</Name>
  <Prefix>photos/</Prefix>
  <Delimiter>/</Delimiter>
  <MaxKeys>100</MaxKeys>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>photos/sunset.jpg</Key>
    <LastModified>2026-03-15T12:00:00.000Z</LastModified>
    <ETag>"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"</ETag>
    <Size>2048576</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <CommonPrefixes>
    <Prefix>photos/2026/</Prefix>
  </CommonPrefixes>
</ListBucketResult>
```

For large result sets, Neolith uses streaming XML generation (`xml_list_header`, `entry_chunk`, `footer` helpers) to avoid buffering the entire response in memory.

## ListObjects v2

The recommended list API. Uses continuation tokens instead of markers.

**Request:**

```
GET /<bucket-name>?list-type=2 HTTP/1.1
Host: localhost:9000
```

**Query Parameters:**

| Parameter | Description | Default |
|---|---|---|
| `list-type` | Must be `2` | (required) |
| `prefix` | Filter results to keys beginning with this prefix | (none) |
| `delimiter` | Group keys using this delimiter | (none) |
| `continuation-token` | Token from previous truncated response | (none) |
| `start-after` | Start listing after this key (first request only) | (none) |
| `max-keys` | Maximum number of keys to return | 1000 |
| `fetch-owner` | Include owner info in results | false |

**AWS CLI:**

```bash
# List objects v2
aws --endpoint-url http://localhost:9000 s3api list-objects-v2 \
  --bucket my-bucket

# Paginated listing
aws --endpoint-url http://localhost:9000 s3api list-objects-v2 \
  --bucket my-bucket \
  --max-items 10

# With prefix and delimiter
aws --endpoint-url http://localhost:9000 s3api list-objects-v2 \
  --bucket my-bucket \
  --prefix "logs/" \
  --delimiter "/"
```

**curl:**

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  "http://localhost:9000/my-bucket?list-type=2&prefix=logs/&max-keys=50"
```

**Response (200 OK):**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>my-bucket</Name>
  <Prefix>logs/</Prefix>
  <MaxKeys>50</MaxKeys>
  <KeyCount>2</KeyCount>
  <IsTruncated>true</IsTruncated>
  <ContinuationToken></ContinuationToken>
  <NextContinuationToken>eyJrZXkiOiJsb2dzLzIwMjYtMDMtMTUubG9nIn0=</NextContinuationToken>
  <Contents>
    <Key>logs/2026-03-14.log</Key>
    <LastModified>2026-03-14T23:59:59.000Z</LastModified>
    <ETag>"b3c4d5e6f7a8b3c4d5e6f7a8b3c4d5e6"</ETag>
    <Size>1048576</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <Contents>
    <Key>logs/2026-03-15.log</Key>
    <LastModified>2026-03-15T23:59:59.000Z</LastModified>
    <ETag>"c4d5e6f7a8b9c4d5e6f7a8b9c4d5e6f7"</ETag>
    <Size>524288</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
</ListBucketResult>
```

## Key Normalization

All object keys are normalized to Unicode NFC (Canonical Decomposition, followed by Canonical Composition) upon ingestion. This ensures consistent key matching regardless of the Unicode normalization form used by the client.

Keys containing control characters (U+0000 through U+001F, except U+0009 horizontal tab) are rejected with a `400 InvalidArgument` error.

## Performance Notes

- **ListObjects** uses the zero-copy `MetaView` fast-path to read object metadata without full deserialization, providing significant performance improvements for large listings.
- For v1 format metadata files, the implementation falls back to full `ObjectMeta::from_bytes` deserialization.
- Both v1 and v2 list APIs support streaming XML output for memory-efficient handling of large result sets.
