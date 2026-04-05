---
sidebar_position: 3
title: "Model Checkpoints"
---

# Model Checkpoints

Model checkpoints are a critical component of ML training workflows. They capture the state of a model at a point in time, enabling training resumption after failures, hyperparameter comparison across experiments, and model serving from specific training snapshots.

Neolith provides several features that make it well-suited for checkpoint storage: multipart upload for large models, object versioning for checkpoint history, lifecycle rules for automated cleanup, and presigned URLs for distributed training nodes.

## Storing Checkpoints

### Small Models (< 5 GB)

For models that fit in a single PUT request, use standard S3 PUT with appropriate metadata:

```python
import boto3
import torch

s3 = boto3.client("s3", endpoint_url="http://neolith:9000",
                   aws_access_key_id="key", aws_secret_access_key="secret")

# Save checkpoint to buffer
model_state = {
    "epoch": 42,
    "model_state_dict": model.state_dict(),
    "optimizer_state_dict": optimizer.state_dict(),
    "loss": 0.0312,
    "accuracy": 0.956,
}

import io
buffer = io.BytesIO()
torch.save(model_state, buffer)
buffer.seek(0)

# Upload with metadata
s3.put_object(
    Bucket="checkpoints",
    Key=f"experiment-123/epoch-{model_state['epoch']}.pt",
    Body=buffer,
    ContentType="application/octet-stream",
    Metadata={
        "epoch": str(model_state["epoch"]),
        "loss": str(model_state["loss"]),
        "accuracy": str(model_state["accuracy"]),
        "framework": "pytorch-2.2",
    },
)
```

Neolith handles compression automatically (LZ4 with smart skip). Model checkpoint files are typically incompressible (high entropy from trained weights), so Neolith's smart skip feature detects this via entropy measurement and stores them without wasting CPU on fruitless compression.

### Large Models (> 5 GB)

For LLMs and large vision models, use multipart upload. Neolith supports up to 10,000 parts with a minimum part size of 5 MiB:

```python
import boto3
from boto3.s3.transfer import TransferConfig

s3 = boto3.client("s3", endpoint_url="http://neolith:9000",
                   aws_access_key_id="key", aws_secret_access_key="secret")

# Configure multipart: 64 MiB parts, 10 concurrent uploads
config = TransferConfig(
    multipart_threshold=64 * 1024 * 1024,
    multipart_chunksize=64 * 1024 * 1024,
    max_concurrency=10,
)

# Upload large checkpoint
s3.upload_file(
    "checkpoint-70b.pt",
    "checkpoints",
    "llama-70b/epoch-5.pt",
    Config=config,
    ExtraArgs={
        "Metadata": {
            "model": "llama-70b",
            "epoch": "5",
            "params": "70000000000",
        },
    },
)
```

The multipart upload pipeline in Neolith:
1. `POST CreateMultipartUpload` returns a UUID v4 upload ID
2. Parts are uploaded concurrently (`PUT UploadPart`)
3. `POST CompleteMultipartUpload` triggers the full storage pipeline: compress, encrypt (if SSE enabled), erasure code, and write shards
4. Multipart ETag: `BLAKE3(concat(part_etags))-N` where N is the number of parts
5. Incomplete uploads expire after 24 hours and are cleaned up automatically

### Encrypted Checkpoints

For sensitive model weights (proprietary architectures, fine-tuned on private data):

```python
# SSE-S3 encryption (server-managed key)
s3.put_object(
    Bucket="checkpoints",
    Key="proprietary-model/weights.pt",
    Body=buffer,
    ServerSideEncryption="AES256",
)

# The server encrypts using AES-256-GCM with a per-object DEK
# derived from the master key via HKDF.
# 64KB AEAD blocks enable streaming encryption/decryption.
```

## Checkpoint Versioning

Enable bucket versioning to maintain a history of every checkpoint write without manual naming schemes:

```python
# Enable versioning
s3.put_bucket_versioning(
    Bucket="checkpoints",
    VersioningConfiguration={"Status": "Enabled"},
)

# Every PUT to the same key creates a new version
s3.put_object(Bucket="checkpoints", Key="model/latest.pt", Body=v1_data)
s3.put_object(Bucket="checkpoints", Key="model/latest.pt", Body=v2_data)
s3.put_object(Bucket="checkpoints", Key="model/latest.pt", Body=v3_data)

# List all versions
response = s3.list_object_versions(
    Bucket="checkpoints",
    Prefix="model/latest.pt",
)

for version in response.get("Versions", []):
    print(f"Version: {version['VersionId']}, "
          f"Modified: {version['LastModified']}, "
          f"Size: {version['Size']}")

# Retrieve a specific version
response = s3.get_object(
    Bucket="checkpoints",
    Key="model/latest.pt",
    VersionId="<specific-version-id>",
)
checkpoint_data = response["Body"].read()
```

