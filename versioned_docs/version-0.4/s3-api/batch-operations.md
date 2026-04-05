---
sidebar_position: 12
title: "Batch Operations"
---

# Batch Operations

Neolith provides high-performance batch operations designed for machine learning training workloads. These APIs allow retrieving multiple objects in a single request as compressed TAR archives, with support for deterministic shuffling, epoch-based iteration, and prefetch pipelines.

## Overview

The batch API extends the standard S3 interface with three operations:

| Operation | Method | Query Parameter | Description |
|---|---|---|---|
| Batch GET | POST | `?batch-get` | One-shot retrieval of multiple objects as TAR archive |
| Batch Epoch | POST | `?batch-epoch` | Register an epoch for streaming training iteration |
| Batch Next | GET | `?batch-next` | Fetch the next batch in a sliding window |

All batch responses return data as a TAR archive, optionally compressed with LZ4 or zstd.

## Batch GET (One-Shot)

Retrieves multiple objects in a single request, returned as a TAR+LZ4 or TAR+zstd archive. Each object passes through the full GET pipeline (decrypt, decompress) before being assembled into the archive.

**Request:**

```
POST /<bucket>?batch-get HTTP/1.1
Host: localhost:9000
Content-Type: application/json

{
  "keys": [
    "training/image-0001.jpg",
    "training/image-0002.jpg",
    "training/image-0003.jpg",
    "training/image-0004.jpg"
  ],
  "format": "tar+lz4"
}
```

**curl:**

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "keys": [
      "training/image-0001.jpg",
      "training/image-0002.jpg",
      "training/image-0003.jpg"
    ],
    "format": "tar+lz4"
  }' \
  "http://localhost:9000/my-bucket?batch-get" \
  -o batch.tar.lz4
```

**Response:**

```
HTTP/1.1 200 OK
Content-Type: application/x-tar+lz4
Content-Length: <size>
x-amz-request-id: 550e8400-e29b-41d4-a716-446655440000

<TAR+LZ4 binary data>
```

### Supported Formats

| Format | Content-Type | Description |
|---|---|---|
| `tar` | `application/x-tar` | Uncompressed POSIX ustar TAR |
| `tar+lz4` | `application/x-tar+lz4` | TAR compressed with LZ4 (default) |
| `tar+zstd` | `application/x-tar+zstd` | TAR compressed with zstd |

### Batch GET with ETL Transform

You can apply an inline transform to each object during batch retrieval:

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "keys": ["data/raw-001.bin", "data/raw-002.bin"],
    "format": "tar+lz4",
    "transform": "to-json-meta"
  }' \
  "http://localhost:9000/my-bucket?batch-get" \
  -o transformed.tar.lz4
```

The transform is applied to each object before it is assembled into the archive. The `neolith-etl` module handles transforms independently (no circular dependency with `neolith-batch`).

## Batch Epoch (Register Epoch)

Registers an epoch for streaming training iteration. The epoch defines a dataset (by prefix or key list) and a shuffle seed for deterministic ordering.

**Request:**

```
POST /<bucket>?batch-epoch HTTP/1.1
Host: localhost:9000
Content-Type: application/json

{
  "prefix": "training/",
  "batch_size": 64,
  "seed": 42,
  "format": "tar+lz4"
}
```

**curl:**

```bash
awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "prefix": "training/",
    "batch_size": 64,
    "seed": 42,
    "format": "tar+lz4"
  }' \
  "http://localhost:9000/my-bucket?batch-epoch"
```

**Response (200 OK):**

```json
{
  "epoch_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "total_keys": 50000,
  "total_batches": 782,
  "batch_size": 64,
  "seed": 42,
  "format": "tar+lz4"
}
```

### Deterministic Shuffling

The `seed` parameter controls the Fisher-Yates shuffle applied to the key list. Using the same seed produces the same ordering, enabling:

- **Reproducible training** - identical data ordering across runs
- **Multi-worker consistency** - different workers can independently compute the same shuffle
- **Resumable training** - restart from a specific batch without re-shuffling

The shuffle uses `StdRng::seed_from_u64` for deterministic, portable randomness.

### Epoch Parameters

| Parameter | Type | Description | Default |
|---|---|---|---|
| `prefix` | string | Key prefix to match dataset objects | (required) |
| `batch_size` | integer | Number of objects per batch | 32 |
| `seed` | integer | Shuffle seed for deterministic ordering | 0 (no shuffle) |
| `format` | string | Output format (`tar`, `tar+lz4`, `tar+zstd`) | `tar+lz4` |

