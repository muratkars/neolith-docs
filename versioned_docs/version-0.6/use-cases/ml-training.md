---
sidebar_position: 2
title: "ML Training Pipelines"
---

# ML Training Pipelines

Neolith is built from the ground up to serve as the storage backend for machine learning training pipelines. Its Batch GET API, epoch-based dataset iteration, and native PyTorch SDK eliminate the bottlenecks that make traditional object storage a poor fit for GPU-scale data loading.

## Why Object Storage for Training Data

Modern training datasets range from millions to billions of files. Local NVMe drives run out of space, network filesystems (Lustre, GPFS) buckle under metadata pressure, and ad-hoc NFS shares become single points of failure. Object storage solves these problems:

- **Scale**: Flat namespaces handle billions of objects without metadata bottlenecks
- **Cost**: Erasure coding provides durability at 1.3-1.5x overhead (vs. 2-3x for replication)
- **S3 ecosystem**: Every ML framework, data pipeline tool, and cloud SDK speaks S3
- **Centralization**: One cluster serves every GPU node - no data copying between machines
- **Versioning**: Track dataset versions natively, roll back to any previous state

The historical objection - that per-object HTTP overhead makes S3 too slow for training - is exactly what Neolith's batch APIs eliminate.

## Batch GET API

The standard S3 `GET` API returns one object per HTTP request. For a dataset with 1.2 million images, that means 1.2 million round-trips per epoch. At 1ms per request, just the HTTP overhead takes 20 minutes.

Neolith's Batch GET API retrieves thousands of objects in a single request. The server assembles objects into a TAR archive, compresses with LZ4 (or zstd), and streams the result:

```bash
# One-shot batch retrieval
curl -X POST http://neolith:9000/imagenet?batch-get \
  -H "Content-Type: application/json" \
  -d '{
    "keys": ["train/n01440764/ILSVRC2012_val_00000293.JPEG", ...],
    "format": "tar+lz4"
  }' \
  -o batch.tar.lz4
```

This amortizes HTTP overhead across the entire batch. Per-object cost drops from ~1ms to ~1us - a 1000x improvement.

### Format Options

| Format | Compression | Use Case |
|---|---|---|
| `tar` | None | Low-CPU environments, pre-compressed data (JPEG, PNG) |
| `tar+lz4` | LZ4 | Default - fast decompression, good for mixed data |
| `tar+zstd` | zstd | Higher compression ratio, slightly more CPU |

## Epoch-Based Dataset Iteration

For training loops that iterate over the full dataset multiple times, Neolith provides epoch registration with server-side shuffling and prefetch:

```bash
# Register a new epoch (server shuffles the dataset)
curl -X POST http://neolith:9000/imagenet?batch-epoch \
  -H "Content-Type: application/json" \
  -d '{"batch_size": 256, "seed": 42, "format": "tar+lz4"}'
# Response: {"epoch_id": "a1b2c3d4", "total_batches": 4688}

# Fetch batches sequentially (server prefetches ahead)
curl http://neolith:9000/imagenet?batch-next&epoch_id=a1b2c3d4 -o batch_0.tar.lz4
curl http://neolith:9000/imagenet?batch-next&epoch_id=a1b2c3d4 -o batch_1.tar.lz4
# ... repeat until all 4688 batches consumed
```

### Deterministic Shuffling

The `seed` parameter controls the Fisher-Yates shuffle order. Same seed, same order - every time, on every machine. This enables:

- **Reproducible training**: Re-run an experiment with identical data ordering
- **Debugging**: Pinpoint the exact batch that caused a loss spike
- **Checkpoint resume**: Continue from the exact batch where training was interrupted

### Speculative Prefetch

When you register an epoch, Neolith begins assembling future batches before you request them. The `PrefetchPipeline` uses a semaphore-bounded memory budget to stay within configured limits while keeping the next N batches ready in memory. This ensures GPUs never stall waiting for data.

## PyTorch NeolithDataLoader Integration

The `neolith` Python SDK provides a drop-in replacement for PyTorch's DataLoader:

```python
from neolith.pytorch import NeolithDataset, NeolithDataLoader
import torchvision.transforms as T

# Define dataset
dataset = NeolithDataset(
    endpoint="http://neolith:9000",
    bucket="imagenet",
    prefix="train/",
    batch_size=256,
    shuffle=True,
    format="tar+lz4",
)

# Standard PyTorch transforms
transform = T.Compose([
    T.Resize(256),
    T.CenterCrop(224),
    T.ToTensor(),
    T.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
])

loader = NeolithDataLoader(
    dataset,
    num_workers=8,
    decode_fn=lambda buf: transform(Image.open(io.BytesIO(buf))),
)

# Training loop
for epoch in range(100):
    dataset.new_epoch(seed=epoch)
    for images, labels in loader:
        output = model(images.cuda())
        loss = criterion(output, labels.cuda())
        loss.backward()
        optimizer.step()
```

