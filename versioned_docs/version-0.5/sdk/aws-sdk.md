---
sidebar_position: 3
title: "AWS SDK Integration"
---

# AWS SDK Integration

Neolith is S3-compatible, so any AWS SDK works with minimal configuration. The key requirement is overriding the endpoint URL to point to your Neolith server instead of AWS S3.

## Python (boto3)

### Configuration

```python
import boto3

s3 = boto3.client(
    "s3",
    endpoint_url="http://localhost:9000",
    aws_access_key_id="your-access-key",
    aws_secret_access_key="your-secret-key",
    region_name="us-east-1",  # Required by boto3, but ignored by Neolith
)
```

For servers running without authentication, you can pass any non-empty credentials:

```python
s3 = boto3.client(
    "s3",
    endpoint_url="http://localhost:9000",
    aws_access_key_id="test",
    aws_secret_access_key="test",
    region_name="us-east-1",
)
```

### Bucket Operations

```python
# Create a bucket
s3.create_bucket(Bucket="my-bucket")

# List buckets
response = s3.list_buckets()
for bucket in response["Buckets"]:
    print(bucket["Name"])

# Delete a bucket
s3.delete_bucket(Bucket="my-bucket")
```

### Object Operations

```python
# Upload an object
s3.put_object(
    Bucket="my-bucket",
    Key="models/checkpoint-42.pt",
    Body=open("checkpoint.pt", "rb"),
    ContentType="application/octet-stream",
)

# Upload with SSE-S3 encryption
s3.put_object(
    Bucket="my-bucket",
    Key="secret-data.bin",
    Body=b"sensitive data",
    ServerSideEncryption="AES256",
)

# Download an object
response = s3.get_object(Bucket="my-bucket", Key="models/checkpoint-42.pt")
data = response["Body"].read()

# Range GET (partial download)
response = s3.get_object(
    Bucket="my-bucket",
    Key="large-file.bin",
    Range="bytes=0-1023",
)
first_1k = response["Body"].read()

# Head (metadata only)
response = s3.head_object(Bucket="my-bucket", Key="models/checkpoint-42.pt")
print(f"Size: {response['ContentLength']}")
print(f"ETag: {response['ETag']}")

# Delete an object
s3.delete_object(Bucket="my-bucket", Key="models/checkpoint-42.pt")

# Copy an object
s3.copy_object(
    Bucket="my-bucket",
    Key="models/checkpoint-42-copy.pt",
    CopySource={"Bucket": "my-bucket", "Key": "models/checkpoint-42.pt"},
)

# List objects
paginator = s3.get_paginator("list_objects_v2")
for page in paginator.paginate(Bucket="my-bucket", Prefix="models/"):
    for obj in page.get("Contents", []):
        print(f"{obj['Key']}: {obj['Size']} bytes")
```

### Multipart Upload

```python
# Initiate multipart upload
mpu = s3.create_multipart_upload(Bucket="my-bucket", Key="large-model.bin")
upload_id = mpu["UploadId"]

# Upload parts (minimum 5 MiB per part, except the last)
parts = []
with open("large-model.bin", "rb") as f:
    part_number = 1
    while True:
        chunk = f.read(64 * 1024 * 1024)  # 64 MiB parts
        if not chunk:
            break
        response = s3.upload_part(
            Bucket="my-bucket",
            Key="large-model.bin",
            UploadId=upload_id,
            PartNumber=part_number,
            Body=chunk,
        )
        parts.append({"ETag": response["ETag"], "PartNumber": part_number})
        part_number += 1

# Complete the upload
s3.complete_multipart_upload(
    Bucket="my-bucket",
    Key="large-model.bin",
    UploadId=upload_id,
    MultipartUpload={"Parts": parts},
)
```

### Presigned URLs

```python
# Generate a presigned GET URL (valid for 1 hour)
url = s3.generate_presigned_url(
    "get_object",
    Params={"Bucket": "my-bucket", "Key": "shared-file.bin"},
    ExpiresIn=3600,
)
print(f"Share this URL: {url}")

# Generate a presigned PUT URL
upload_url = s3.generate_presigned_url(
    "put_object",
    Params={"Bucket": "my-bucket", "Key": "uploads/file.bin"},
    ExpiresIn=3600,
)
```

Neolith supports presigned URLs with a maximum expiry of 7 days (604,800 seconds).

### Versioning

```python
# Enable versioning on a bucket
s3.put_bucket_versioning(
    Bucket="my-bucket",
    VersioningConfiguration={"Status": "Enabled"},
)

# Upload creates a new version automatically
s3.put_object(Bucket="my-bucket", Key="doc.txt", Body=b"version 1")
s3.put_object(Bucket="my-bucket", Key="doc.txt", Body=b"version 2")

# List all versions
response = s3.list_object_versions(Bucket="my-bucket", Prefix="doc.txt")
for version in response.get("Versions", []):
    print(f"Version: {version['VersionId']}, Size: {version['Size']}")

# Get a specific version
response = s3.get_object(
    Bucket="my-bucket", Key="doc.txt", VersionId="<version-id>"
)
```

### Tags

```python
# Set tags on an object
s3.put_object_tagging(
    Bucket="my-bucket",
    Key="dataset.tar.gz",
    Tagging={"TagSet": [
        {"Key": "project", "Value": "nlp-v2"},
        {"Key": "stage", "Value": "training"},
    ]},
)

# Get tags
response = s3.get_object_tagging(Bucket="my-bucket", Key="dataset.tar.gz")
for tag in response["TagSet"]:
    print(f"{tag['Key']}={tag['Value']}")
```