## Batch Next (Fetch Next Batch)

Fetches the next batch in the epoch's sliding window. The `EpochManager` uses `AtomicUsize` for lock-free concurrent batch advance, allowing multiple workers to safely consume batches in parallel.

**Request:**

```
GET /<bucket>?batch-next&epoch_id=<epoch-id> HTTP/1.1
Host: localhost:9000
```

**curl:**

```bash
EPOCH_ID="a1b2c3d4-e5f6-7890-abcd-ef1234567890"

awscurl --service s3 --region us-east-1 \
  --access_key myaccesskey --secret_key mysecretkey \
  "http://localhost:9000/my-bucket?batch-next&epoch_id=$EPOCH_ID" \
  -o batch-0.tar.lz4
```

**Response:**

```
HTTP/1.1 200 OK
Content-Type: application/x-tar+lz4
x-neolith-batch-index: 0
x-neolith-batch-total: 782
x-neolith-epoch-id: a1b2c3d4-e5f6-7890-abcd-ef1234567890
x-amz-request-id: 660f9500-f39c-52e5-b827-557766551111

<TAR+LZ4 binary data>
```

### Response Headers

| Header | Description |
|---|---|
| `x-neolith-batch-index` | Zero-based index of the current batch |
| `x-neolith-batch-total` | Total number of batches in the epoch |
| `x-neolith-epoch-id` | Echo of the epoch ID |

### End of Epoch

When all batches have been consumed, the next request returns:

```
HTTP/1.1 204 No Content
x-neolith-batch-index: 782
x-neolith-batch-total: 782
x-neolith-epoch-complete: true
```

## Prefetch Pipeline

The batch system includes a `PrefetchPipeline` that reads ahead of the current batch position, keeping data ready in memory for low-latency serving:

- **Semaphore memory budget** - limits total prefetched data to prevent OOM
- **CancellationToken shutdown** - clean shutdown when the server stops
- **Concurrent I/O** - multiple objects fetched in parallel within each batch

## TAR Format

Neolith uses manual POSIX ustar TAR format (not the `tar` crate) for maximum control and compatibility. Each entry in the archive contains:

- A 512-byte ustar header with the object key as the filename
- The object data, padded to a 512-byte boundary
- Two 512-byte zero blocks at the end of the archive

The LZ4 compression uses a 4-byte little-endian size prefix matching `lz4_flex` format for cross-language compatibility.

## Python SDK Integration

The Neolith PyTorch SDK (`neolith-pytorch`) provides native integration with PyTorch DataLoader:

```python
from neolith_pytorch import NeolithDataset

# Create a streaming dataset
dataset = NeolithDataset(
    endpoint="http://localhost:9000",
    bucket="training-data",
    prefix="imagenet/train/",
    batch_size=64,
    seed=42,
    access_key="myaccesskey",
    secret_key="mysecretkey",
)

# Use with PyTorch DataLoader
from torch.utils.data import DataLoader

loader = DataLoader(dataset, batch_size=None, num_workers=0)
for batch in loader:
    images, labels = batch
    # train...
```

The PyTorch SDK uses:

- `requests` (not `aiohttp`) because PyTorch DataLoader uses threads, not asyncio
- Thread-based prefetch via `ThreadPoolExecutor` + `queue.Queue`
- Manual POSIX ustar TAR parsing matching the server's `tar.rs` format
- LZ4 decompression with 4-byte LE size prefix (`lz4_flex` compatible)
- `IterableDataset` (not map-style) for streaming batches without random access

## Router Dispatch

The batch API is dispatched via query parameters on the bucket route:

| Query | Method | Handler |
|---|---|---|
| `?batch-get` | POST | `batch_get_handler` |
| `?batch-epoch` | POST | `batch_epoch_handler` |
| `?batch-next` | GET | `batch_next_handler` |

The `GET /<bucket>` route dispatcher checks for `batch-next` before falling back to `list-objects`.

## Architecture

```
AppState.batch: Option<Arc<BatchState>>
  |
  +-- EpochManager (AtomicUsize batch counter)
  |     +-- epoch registry (HashMap<epoch_id, Epoch>)
  |     +-- Fisher-Yates shuffle (StdRng::seed_from_u64)
  |
  +-- PrefetchPipeline
  |     +-- Semaphore memory budget
  |     +-- CancellationToken shutdown
  |
  +-- ObjectFetcher
        +-- replicates GET pipeline (decrypt + decompress)
        +-- assembles TAR entries
```

The batch system is always-on (`AppState.batch` is always `Some`), with a background cleanup task managing expired epochs.