Key design decisions in the SDK:

- **Thread-based prefetch**: Uses `ThreadPoolExecutor` and `queue.Queue` because PyTorch DataLoader workers are processes, not coroutines. No asyncio dependency.
- **Manual TAR parsing**: Parses POSIX ustar headers directly, matching Neolith's server-side TAR format exactly.
- **LZ4 decompression**: Handles the 4-byte LE size prefix used by Neolith's LZ4 framing.
- **IterableDataset**: Streaming batches from the server, not random-access map-style. This matches the sequential nature of epoch-based iteration.

## Server-Side ETL Transforms

Apply data transforms at the storage layer before data crosses the network. This is especially valuable when GPUs are on a different network segment than storage:

```bash
# Register a WASM resize transform
curl -X PUT http://neolith:9000/etl/v1/transforms/resize-224 \
  -H "Content-Type: application/json" \
  -d '{"runtime": "wasm", "module_base64": "AGFzbQ...", "config": {"width": 224, "height": 224}}'

# Fetch a batch with the transform applied
curl -X POST http://neolith:9000/imagenet?batch-get \
  -H "Content-Type: application/json" \
  -d '{"keys": ["img001.jpg", "img002.jpg"], "format": "tar+lz4", "transform": "resize-224"}'
```

Transform results are cached using a BLAKE3-keyed, LZ4-compressed disk cache with LRU eviction. Repeated access to the same object with the same transform skips recomputation entirely.

## Bucket Forks for Experiment Branching

Use bucket forks to create lightweight, copy-on-write branches of a training dataset:

```bash
# Fork the dataset for an experiment
curl -X POST http://neolith:9000/imagenet?fork -d '{"name": "imagenet-augmented"}'

# Add augmented data to the fork (original dataset unchanged)
aws --endpoint-url http://neolith:9000 s3 cp augmented/ s3://imagenet-augmented/ --recursive

# Train on the augmented fork
dataset = NeolithDataset(endpoint="http://neolith:9000", bucket="imagenet-augmented", ...)
```

Forks share the underlying data with the parent bucket - only changed or added objects consume additional storage. This makes it practical to create per-experiment branches without duplicating terabytes of data.

## Example: Training ResNet on ImageNet

A condensed example training ResNet-50 on ImageNet stored in Neolith:

```python
from neolith.pytorch import NeolithDataset, NeolithDataLoader
from torchvision.models import resnet50
import torchvision.transforms as T

transform = T.Compose([T.RandomResizedCrop(224), T.RandomHorizontalFlip(),
                       T.ToTensor(), T.Normalize([0.485,0.456,0.406],[0.229,0.224,0.225])])

dataset = NeolithDataset(
    endpoint="http://neolith:9000", bucket="imagenet",
    prefix="train/", batch_size=256, shuffle=True, format="tar+lz4",
)
loader = NeolithDataLoader(dataset, num_workers=8,
    decode_fn=lambda buf: transform(Image.open(io.BytesIO(buf)).convert("RGB")))

model = resnet50(num_classes=1000).cuda()
criterion = nn.CrossEntropyLoss().cuda()
optimizer = torch.optim.SGD(model.parameters(), lr=0.1, momentum=0.9, weight_decay=1e-4)

for epoch in range(90):
    dataset.new_epoch(seed=epoch)
    for images, labels in loader:
        loss = criterion(model(images.cuda()), labels.cuda())
        optimizer.zero_grad(); loss.backward(); optimizer.step()
```

## Performance Considerations

| Parameter | Recommendation |
|---|---|
| Batch size | 256-1024 objects per batch (amortize HTTP overhead) |
| Workers | 4-8 per GPU (saturate network without contention) |
| Format | `tar+lz4` for JPEG/PNG (already compressed), `tar+zstd` for raw arrays |
| Prefetch | Default pipeline depth is sufficient for most GPU feed rates |
| Network | 25 Gbps+ recommended for multi-GPU nodes |

For detailed benchmarks comparing Neolith batch throughput against per-object GET and competing systems, see the [benchmarks page](/docs/ai-ml/benchmarks).
