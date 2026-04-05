---
sidebar_position: 3
title: "Model Serving & Checkpoints"
---

# Model Serving and Checkpoints

Training a model is only half the problem. Once you have a trained model, you need to store checkpoints reliably, distribute weights to inference servers, test new versions safely, and clean up old artifacts automatically. Neolith provides the storage primitives for the full model lifecycle: versioning for checkpoint history, bucket forks for A/B testing, ETL transforms for format conversion, presigned URLs for secure distribution, and lifecycle rules for automated cleanup.

## Model Checkpoint Storage

During training, models produce checkpoints at regular intervals - often every epoch or every N steps. A single checkpoint for a large model can be tens of gigabytes. Over the course of training, checkpoint storage adds up quickly.

### Versioned Checkpoints

Enable versioning on your checkpoint bucket to retain every version of every checkpoint file:

```bash
# Enable versioning
aws --endpoint-url http://neolith:9000 s3api put-bucket-versioning \
  --bucket model-checkpoints \
  --versioning-configuration Status=Enabled

# Upload checkpoints (each overwrites the same key, but all versions are retained)
aws --endpoint-url http://neolith:9000 s3 cp checkpoint_epoch_10.pt \
  s3://model-checkpoints/resnet50/latest.pt

aws --endpoint-url http://neolith:9000 s3 cp checkpoint_epoch_20.pt \
  s3://model-checkpoints/resnet50/latest.pt
```

With versioning enabled, every PUT creates a new version. You can list and retrieve any previous version:

```bash
# List all versions of a checkpoint
aws --endpoint-url http://neolith:9000 s3api list-object-versions \
  --bucket model-checkpoints \
  --prefix resnet50/latest.pt

# Retrieve a specific version
aws --endpoint-url http://neolith:9000 s3api get-object \
  --bucket model-checkpoints \
  --key resnet50/latest.pt \
  --version-id "abc123" \
  checkpoint_restored.pt
```

### Checkpoint Organization

A recommended key structure for checkpoint storage:

```
model-checkpoints/
  resnet50/
    latest.pt              # Always points to the best checkpoint
    epoch-010.pt           # Explicit epoch checkpoints
    epoch-020.pt
    epoch-030.pt
    config.json            # Training configuration
    metrics.json           # Training metrics history
  bert-base/
    latest.pt
    step-50000.pt
    step-100000.pt
    tokenizer.json
```

## Fork-Based A/B Testing

Bucket forks create lightweight copy-on-write branches, making them ideal for A/B testing model deployments. Instead of copying gigabytes of model weights, a fork shares the underlying data and only stores deltas.

### Workflow

```bash
# Production model bucket
aws --endpoint-url http://neolith:9000 s3 cp production_v2.pt \
  s3://serving-models/classifier/model.pt

# Fork for A/B test - instant, no data copy
curl -X POST http://neolith:9000/serving-models?fork \
  -d '{"name": "serving-models-candidate"}'

# Upload candidate model to the fork only
aws --endpoint-url http://neolith:9000 s3 cp candidate_v3.pt \
  s3://serving-models-candidate/classifier/model.pt

# Inference server A reads from: s3://serving-models/classifier/model.pt
# Inference server B reads from: s3://serving-models-candidate/classifier/model.pt

# If candidate wins, promote it
aws --endpoint-url http://neolith:9000 s3 cp \
  s3://serving-models-candidate/classifier/model.pt \
  s3://serving-models/classifier/model.pt

# Clean up the fork
aws --endpoint-url http://neolith:9000 s3 rb s3://serving-models-candidate --force
```

This pattern extends naturally to canary deployments, shadow testing, and multi-armed bandit model selection.

## ETL Transforms for Model Format Conversion

Neolith's server-side ETL engine can convert model formats on the fly, without downloading the model, converting locally, and re-uploading:

```bash
# Register a transform that converts ONNX to TensorRT
curl -X PUT http://neolith:9000/etl/v1/transforms/onnx-to-trt \
  -H "Content-Type: application/json" \
  -d '{
    "runtime": "container",
    "image": "neolith/onnx-trt-converter:latest",
    "config": {"precision": "fp16", "workspace_mb": 4096}
  }'

# Fetch the model with format conversion applied
curl "http://neolith:9000/serving-models/classifier/model.onnx?transform=onnx-to-trt" \
  -o model.trt
```

Transform results are cached using BLAKE3-keyed LRU disk cache. The second request for the same model with the same transform parameters returns the cached result instantly.

### Common Model Transforms

| Transform | Input | Output | Use Case |
|---|---|---|---|
| `onnx-to-trt` | ONNX | TensorRT | GPU inference optimization |
| `quantize-int8` | FP32 weights | INT8 weights | Edge deployment |
| `prune-sparse` | Dense model | Sparse model | Reduced memory footprint |
| `to-json-meta` | Any | JSON metadata | Model registry indexing |

Native transforms (like `to-json-meta`) run in-process. WASM transforms run in a sandboxed Wasmtime runtime. Container transforms run as ephemeral Docker containers for full framework access.

## Presigned URLs for Model Distribution

Distribute model weights to inference servers, edge devices, or external partners without exposing your storage credentials:

```bash
aws --endpoint-url http://neolith:9000 s3 presign \
  s3://serving-models/classifier/model.pt --expires-in 3600
```

Presigned URLs support GET (download) and PUT (upload), with up to 7-day expiry. Authentication is embedded in query-string SigV4 parameters - no headers required, so the URL works in any HTTP client. Revoking the signing credentials invalidates all outstanding URLs. For sensitive models, combine with SSE-C encryption so the URL alone is not sufficient to read the data.

## Lifecycle Rules for Checkpoint Expiration

Training produces many checkpoints, but only a few are worth keeping long-term. Lifecycle rules automate cleanup:

```bash
# Set lifecycle rules on the checkpoint bucket
aws --endpoint-url http://neolith:9000 s3api put-bucket-lifecycle-configuration \
  --bucket model-checkpoints \
  --lifecycle-configuration '{
    "Rules": [
      {
        "ID": "expire-old-checkpoints",
        "Status": "Enabled",
        "Filter": {"Prefix": ""},
        "Expiration": {"Days": 30}
      },
      {
        "ID": "expire-noncurrent-versions",
        "Status": "Enabled",
        "Filter": {"Prefix": ""},
        "NoncurrentVersionExpiration": {"NoncurrentDays": 7}
      }
    ]
  }'
```

This configuration:

1. Deletes the current version of any object older than 30 days
2. Deletes non-current versions (previous checkpoints) after 7 days

For versioned buckets, deleting the current version creates a delete marker. The `NoncurrentVersionExpiration` rule handles cleaning up the actual data.

### Recommended Lifecycle Policies

| Bucket | Current Expiration | Noncurrent Expiration | Rationale |
|---|---|---|---|
| Training checkpoints | 30 days | 7 days | Keep recent, prune aggressively |
| Production models | None | 90 days | Long retention for rollback |
| Experiment forks | 7 days | 1 day | Short-lived by design |
| Fine-tuning data | 90 days | 30 days | May need to reproduce results |

Neolith's background lifecycle scanner runs on a configurable interval (default: 1 hour) and handles both standard expiration and version-aware cleanup.

## End-to-End Workflow

A typical model serving pipeline combines these features:

1. Training saves checkpoints to a versioned bucket
2. The best checkpoint is promoted to the serving bucket
3. A fork is created for A/B testing a candidate model
4. Inference servers download models via presigned URLs
5. Lifecycle rules expire old checkpoints automatically
6. ETL transforms convert formats on demand