### Version Storage

Versioned objects in Neolith are stored in a `v/` subdirectory under the object's metadata path:
- `meta.neo` always points to the latest version
- `v/<version-id>.neo` and `v/<version-id>.dat` store each historical version
- Delete markers have `is_delete_marker=true` in their metadata

## Lifecycle Rules for Cleanup

Training pipelines can generate hundreds of checkpoints. Lifecycle rules automate cleanup of old versions:

```python
# Keep only the last 5 versions of each checkpoint
s3.put_bucket_lifecycle_configuration(
    Bucket="checkpoints",
    LifecycleConfiguration={
        "Rules": [
            {
                "ID": "cleanup-old-checkpoints",
                "Prefix": "",
                "Status": "Enabled",
                "NoncurrentVersionExpiration": {
                    "NoncurrentDays": 7,
                },
            },
            {
                "ID": "expire-failed-experiments",
                "Prefix": "scratch/",
                "Status": "Enabled",
                "Expiration": {
                    "Days": 3,
                },
            },
        ],
    },
)
```

Lifecycle rules are stored as `.lifecycle.json` sidecar files and evaluated by a background scanner every hour. Rules support:

- **Prefix filtering**: Apply rules to specific key prefixes
- **Tag filtering**: Apply rules based on object tags
- **Expiration**: Delete objects after N days
- **Noncurrent version expiration**: Delete old versions after N days

For versioned buckets, expiration creates a delete marker (the object is still recoverable via version ID). For non-versioned buckets, expiration performs a hard delete.

## Presigned URLs for Distributed Training

In distributed training, multiple GPU nodes need to read and write checkpoints. Rather than distributing access keys to every node, use presigned URLs:

```python
# Coordinator generates presigned URLs
def get_checkpoint_upload_url(experiment_id, rank, epoch):
    """Generate a presigned PUT URL for a training node."""
    key = f"{experiment_id}/rank-{rank}/epoch-{epoch}.pt"
    url = s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": "checkpoints",
            "Key": key,
            "ContentType": "application/octet-stream",
        },
        ExpiresIn=3600,  # 1 hour
    )
    return url

def get_checkpoint_download_url(experiment_id, rank, epoch):
    """Generate a presigned GET URL for a training node."""
    key = f"{experiment_id}/rank-{rank}/epoch-{epoch}.pt"
    url = s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": "checkpoints", "Key": key},
        ExpiresIn=3600,
    )
    return url

# Training node uses the URL without needing credentials
import requests
url = get_checkpoint_upload_url("exp-42", rank=0, epoch=10)
with open("checkpoint.pt", "rb") as f:
    requests.put(url, data=f, headers={"Content-Type": "application/octet-stream"})
```

Presigned URLs in Neolith use query-string SigV4 with the following parameters:
- `X-Amz-Algorithm`: `AWS4-HMAC-SHA256`
- `X-Amz-Credential`: Access key + scope
- `X-Amz-Date`: Signing timestamp
- `X-Amz-Expires`: Validity duration (max 7 days / 604,800 seconds)
- `X-Amz-SignedHeaders`: Headers included in the signature
- `X-Amz-Signature`: The computed signature

## Checkpoint Organization Strategies

### By Experiment

```
checkpoints/
  experiment-123/
    epoch-1.pt
    epoch-2.pt
    ...
    epoch-100.pt
  experiment-124/
    epoch-1.pt
    ...
```

### By Model + Version

```
checkpoints/
  llama-70b/
    v1/latest.pt       # Versioned: one key, many versions
    v1/config.json
  resnet-50/
    v3/latest.pt
    v3/config.json
```

### By Training Stage

```
checkpoints/
  pretrain/model.pt
  finetune/task-a/model.pt
  finetune/task-b/model.pt
  distill/student-model.pt
```

Use tags to add structured metadata for querying:

```python
s3.put_object_tagging(
    Bucket="checkpoints",
    Key="experiment-123/epoch-42.pt",
    Tagging={"TagSet": [
        {"Key": "experiment", "Value": "123"},
        {"Key": "metric:loss", "Value": "0.0312"},
        {"Key": "metric:accuracy", "Value": "0.956"},
        {"Key": "status", "Value": "best"},
    ]},
)
```

## Checkpoint Integrity

Neolith provides multiple layers of data integrity for stored checkpoints:

1. **BLAKE3 checksums**: Every object gets a BLAKE3 content hash stored in metadata and returned as the ETag
2. **Erasure coding**: Objects are split into data + parity shards, surviving drive failures without data loss
3. **Background scanning**: The heal scanner verifies checksums on a 30-day cycle
4. **On-read verification**: Every GET verifies the BLAKE3 checksum before returning data
5. **Content-MD5**: Upload-time MD5 validation when the `Content-MD5` header is present
