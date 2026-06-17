---
sidebar_position: 5
title: "PyTorch Tutorial"
---

# PyTorch Tutorial

This tutorial walks through an end-to-end workflow: uploading a training dataset to Neolith, creating a PyTorch DataLoader that streams data from the server, and training a model with epoch-based shuffling and prefetch.

## Prerequisites

- A running Neolith server (`neolith server start /data`)
- Python 3.12+
- PyTorch installed (`pip install torch torchvision`)
- Neolith Python SDK installed (`pip install -e sdk/python[torch]`)

## Step 1: Upload Training Data

First, upload your training dataset to a Neolith bucket. You can use any S3-compatible tool:

```python
import boto3
import os

s3 = boto3.client(
    "s3",
    endpoint_url="http://localhost:9000",
    aws_access_key_id="minioadmin",
    aws_secret_access_key="minioadmin",
    region_name="us-east-1",
)

# Create a bucket for training data
s3.create_bucket(Bucket="imagenet")

# Upload training images
train_dir = "/path/to/imagenet/train"
for class_dir in os.listdir(train_dir):
    class_path = os.path.join(train_dir, class_dir)
    if not os.path.isdir(class_path):
        continue
    for img_file in os.listdir(class_path):
        img_path = os.path.join(class_path, img_file)
        key = f"train/{class_dir}/{img_file}"
        s3.upload_file(img_path, "imagenet", key)
        print(f"Uploaded: {key}")
```

For large datasets, use the AWS CLI for faster parallel uploads:

```bash
aws --endpoint-url http://localhost:9000 \
  s3 sync /path/to/imagenet/train/ s3://imagenet/train/ \
  --exclude ".*"
```

## Step 2: Create the Dataset

The `NeolithDataset` wraps Neolith's Batch API as a PyTorch `IterableDataset`:

```python
from neolith.pytorch import NeolithDataset

dataset = NeolithDataset(
    endpoint="http://localhost:9000",
    bucket="imagenet",
    prefix="train/",       # Only objects under train/
    batch_size=256,        # 256 images per server batch
    shuffle=True,          # Shuffle each epoch
    format="tar+lz4",     # LZ4 for fast decompression
    speculative=True,      # Enable server-side prefetch
    prefetch_ahead=8,      # Prefetch 8 batches ahead on server
)
```

### How It Works

When you iterate over the dataset:

1. `new_epoch(seed)` is called (automatically on first iteration if not called manually)
2. The server lists all objects matching `prefix="train/"`, shuffles them with the given seed, and partitions into batches of 256
3. Each call to `__next__` fetches the next server batch via `GET ?batch-next`, decompresses the LZ4 payload, and parses the TAR archive
4. Individual `(name, data_bytes)` tuples are yielded to the caller

## Step 3: Create the DataLoader

The `NeolithDataLoader` adds multi-threaded prefetch on the client side:

```python
from neolith.pytorch import NeolithDataLoader
from PIL import Image
from torchvision import transforms
import io
import torch

# Image preprocessing pipeline
preprocess = transforms.Compose([
    transforms.Resize(256),
    transforms.CenterCrop(224),
    transforms.ToTensor(),
    transforms.Normalize(
        mean=[0.485, 0.456, 0.406],
        std=[0.229, 0.224, 0.225],
    ),
])

# Class name to index mapping
class_to_idx = {}  # Populate from dataset metadata

def decode_sample(name: str, data: bytes):
    """Decode a raw (name, bytes) pair into a (tensor, label) pair."""
    # Parse class from path: train/n01440764/ILSVRC2012_val_00000293.JPEG
    parts = name.split("/")
    class_name = parts[1] if len(parts) >= 3 else "unknown"

    if class_name not in class_to_idx:
        class_to_idx[class_name] = len(class_to_idx)

    label = class_to_idx[class_name]
    image = Image.open(io.BytesIO(data)).convert("RGB")
    tensor = preprocess(image)
    return tensor, label

def collate_fn(samples):
    """Collate a list of (tensor, label) pairs into a batch."""
    images = torch.stack([s[0] for s in samples])
    labels = torch.tensor([s[1] for s in samples], dtype=torch.long)
    return images, labels

loader = NeolithDataLoader(
    dataset=dataset,
    num_workers=8,          # 8 background fetch threads
    prefetch_factor=4,      # Buffer 4 batches per worker (32 total)
    decode_fn=decode_sample,
    collate_fn=collate_fn,
)
```

### Prefetch Architecture

```
Main Thread                Worker Threads (8x)
  |                          |
  |                     [Thread 1] GET batch-next -> decompress -> parse TAR
  |                     [Thread 2] GET batch-next -> decompress -> parse TAR
  |                     [Thread 3] GET batch-next -> decompress -> parse TAR
  |   <-- queue.get()   [Thread 4] GET batch-next -> decompress -> parse TAR
  |                     [Thread 5] GET batch-next -> decompress -> parse TAR
  v                     [Thread 6] GET batch-next -> decompress -> parse TAR
decode_sample()         [Thread 7] GET batch-next -> decompress -> parse TAR
collate_fn()            [Thread 8] GET batch-next -> decompress -> parse TAR
model.forward()              |
loss.backward()         queue.put(entries)  <-- bounded queue (32 slots)
```

