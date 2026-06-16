---
sidebar_position: 5
title: "Multipart Upload"
---

# Multipart Upload

Multipart upload allows you to upload large objects in parts, improving throughput and enabling resumable uploads. Neolith supports the full multipart upload workflow: initiate, upload parts, complete, abort, and list parts.

## Constraints

| Constraint | Value |
|---|---|
| Minimum part size | 5 MiB (except the last part) |
| Maximum parts per upload | 10,000 |
| Upload TTL | 24 hours (auto-cleanup) |
| Upload ID format | UUID v4 |
| Maximum single PUT size | 128 MiB (use multipart for larger) |
| Maximum object size | ~48.8 TiB (10,000 parts x 5 GiB) |

## CreateMultipartUpload

Initiates a new multipart upload and returns an upload ID.

**Request:**

```
POST /<bucket>/<key>?uploads HTTP/1.1
Host: localhost:9000
Content-Type: application/octet-stream
x-amz-server-side-encryption: AES256   (optional)
```

**AWS CLI:**

```bash
aws --endpoint-url http://localhost:9000 s3api create-multipart-upload \
  --bucket my-bucket \
  --key large-file.bin \
  --content-type application/octet-stream
```

**curl:**

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  -X POST \
  "http://localhost:9000/my-bucket/large-file.bin?uploads"
```

**Response (200 OK):**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>my-bucket</Bucket>
  <Key>large-file.bin</Key>
  <UploadId>550e8400-e29b-41d4-a716-446655440000</UploadId>
</InitiateMultipartUploadResult>
```

## UploadPart

Uploads a part of a multipart upload. Each part (except the last) must be at least 5 MiB.

**Request:**

```
PUT /<bucket>/<key>?partNumber=<N>&uploadId=<upload-id> HTTP/1.1
Host: localhost:9000
Content-Length: <part-size>
```

**AWS CLI:**

```bash
UPLOAD_ID="550e8400-e29b-41d4-a716-446655440000"

# Upload part 1
aws --endpoint-url http://localhost:9000 s3api upload-part \
  --bucket my-bucket \
  --key large-file.bin \
  --upload-id "$UPLOAD_ID" \
  --part-number 1 \
  --body part1.bin

# Upload part 2
aws --endpoint-url http://localhost:9000 s3api upload-part \
  --bucket my-bucket \
  --key large-file.bin \
  --upload-id "$UPLOAD_ID" \
  --part-number 2 \
  --body part2.bin
```

**curl:**

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  -X PUT \
  --data-binary @part1.bin \
  "http://localhost:9000/my-bucket/large-file.bin?partNumber=1&uploadId=$UPLOAD_ID"
```

**Response (200 OK):**

```
HTTP/1.1 200 OK
ETag: "d4e5f6a7b8c9d4e5f6a7b8c9d4e5f6a7"
```

Save the ETag from each part response - you will need them for the complete step.

## CompleteMultipartUpload

Completes a multipart upload by assembling the parts. The complete handler reuses the PUT pipeline: parts are concatenated, then compressed (if configured) and encrypted (if configured) before being stored with erasure coding.

**Request:**

```
POST /<bucket>/<key>?uploadId=<upload-id> HTTP/1.1
Host: localhost:9000
Content-Type: application/xml

<CompleteMultipartUpload>
  <Part>
    <PartNumber>1</PartNumber>
    <ETag>"d4e5f6a7b8c9d4e5f6a7b8c9d4e5f6a7"</ETag>
  </Part>
  <Part>
    <PartNumber>2</PartNumber>
    <ETag>"e5f6a7b8c9d0e5f6a7b8c9d0e5f6a7b8"</ETag>
  </Part>
</CompleteMultipartUpload>
```

**AWS CLI:**

```bash
aws --endpoint-url http://localhost:9000 s3api complete-multipart-upload \
  --bucket my-bucket \
  --key large-file.bin \
  --upload-id "$UPLOAD_ID" \
  --multipart-upload '{
    "Parts": [
      {"PartNumber": 1, "ETag": "\"d4e5f6a7b8c9d4e5f6a7b8c9d4e5f6a7\""},
      {"PartNumber": 2, "ETag": "\"e5f6a7b8c9d0e5f6a7b8c9d0e5f6a7b8\""}
    ]
  }'
```

**Response (200 OK):**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Location>http://localhost:9000/my-bucket/large-file.bin</Location>
  <Bucket>my-bucket</Bucket>
  <Key>large-file.bin</Key>
  <ETag>"f6a7b8c9d0e1f6a7b8c9d0e1f6a7b8c9-2"</ETag>
</CompleteMultipartUploadResult>
```

### Multipart ETag Format

The multipart ETag is computed as `BLAKE3(concat(part_etags))-N`, where N is the number of parts. The `-N` suffix distinguishes multipart ETags from single-part ETags, matching the AWS S3 convention.

## AbortMultipartUpload

Cancels an in-progress multipart upload and frees associated storage.

**Request:**

```
DELETE /<bucket>/<key>?uploadId=<upload-id> HTTP/1.1
Host: localhost:9000
```

**AWS CLI:**

```bash
aws --endpoint-url http://localhost:9000 s3api abort-multipart-upload \
  --bucket my-bucket \
  --key large-file.bin \
  --upload-id "$UPLOAD_ID"
```

