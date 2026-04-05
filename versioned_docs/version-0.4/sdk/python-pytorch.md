---
sidebar_position: 2
title: "PyTorch DataLoader SDK"
---

# PyTorch DataLoader SDK

The Neolith Python SDK provides a purpose-built `IterableDataset` and `DataLoader` for streaming training data directly from Neolith into PyTorch training loops. It leverages Neolith's Batch API for high-throughput data loading with server-side shuffle, epoch management, and speculative prefetch.

## Requirements

- Python 3.12+
- PyTorch (any recent version)
- `lz4` Python package (for TAR+LZ4 decompression)
- `zstandard` Python package (optional, for TAR+zstd decompression)

## Installation

```bash
# From the Neolith repository
cd sdk/python
pip install -e ".[torch]"

# Or install dependencies manually
pip install torch lz4 zstandard
```

## Architecture

The SDK is designed around PyTorch's threading model. Since PyTorch DataLoaders use thread pools (not asyncio), the SDK uses synchronous HTTP requests via the `requests` library and `ThreadPoolExecutor` for background prefetch.

```
NeolithDataLoader
  |
  +-- Worker Thread 1 --+-- HTTP GET ?batch-next --> Server
  +-- Worker Thread 2 --+-- Decompress (LZ4/zstd)
  +-- Worker Thread 3 --+-- Parse TAR
  +-- Worker Thread 4 --+-- Put entries in Queue
  |
  +-- Main Thread: queue.get() --> decode_fn --> yield sample
```

### Data Flow

1. `NeolithDataset.new_epoch()` registers an epoch with the server (`POST ?batch-epoch`), which prepares a shuffled ordering of all objects matching the prefix filter.
2. `NeolithDataLoader.__iter__()` spawns worker threads that call `GET ?batch-next` to fetch batches.
3. Each batch is a TAR+LZ4 (or TAR+zstd) compressed archive containing multiple objects.
4. Workers decompress and parse the TAR archive into `(name, data_bytes)` tuples.
5. The main thread consumes entries from the queue, optionally applying `decode_fn` and `collate_fn`.

## Core Classes

### `NeolithDataset`

A PyTorch `IterableDataset` that streams objects from Neolith one epoch at a time.

```python
from neolith.pytorch import NeolithDataset

dataset = NeolithDataset(
    endpoint="http://localhost:9000",
    bucket="training-data",
    prefix="imagenet/train/",    # Filter by key prefix
    transform=None,               # Optional ETL transform name
    batch_size=256,               # Objects per server batch
    shuffle=True,                 # Shuffle each epoch
    format="tar+lz4",            # Compression format
    speculative=True,             # Use server-side prefetch
    prefetch_ahead=8,             # Batches to prefetch on server
)
```

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `endpoint` | `str` | (required) | Neolith server URL |
| `bucket` | `str` | (required) | Source bucket name |
| `prefix` | `str` | `""` | Filter objects by key prefix |
| `transform` | `str` or `None` | `None` | ETL transform to apply server-side |
| `batch_size` | `int` | `256` | Number of objects per batch |
| `shuffle` | `bool` | `True` | Whether to shuffle the dataset |
| `format` | `str` | `"tar+lz4"` | Batch format: `tar+lz4` or `tar+zstd` |
| `speculative` | `bool` | `True` | Enable server-side speculative prefetch |
| `prefetch_ahead` | `int` | `8` | Number of batches for server to prepare ahead |

**Epoch Management:**

```python
# Explicitly register a new epoch with a seed for reproducibility
info = dataset.new_epoch(seed=42)
print(f"Epoch has {info['total_objects']} objects in {info['total_batches']} batches")

# Iterate - yields (name: str, data: bytes) tuples
for name, data in dataset:
    image = decode_image(data)
    # ... process
```

If `new_epoch()` is not called explicitly, the first iteration automatically calls `new_epoch(0)`.

**Deterministic Shuffle:**

The server uses Fisher-Yates shuffle with a `StdRng::seed_from_u64` seeded PRNG. Given the same seed, object ordering is identical across epochs and machines, enabling reproducible training.

### `NeolithDataLoader`

A wrapper around `NeolithDataset` that adds multi-threaded background prefetch with a bounded queue. This keeps the GPU fed by overlapping data loading with model computation.

```python
from neolith.pytorch import NeolithDataset, NeolithDataLoader

dataset = NeolithDataset(
    endpoint="http://localhost:9000",
    bucket="training-data",
    prefix="imagenet/train/",
    batch_size=256,
)

loader = NeolithDataLoader(
    dataset=dataset,
    num_workers=4,          # Background fetch threads
    prefetch_factor=4,      # Batches buffered per worker
    decode_fn=decode_image, # Decode raw bytes to tensor
    collate_fn=collate_batch, # Collate samples into batch
)
```

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `dataset` | `NeolithDataset` | (required) | The dataset to load from |
| `num_workers` | `int` | `4` | Number of background fetch/decompress threads |
| `prefetch_factor` | `int` | `4` | Queue capacity per worker |
| `decode_fn` | `Callable` or `None` | `None` | Function to decode `(name, bytes) -> sample` |
| `collate_fn` | `Callable` or `None` | `None` | Function to collate `[samples] -> batch` |

