---
sidebar_position: 2
title: "Training Data Pipeline"
---

# Training Data Pipeline

Neolith provides a purpose-built data pipeline for ML training that eliminates the per-object HTTP overhead of standard S3 GETs. The pipeline consists of three layers: Batch GET for one-shot bulk retrieval, Epoch Streaming for iterative training, and a Prefetch Pipeline for zero-stall data delivery.

## Batch GET

The simplest way to retrieve multiple objects is a single `POST ?batch-get` request. The server fetches all requested objects, assembles them into a TAR archive, compresses with LZ4 or zstd, and streams the result.

### Request

```bash
curl -X POST "http://localhost:9000/my-bucket?batch-get" \
  -H "Content-Type: application/json" \
  -d '{
    "keys": ["train/img001.jpg", "train/img002.jpg", "train/img003.jpg"],
    "format": "tar+lz4"
  }'
```

### Request Body

| Field | Type | Default | Description |
|---|---|---|---|
| `keys` | `[String]` | (required) | List of object keys to retrieve |
| `format` | `String` | `"tar+lz4"` | Output format: `tar+lz4` or `tar+zstd` |
| `transform` | `String` | (none) | Optional ETL transform to apply to each object |

### Response

The response body is a compressed TAR archive. Each TAR entry's filename is the object key, and the content is the object data (after decrypt + decompress, if applicable).

The `ObjectFetcher` in `neolith-batch` replicates the full GET pipeline internally: it reads each object's metadata, decrypts (SSE-S3 or SSE-C), decompresses (LZ4/zstd), and then passes the plaintext data to the TAR assembler.

### TAR Format

Neolith produces manual POSIX ustar TAR archives (not using the `tar` crate). Each entry has:

- 512-byte header with ustar magic (`ustar\0`) at offset 257
- Object key in the 100-byte name field
- File size as 11-char octal at offset 124
- Data padded to 512-byte boundaries
- Two consecutive zero blocks terminate the archive

### Compression

**LZ4** (`tar+lz4`): Uses `lz4_flex`'s `compress_prepend_size` format - a 4-byte little-endian uncompressed size prefix followed by the LZ4 block payload. Decompression is extremely fast (~4 GB/s), making it ideal for GPU-bound training.

**zstd** (`tar+zstd`): Standard zstd frame format. Better compression ratio (3-5x vs 2-3x for LZ4) but slower decompression. Best for network-bandwidth-bound scenarios.

## Epoch Streaming

For iterative training where the dataset is consumed sequentially over many epochs, Epoch Streaming avoids the need to specify keys upfront. Instead, you register an epoch and then fetch batches one at a time until the epoch is exhausted.

### Step 1: Register an Epoch

```bash
curl -X POST "http://localhost:9000/my-bucket?batch-epoch" \
  -H "Content-Type: application/json" \
  -d '{
    "prefix": "train/",
    "seed": 42,
    "batch_size": 256,
    "format": "tar+lz4",
    "prefetch_ahead": 8,
    "transform": null
  }'
```

**Request Body:**

| Field | Type | Default | Description |
|---|---|---|---|
| `prefix` | `String` | (none) | Filter objects by key prefix |
| `seed` | `u64` | `0` | Shuffle seed for deterministic ordering |
| `batch_size` | `usize` | `256` | Objects per batch |
| `format` | `String` | `"tar+lz4"` | Compression format |
| `prefetch_ahead` | `usize` | (none) | Number of batches to speculatively prepare |
| `transform` | `String` | (none) | ETL transform to apply |

**Response:**

```json
{
  "epoch_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "total_objects": 1200000,
  "total_batches": 4688
}
```

### Step 2: Fetch Batches

```bash
# Fetch the next batch
curl "http://localhost:9000/my-bucket?batch-next&epoch_id=a1b2c3d4-e5f6-7890-abcd-ef1234567890" \
  -o batch.tar.lz4

# Repeat until all batches consumed
# When exhausted, returns 204 No Content
```

The server tracks the current position with an `AtomicUsize` cursor. Multiple workers can call `batch-next` concurrently - each receives a unique batch with no coordination overhead.

### Step 3: Epoch Cleanup

Epochs expire automatically after a configurable TTL. The server runs a background cleanup task that removes expired epoch state.

## Deterministic Shuffle

When `seed` is provided during epoch registration, the server performs a Fisher-Yates shuffle using `StdRng::seed_from_u64(seed)`. This guarantees:

- **Same seed + same object set = identical ordering** across different machines, different runs, and different Neolith versions (as long as the PRNG algorithm is stable)
- **Different seeds = different orderings** for each epoch, providing the shuffling diversity that SGD requires
- **Resumability**: If training is interrupted at batch N, re-registering with the same seed reproduces the same ordering, allowing you to skip the first N batches