**curl:**

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  -X DELETE \
  "http://localhost:9000/my-bucket/large-file.bin?uploadId=$UPLOAD_ID"
```

**Response:** `204 No Content` on success.

## ListParts

Lists the parts that have been uploaded for a specific multipart upload.

**Request:**

```
GET /<bucket>/<key>?uploadId=<upload-id> HTTP/1.1
Host: localhost:9000
```

**AWS CLI:**

```bash
aws --endpoint-url http://localhost:9000 s3api list-parts \
  --bucket my-bucket \
  --key large-file.bin \
  --upload-id "$UPLOAD_ID"
```

**Response (200 OK):**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>my-bucket</Bucket>
  <Key>large-file.bin</Key>
  <UploadId>550e8400-e29b-41d4-a716-446655440000</UploadId>
  <PartNumberMarker>0</PartNumberMarker>
  <NextPartNumberMarker>2</NextPartNumberMarker>
  <MaxParts>1000</MaxParts>
  <IsTruncated>false</IsTruncated>
  <Part>
    <PartNumber>1</PartNumber>
    <LastModified>2026-03-15T12:00:00.000Z</LastModified>
    <ETag>"d4e5f6a7b8c9d4e5f6a7b8c9d4e5f6a7"</ETag>
    <Size>5242880</Size>
  </Part>
  <Part>
    <PartNumber>2</PartNumber>
    <LastModified>2026-03-15T12:00:05.000Z</LastModified>
    <ETag>"e5f6a7b8c9d0e5f6a7b8c9d0e5f6a7b8"</ETag>
    <Size>3145728</Size>
  </Part>
</ListPartsResult>
```

## ListMultipartUploads

Lists in-progress multipart uploads for a bucket.

**Request:**

```
GET /<bucket>?uploads HTTP/1.1
Host: localhost:9000
```

**AWS CLI:**

```bash
aws --endpoint-url http://localhost:9000 s3api list-multipart-uploads \
  --bucket my-bucket
```

**Response (200 OK):**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>my-bucket</Bucket>
  <Upload>
    <Key>large-file.bin</Key>
    <UploadId>550e8400-e29b-41d4-a716-446655440000</UploadId>
    <Initiated>2026-03-15T12:00:00.000Z</Initiated>
  </Upload>
</ListMultipartUploadsResult>
```

## Complete Multipart Upload Script

Here is a complete end-to-end example using the AWS CLI:

```bash
#!/bin/bash
set -euo pipefail

ENDPOINT="http://localhost:9000"
BUCKET="my-bucket"
KEY="large-dataset.tar.gz"
FILE="large-dataset.tar.gz"
PART_SIZE=$((5 * 1024 * 1024))  # 5 MiB

# Step 1: Initiate multipart upload
UPLOAD_ID=$(aws --endpoint-url $ENDPOINT s3api create-multipart-upload \
  --bucket $BUCKET --key $KEY \
  --query 'UploadId' --output text)

echo "Upload ID: $UPLOAD_ID"

# Step 2: Split file and upload parts
FILE_SIZE=$(stat -f%z "$FILE" 2>/dev/null || stat -c%s "$FILE")
PARTS=()
PART_NUM=1

for ((offset=0; offset<FILE_SIZE; offset+=PART_SIZE)); do
  REMAINING=$((FILE_SIZE - offset))
  COUNT=$((REMAINING < PART_SIZE ? REMAINING : PART_SIZE))

  # Extract part
  dd if="$FILE" bs=1 skip=$offset count=$COUNT of="/tmp/part-$PART_NUM" 2>/dev/null

  # Upload part
  ETAG=$(aws --endpoint-url $ENDPOINT s3api upload-part \
    --bucket $BUCKET --key $KEY \
    --upload-id "$UPLOAD_ID" \
    --part-number $PART_NUM \
    --body "/tmp/part-$PART_NUM" \
    --query 'ETag' --output text)

  PARTS+=("{\"PartNumber\":$PART_NUM,\"ETag\":\"$ETAG\"}")
  echo "Part $PART_NUM uploaded: ETag=$ETAG"
  rm "/tmp/part-$PART_NUM"
  ((PART_NUM++))
done

# Step 3: Complete multipart upload
PARTS_JSON=$(IFS=,; echo "${PARTS[*]}")
aws --endpoint-url $ENDPOINT s3api complete-multipart-upload \
  --bucket $BUCKET --key $KEY \
  --upload-id "$UPLOAD_ID" \
  --multipart-upload "{\"Parts\":[$PARTS_JSON]}"

echo "Upload complete!"
```

## TTL and Cleanup

Multipart uploads that are not completed or aborted within **24 hours** are automatically cleaned up by Neolith's background task. The in-memory `MultipartState` (a `HashMap<upload_id, MultipartUpload>`) tracks all active uploads.

## Query Parameter Dispatch

The multipart API is dispatched via query parameters on the same bucket/key routes:

| Query Parameter | Operation |
|---|---|
| `?uploads` (POST) | CreateMultipartUpload |
| `?uploads` (GET) | ListMultipartUploads |
| `?uploadId=X&partNumber=N` (PUT) | UploadPart |
| `?uploadId=X` (POST) | CompleteMultipartUpload |
| `?uploadId=X` (DELETE) | AbortMultipartUpload |
| `?uploadId=X` (GET) | ListParts |