**Worker Thread Model:**

The loader uses `ThreadPoolExecutor` (not `multiprocessing`) because:
- PyTorch DataLoader uses threads internally, not asyncio
- Thread-based I/O avoids the overhead of process spawning and IPC
- The GIL is released during I/O operations and LZ4/zstd decompression

Each worker thread runs a fetch loop:
1. Call `GET ?batch-next&epoch_id=...` to fetch a compressed batch
2. Decompress the LZ4 (4-byte LE size prefix + block payload) or zstd payload
3. Parse the POSIX ustar TAR archive into `(name, data)` entries
4. Push entries onto a bounded `queue.Queue`

The main thread pulls entries from the queue. If `decode_fn` is provided, each entry is decoded (e.g., JPEG to tensor). If `collate_fn` is provided, the decoded samples from one server batch are collated into a single batch tensor.

## TAR Format

The SDK implements a manual POSIX ustar TAR parser (no `tarfile` module) to match the format produced by `neolith-batch`. Key characteristics:

- 512-byte block alignment
- Standard ustar magic (`ustar\0`) at offset 257
- 11-character octal size field at offset 124
- Object keys stored in the 100-byte name field
- Two zero blocks terminate the archive

## LZ4 Decompression

Neolith's LZ4 format uses `lz4_flex`'s `compress_prepend_size` convention:
- First 4 bytes: little-endian `u32` uncompressed size
- Remaining bytes: LZ4 block payload

The SDK reads this prefix and passes the uncompressed size to `lz4.block.decompress()` for efficient deallocation.

## Complete Training Example

```python
import torch
import torch.nn as nn
from torchvision import transforms
from PIL import Image
import io

from neolith.pytorch import NeolithDataset, NeolithDataLoader

# Define how to decode raw bytes into a training sample
transform = transforms.Compose([
    transforms.Resize(256),
    transforms.CenterCrop(224),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.485, 0.456, 0.406],
                         std=[0.229, 0.224, 0.225]),
])

def decode_image(name: str, data: bytes):
    """Decode JPEG bytes into a normalized tensor."""
    img = Image.open(io.BytesIO(data)).convert("RGB")
    tensor = transform(img)
    # Extract label from path: imagenet/train/n01234567/img_001.JPEG
    label = int(name.split("/")[2][1:])  # class index from synset
    return tensor, label

def collate_batch(samples):
    """Stack individual (tensor, label) pairs into a batch."""
    images = torch.stack([s[0] for s in samples])
    labels = torch.tensor([s[1] for s in samples])
    return images, labels

# Create dataset and loader
dataset = NeolithDataset(
    endpoint="http://neolith-cluster:9000",
    bucket="imagenet",
    prefix="train/",
    batch_size=256,
    shuffle=True,
    format="tar+lz4",
)

loader = NeolithDataLoader(
    dataset=dataset,
    num_workers=8,
    prefetch_factor=4,
    decode_fn=decode_image,
    collate_fn=collate_batch,
)

# Training loop
model = nn.Linear(224 * 224 * 3, 1000)  # placeholder
optimizer = torch.optim.SGD(model.parameters(), lr=0.01)
criterion = nn.CrossEntropyLoss()

for epoch in range(10):
    dataset.new_epoch(seed=epoch)  # Deterministic shuffle per epoch

    for batch_idx, (images, labels) in enumerate(loader):
        optimizer.zero_grad()
        outputs = model(images.view(images.size(0), -1))
        loss = criterion(outputs, labels)
        loss.backward()
        optimizer.step()

        if batch_idx % 100 == 0:
            print(f"Epoch {epoch}, Batch {batch_idx}, Loss: {loss.item():.4f}")
```

## Performance Tuning

### Server-Side Prefetch

When `speculative=True` (default), the server uses a `PrefetchPipeline` with a `Semaphore`-based memory budget to prepare batches before the client requests them. This eliminates server-side latency for sequential batch reads.

The `prefetch_ahead` parameter controls how many batches the server prepares in advance. Higher values use more server memory but reduce stalls.

### Client-Side Prefetch

The `NeolithDataLoader`'s `num_workers * prefetch_factor` determines how many batches are buffered client-side. A queue depth of 16-32 batches typically keeps the GPU busy.

### Batch Size

Larger `batch_size` values (256-1024) reduce the number of HTTP round-trips but increase per-batch latency and memory usage. The optimal value depends on object size:

| Object Size | Recommended Batch Size |
|---|---|
| < 100 KB (thumbnails) | 512-1024 |
| 100 KB - 1 MB (images) | 128-256 |
| 1 MB - 10 MB (high-res) | 32-64 |
| > 10 MB (video clips) | 8-16 |

### Compression Format

- **`tar+lz4`** (default): Very fast decompression, moderate compression ratio. Best for GPU-bound training where decompression overhead must be minimal.
- **`tar+zstd`**: Better compression ratio, slower decompression. Best for network-bandwidth-bound scenarios.