## Rust (aws-sdk-s3)

### Cargo.toml

```toml
[dependencies]
aws-sdk-s3 = "1"
aws-config = "1"
aws-credential-types = "1"
tokio = { version = "1", features = ["full"] }
```

### Configuration

```rust
use aws_sdk_s3::config::{Credentials, Region};
use aws_sdk_s3::Client;

let creds = Credentials::new(
    "your-access-key",
    "your-secret-key",
    None, // session token
    None, // expiry
    "neolith",
);

let config = aws_sdk_s3::Config::builder()
    .endpoint_url("http://localhost:9000")
    .region(Region::new("us-east-1"))
    .credentials_provider(creds)
    .force_path_style(true) // Required for IP-based endpoints
    .build();

let client = Client::from_conf(config);
```

### Operations

```rust
// Create bucket
client.create_bucket()
    .bucket("my-bucket")
    .send()
    .await?;

// PUT object
let data = aws_sdk_s3::primitives::ByteStream::from_static(b"hello world");
client.put_object()
    .bucket("my-bucket")
    .key("greeting.txt")
    .body(data)
    .send()
    .await?;

// GET object
let resp = client.get_object()
    .bucket("my-bucket")
    .key("greeting.txt")
    .send()
    .await?;
let bytes = resp.body.collect().await?.into_bytes();
println!("Content: {}", String::from_utf8_lossy(&bytes));

// List objects
let resp = client.list_objects_v2()
    .bucket("my-bucket")
    .prefix("models/")
    .send()
    .await?;
for obj in resp.contents() {
    println!("{}: {} bytes", obj.key().unwrap_or(""), obj.size().unwrap_or(0));
}

// DELETE object
client.delete_object()
    .bucket("my-bucket")
    .key("greeting.txt")
    .send()
    .await?;
```

## AWS CLI

### Configuration

Configure a named profile for your Neolith server:

```bash
# Configure credentials
aws configure --profile neolith
# Enter your access key and secret key when prompted

# Or set environment variables
export AWS_ACCESS_KEY_ID=your-access-key
export AWS_SECRET_ACCESS_KEY=your-secret-key
```

### Usage

Always pass `--endpoint-url` to point to your Neolith server:

```bash
# Create a bucket
aws --endpoint-url http://localhost:9000 s3 mb s3://my-bucket

# Upload a file
aws --endpoint-url http://localhost:9000 s3 cp model.pt s3://my-bucket/models/

# Download a file
aws --endpoint-url http://localhost:9000 s3 cp s3://my-bucket/models/model.pt ./

# List objects
aws --endpoint-url http://localhost:9000 s3 ls s3://my-bucket/models/

# Sync a directory
aws --endpoint-url http://localhost:9000 s3 sync ./data/ s3://my-bucket/data/

# Remove a file
aws --endpoint-url http://localhost:9000 s3 rm s3://my-bucket/models/old-model.pt
```

### Shell Aliases

For convenience, create a shell alias:

```bash
# In ~/.bashrc or ~/.zshrc
alias ns3='aws --endpoint-url http://localhost:9000 s3'
alias ns3api='aws --endpoint-url http://localhost:9000 s3api'

# Usage
ns3 ls s3://my-bucket/
ns3api put-object --bucket my-bucket --key test.txt --body test.txt
```

### AWS CLI v2 Endpoint Configuration

AWS CLI v2 supports endpoint URLs in the config file:

```ini
# ~/.aws/config
[profile neolith]
endpoint_url = http://localhost:9000
region = us-east-1
s3 =
    signature_version = s3v4
```

Then use the profile:

```bash
aws --profile neolith s3 ls s3://my-bucket/
```

## Node.js (@aws-sdk/client-s3)

### Installation

```bash
npm install @aws-sdk/client-s3
```

### Configuration

```javascript
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

const client = new S3Client({
  endpoint: "http://localhost:9000",
  region: "us-east-1",
  credentials: {
    accessKeyId: "your-access-key",
    secretAccessKey: "your-secret-key",
  },
  forcePathStyle: true, // Required for non-AWS endpoints
});
```

### Operations

```javascript
// PUT object
await client.send(new PutObjectCommand({
  Bucket: "my-bucket",
  Key: "data/file.json",
  Body: JSON.stringify({ key: "value" }),
  ContentType: "application/json",
}));

// GET object
const response = await client.send(new GetObjectCommand({
  Bucket: "my-bucket",
  Key: "data/file.json",
}));
const body = await response.Body.transformToString();
console.log(JSON.parse(body));

// List objects
const list = await client.send(new ListObjectsV2Command({
  Bucket: "my-bucket",
  Prefix: "data/",
  MaxKeys: 100,
}));
for (const obj of list.Contents ?? []) {
  console.log(`${obj.Key}: ${obj.Size} bytes`);
}
```

## ETag Compatibility

Neolith uses BLAKE3 (truncated to 128 bits) for ETag generation, not MD5. The ETag format is S3-compatible (32 hex characters for single-part uploads, `hash-N` for multipart). This means:

- `If-Match` / `If-None-Match` conditional headers work correctly
- ETags are consistent and deterministic for the same content
- Content-MD5 validation is supported separately via the `Content-MD5` request header