The main thread never blocks on I/O. Worker threads handle HTTP requests, decompression, and TAR parsing in parallel. The bounded `queue.Queue` prevents workers from consuming unbounded memory.

## Step 4: Training Loop

```python
import torch.nn as nn
import torch.optim as optim

# Model
model = torchvision.models.resnet50(pretrained=False)
model = model.cuda()  # Move to GPU

# Optimizer and loss
optimizer = optim.SGD(model.parameters(), lr=0.1, momentum=0.9, weight_decay=1e-4)
scheduler = optim.lr_scheduler.StepLR(optimizer, step_size=30, gamma=0.1)
criterion = nn.CrossEntropyLoss().cuda()

# Training
num_epochs = 90

for epoch in range(num_epochs):
    model.train()

    # Register new epoch with deterministic seed
    dataset.new_epoch(seed=epoch)

    running_loss = 0.0
    correct = 0
    total = 0

    for batch_idx, (images, labels) in enumerate(loader):
        images = images.cuda(non_blocking=True)
        labels = labels.cuda(non_blocking=True)

        optimizer.zero_grad()
        outputs = model(images)
        loss = criterion(outputs, labels)
        loss.backward()
        optimizer.step()

        running_loss += loss.item()
        _, predicted = outputs.max(1)
        total += labels.size(0)
        correct += predicted.eq(labels).sum().item()

        if batch_idx % 100 == 0:
            print(
                f"Epoch {epoch} [{batch_idx}/{dataset._epoch_id}] "
                f"Loss: {running_loss / (batch_idx + 1):.4f} "
                f"Acc: {100. * correct / total:.2f}%"
            )

    scheduler.step()

    # Save checkpoint to Neolith
    checkpoint = {
        "epoch": epoch,
        "model_state_dict": model.state_dict(),
        "optimizer_state_dict": optimizer.state_dict(),
        "accuracy": correct / total,
    }

    import io
    buffer = io.BytesIO()
    torch.save(checkpoint, buffer)
    buffer.seek(0)

    s3.put_object(
        Bucket="checkpoints",
        Key=f"resnet50/epoch-{epoch}.pt",
        Body=buffer,
    )
    print(f"Checkpoint saved: resnet50/epoch-{epoch}.pt")
```

## Step 5: Server-Side Transforms (Optional)

Register a transform to resize images on the server, reducing network transfer:

```bash
# Register a WASM resize transform (hypothetical)
curl -X PUT "http://localhost:9000/etl/v1/transforms/resize-224" \
  -H "Content-Type: application/json" \
  -d '{"runtime": "native", "function": "identity"}'
```

Then create a dataset with the transform:

```python
dataset_with_transform = NeolithDataset(
    endpoint="http://localhost:9000",
    bucket="imagenet",
    prefix="train/",
    batch_size=256,
    transform="resize-224",  # Apply server-side
)
```

When a transform is applied, the `decode_fn` receives already-transformed data, potentially skipping expensive client-side preprocessing.

## Multi-Worker Training

For distributed training with multiple GPU nodes, each worker can create its own dataset and loader. The server handles concurrent `batch-next` requests efficiently via the lock-free `AtomicUsize` batch cursor.

```python
import torch.distributed as dist

def train_worker(rank, world_size):
    dist.init_process_group("nccl", rank=rank, world_size=world_size)

    dataset = NeolithDataset(
        endpoint="http://neolith-cluster:9000",
        bucket="imagenet",
        prefix="train/",
        batch_size=256,
    )

    loader = NeolithDataLoader(
        dataset=dataset,
        num_workers=4,  # 4 threads per GPU
        decode_fn=decode_sample,
        collate_fn=collate_fn,
    )

    model = torchvision.models.resnet50()
    model = model.cuda(rank)
    model = nn.parallel.DistributedDataParallel(model, device_ids=[rank])

    for epoch in range(90):
        # All ranks use the same seed = same shuffle order
        # Each rank's workers fetch different batches (AtomicUsize cursor)
        dataset.new_epoch(seed=epoch)

        for images, labels in loader:
            images = images.cuda(rank, non_blocking=True)
            labels = labels.cuda(rank, non_blocking=True)
            # ... training step ...
```

### Important Notes for Multi-Worker

- All workers sharing the same `epoch_id` consume from the same batch sequence - each worker gets unique batches automatically
- If you want each worker to see the full dataset independently, register separate epochs (one per worker)
- The server's `PrefetchPipeline` is shared across all workers on the same epoch, so prefetch benefits all concurrent consumers

## Performance Tips

1. **Batch size**: For images averaging 100KB, a batch_size of 256 produces ~25MB batches. This is a good balance between HTTP overhead reduction and per-batch latency.

2. **Workers**: Set `num_workers` to 2x the number of CPU cores available for the data loading process. More workers help hide I/O latency but consume more CPU for decompression.

3. **Prefetch**: Set `prefetch_factor=4` as a starting point. If you see GPU idle time (low utilization), increase it. If memory is constrained, decrease it.

4. **Server prefetch**: `prefetch_ahead=8` keeps 8 batches ready on the server. For high-latency networks, increase this value.

5. **Compression**: Use `tar+lz4` (default) for GPU-bound training. Use `tar+zstd` only if network bandwidth is the bottleneck.

6. **Transform caching**: If using server-side transforms, the first epoch will be slower (cache cold). Subsequent epochs benefit from the transform cache.
