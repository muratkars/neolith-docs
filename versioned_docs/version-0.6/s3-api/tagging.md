---
sidebar_position: 8
title: "Tagging"
---

# Tagging

Object tagging allows you to categorize objects using key-value pairs. Tags can be used with lifecycle rules to selectively expire objects and provide metadata for organizational purposes.

## Constraints

| Constraint | Value |
|---|---|
| Maximum tags per object | 10 |
| Maximum tag key length | 128 characters |
| Maximum tag value length | 256 characters |

## PutObjectTagging

Sets or replaces the tag set on an object. Any existing tags are overwritten.

**Request:**

```
PUT /<bucket>/<key>?tagging HTTP/1.1
Host: localhost:9000
Content-Type: application/xml

<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <TagSet>
    <Tag>
      <Key>environment</Key>
      <Value>production</Value>
    </Tag>
    <Tag>
      <Key>department</Key>
      <Value>engineering</Value>
    </Tag>
    <Tag>
      <Key>classification</Key>
      <Value>internal</Value>
    </Tag>
  </TagSet>
</Tagging>
```

**AWS CLI:**

```bash
aws --endpoint-url http://localhost:9000 s3api put-object-tagging \
  --bucket my-bucket \
  --key reports/q1-2026.pdf \
  --tagging '{
    "TagSet": [
      {"Key": "environment", "Value": "production"},
      {"Key": "department", "Value": "engineering"},
      {"Key": "classification", "Value": "internal"}
    ]
  }'
```

**curl:**

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  -X PUT \
  -H "Content-Type: application/xml" \
  -d '<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet><Tag><Key>env</Key><Value>prod</Value></Tag></TagSet></Tagging>' \
  "http://localhost:9000/my-bucket/reports/q1-2026.pdf?tagging"
```

**Response:** `200 OK` with empty body.

### Validation Errors

| Condition | Error Code | Status |
|---|---|---|
| More than 10 tags | `InvalidTag` | 400 |
| Key longer than 128 chars | `InvalidTag` | 400 |
| Value longer than 256 chars | `InvalidTag` | 400 |
| Duplicate tag keys | `InvalidTag` | 400 |
| Invalid XML | `MalformedXML` | 400 |

## GetObjectTagging

Retrieves the tag set of an object.

**Request:**

```
GET /<bucket>/<key>?tagging HTTP/1.1
Host: localhost:9000
```

**AWS CLI:**

```bash
aws --endpoint-url http://localhost:9000 s3api get-object-tagging \
  --bucket my-bucket \
  --key reports/q1-2026.pdf
```

**curl:**

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  "http://localhost:9000/my-bucket/reports/q1-2026.pdf?tagging"
```

**Response (200 OK):**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <TagSet>
    <Tag>
      <Key>environment</Key>
      <Value>production</Value>
    </Tag>
    <Tag>
      <Key>department</Key>
      <Value>engineering</Value>
    </Tag>
    <Tag>
      <Key>classification</Key>
      <Value>internal</Value>
    </Tag>
  </TagSet>
</Tagging>
```

If no tags are set on the object, the response contains an empty `TagSet`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <TagSet/>
</Tagging>
```

## DeleteObjectTagging

Removes all tags from an object.

**Request:**

```
DELETE /<bucket>/<key>?tagging HTTP/1.1
Host: localhost:9000
```

**AWS CLI:**

```bash
aws --endpoint-url http://localhost:9000 s3api delete-object-tagging \
  --bucket my-bucket \
  --key reports/q1-2026.pdf
```

**curl:**

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  -X DELETE \
  "http://localhost:9000/my-bucket/reports/q1-2026.pdf?tagging"
```

**Response:** `204 No Content` on success.

## Storage Implementation

Tags are stored as a sidecar `tags.json` file alongside the object metadata in the `neolith-meta` directory:

```
<data-root>/<bucket>/<hashed-key>/
  meta.neo         # Object metadata (FlatBuffer)
  data.dat         # Object data (erasure-coded shards)
  tags.json        # Tag set (JSON)
```

The sidecar approach avoids modifying the core metadata format when adding or updating tags.

### tags.json Format

```json
{
  "environment": "production",
  "department": "engineering",
  "classification": "internal"
}
```

## Tags with Lifecycle Rules

Tags can be used as filters in lifecycle rules to selectively expire objects:

```bash
aws --endpoint-url http://localhost:9000 s3api put-bucket-lifecycle-configuration \
  --bucket my-bucket \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "expire-processed-data",
      "Status": "Enabled",
      "Filter": {
        "Tag": {"Key": "status", "Value": "processed"}
      },
      "Expiration": {"Days": 7}
    }]
  }'
```

This rule expires only objects tagged with `status=processed` after 7 days.

### Combined Prefix and Tag Filter

```bash
aws --endpoint-url http://localhost:9000 s3api put-bucket-lifecycle-configuration \
  --bucket my-bucket \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "expire-temp-staging",
      "Status": "Enabled",
      "Filter": {
        "And": {
          "Prefix": "staging/",
          "Tags": [
            {"Key": "temporary", "Value": "true"}
          ]
        }
      },
      "Expiration": {"Days": 1}
    }]
  }'
```

## Setting Tags During Upload

You can set tags when uploading an object using the `x-amz-tagging` header:

```bash
# Upload with tags
aws --endpoint-url http://localhost:9000 s3api put-object \
  --bucket my-bucket \
  --key data/input.csv \
  --body input.csv \
  --tagging "project=alpha&status=new"
```

The `--tagging` value uses URL query string format: `key1=value1&key2=value2`.