### Example: Reproducible Training

```python
from neolith.pytorch import NeolithDataset

dataset = NeolithDataset(
    endpoint="http://neolith:9000",
    bucket="imagenet",
    batch_size=256,
    shuffle=True,
)

for epoch in range(100):
    # Same seed = same order = reproducible training
    dataset.new_epoch(seed=epoch)

    for name, data in dataset:
        # Objects arrive in the same order every time
        pass
```

## Prefetch Pipeline

When `prefetch_ahead` is set during epoch registration, the server proactively prepares upcoming batches before the client requests them. This is managed by the `PrefetchPipeline` component.

### How It Works

```
Client:     batch-next -> batch-next -> batch-next -> ...
                |              |              |
Server:    [batch 1]    [batch 2]    [batch 3]    ...
           [batch 2]*   [batch 3]*   [batch 4]*
           [batch 3]*   [batch 4]*   [batch 5]*
                        (* = prefetched, ready in memory)
```

1. When the epoch is registered with `prefetch_ahead=N`, the server immediately begins preparing the first N batches.
2. As the client fetches batch K, the server starts preparing batch K+N.
3. A `tokio::sync::Semaphore` controls the memory budget, preventing unbounded prefetch from consuming too much RAM.
4. Each prefetch task reads objects from disk, runs the decrypt/decompress pipeline, assembles the TAR, and compresses with LZ4/zstd.
5. Prefetched batches are held in memory until the client requests them.
6. Shutdown is coordinated via `CancellationToken` from `tokio-util`.

### Memory Budget

The semaphore-based memory budget limits the total size of prefetched batches in memory. With a batch size of 256 objects at ~100KB each, each batch is ~25MB. Prefetching 8 batches ahead uses ~200MB of server memory per active epoch.

For clusters serving many concurrent training jobs, tune `prefetch_ahead` based on available server RAM.

## EpochManager

The `EpochManager` is the central coordinator for epoch state. Key design decisions:

- **`AtomicUsize` for batch cursor**: Lock-free `fetch_add` allows multiple concurrent `batch-next` callers to each receive a unique batch index without any mutex contention.
- **Epoch state map**: `HashMap<String, EpochState>` stores the shuffled key ordering, current position, and format for each active epoch.
- **TTL expiry**: A background task periodically calls `cleanup_expired()` to remove epochs that have been idle beyond their TTL.

### Concurrent Workers

Multiple workers (e.g., 4-8 PyTorch DataLoader threads) can call `batch-next` on the same epoch concurrently. The `AtomicUsize` cursor ensures each worker receives a different batch:

```
Worker 1: fetch_add(1) -> batch 0
Worker 2: fetch_add(1) -> batch 1
Worker 3: fetch_add(1) -> batch 2
Worker 4: fetch_add(1) -> batch 3
Worker 1: fetch_add(1) -> batch 4
...
```

This is critical for keeping all prefetch threads busy without introducing contention.

## Batch + Transform Integration

The Batch API integrates with the ETL transform system. When a `transform` field is specified in the batch request or epoch registration, each object is transformed before being added to the TAR archive:

```bash
# Batch GET with server-side transform
curl -X POST "http://localhost:9000/imagenet?batch-get" \
  -H "Content-Type: application/json" \
  -d '{
    "keys": ["train/n01440764/img001.JPEG", "train/n01440764/img002.JPEG"],
    "format": "tar+lz4",
    "transform": "resize-224"
  }'
```

The transform pipeline:
1. Fetch object data (decrypt + decompress)
2. Check transform cache (BLAKE3 keyed by data hash + transform ID + config)
3. If cache miss: execute transform, store result in cache
4. Add transformed result to TAR archive

This avoids redundant recomputation across epochs while keeping the transform logic server-side.

## Performance Characteristics

| Metric | Per-Object GET | Batch GET (256 objects) |
|---|---|---|
| HTTP round-trips | 256 | 1 |
| Per-object overhead | ~1ms (TCP+TLS+SigV4) | ~4us (amortized) |
| Network efficiency | Headers dominate for small objects | TAR+LZ4 minimizes overhead |
| Server CPU | 256 handler invocations | 1 handler + batch assembly |
| Client complexity | 256 parallel requests + coordination | Single response, parse TAR |

For a 1.2M-object dataset with 256-object batches:
- Per-object GET: 1,200,000 HTTP requests per epoch
- Batch GET: 4,688 HTTP requests per epoch (256x fewer)
