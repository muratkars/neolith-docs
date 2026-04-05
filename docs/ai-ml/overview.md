---
sidebar_position: 1
title: "AI/ML Storage Overview"
---

# AI/ML Storage Overview

Neolith is purpose-built for AI/ML storage workloads. While it provides full S3 compatibility for general-purpose use, its architecture and feature set are optimized for the unique I/O patterns of machine learning: bulk reads of millions of small files, deterministic shuffling for reproducible training, and server-side data transforms that move computation to where the data lives.

## Why Object Storage for ML

Traditional ML training pipelines read data from local filesystems or network file shares (NFS, Lustre). This approach has well-known scaling problems:

| Challenge | Filesystem Approach | Object Storage Approach |
|---|---|---|
| Scale | POSIX metadata bottleneck at ~100M files | Flat namespace scales to billions |
| Cost | NVMe/SSD for hot data | Commodity drives + erasure coding |
| Data locality | Copy data to each GPU node | Stream from centralized pool |
| Versioning | Manual snapshots, error-prone | Built-in object versioning |
| Multi-tenancy | Unix permissions, limited | IAM policies, bucket isolation |
| Durability | RAID or replication (2-3x overhead) | Erasure coding (1.3-1.5x overhead) |

The main objection to object storage for training has historically been latency: the S3 `GET` API returns one object per request, creating an HTTP round-trip for every training sample. For ImageNet-scale datasets (1.2M images), this means 1.2M HTTP requests per epoch.

## Neolith's ML-Specific Features

Neolith addresses the latency problem with purpose-built APIs that batch, prefetch, and transform data at the storage layer:

### Batch GET API

Retrieve hundreds or thousands of objects in a single HTTP request. The server assembles objects into a TAR archive, compresses with LZ4 or zstd, and streams the result. This reduces per-object HTTP overhead from ~1ms to ~1us.

```
POST /{bucket}?batch-get
Body: {"keys": ["img001.jpg", "img002.jpg", ...], "format": "tar+lz4"}
Response: TAR+LZ4 compressed archive
```

### Epoch Streaming

Register a training epoch with the server. Neolith shuffles the dataset, partitions it into batches, and speculatively prefetches upcoming batches before the client requests them:

```
POST /{bucket}?batch-epoch   -> {"epoch_id": "...", "total_batches": 4688}
GET  /{bucket}?batch-next&epoch_id=...  -> TAR+LZ4 batch
GET  /{bucket}?batch-next&epoch_id=...  -> TAR+LZ4 batch
... (repeats until all batches consumed)
```

The `EpochManager` uses `AtomicUsize` for lock-free concurrent batch advancement, enabling multiple workers to fetch batches in parallel without contention.

### Deterministic Shuffle

Fisher-Yates shuffle with `StdRng::seed_from_u64` ensures identical object ordering across runs with the same seed. This is critical for:

- **Reproducible training**: Same seed = same results, regardless of which machine runs the training
- **Debugging**: Reproduce an issue by reusing the epoch seed
- **Checkpointing**: Resume from the exact batch where training stopped

### Server-Side ETL

Apply transforms (resize, normalize, augment) at the storage layer before data crosses the network. Three runtime options:

- **Native**: Built-in Rust functions (identity, checksum, metadata extraction)
- **WASM**: Sandboxed WebAssembly modules via Wasmtime (safe, portable, fast)
- **Container**: Docker/OCI containers for complex transforms (TensorFlow, OpenCV)

Results are cached (BLAKE3-keyed, LZ4 disk-backed, LRU eviction) so repeated access to the same transform avoids recomputation.

### PyTorch DataLoader SDK

A drop-in Python SDK that integrates with PyTorch's training loop:

```python
from neolith.pytorch import NeolithDataset, NeolithDataLoader

dataset = NeolithDataset(
    endpoint="http://neolith:9000",
    bucket="imagenet",
    prefix="train/",
    batch_size=256,
    shuffle=True,
)

loader = NeolithDataLoader(dataset, num_workers=8, decode_fn=decode_jpeg)

for epoch in range(100):
    dataset.new_epoch(seed=epoch)
    for images, labels in loader:
        train_step(model, images, labels)
```

## Comparison with Other Approaches

### Local SSD / NVMe

| | Local NVMe | Neolith |
|---|---|---|
| Latency | ~10us (4KB random read) | ~100us (batch amortized per object) |
| Throughput | 3-7 GB/s per drive | Aggregate cluster bandwidth |
| Capacity | Limited by node | Scales with cluster size |
| Data sharing | Copy to each node | Single source of truth |
| Fault tolerance | Node failure = data loss | EC protects against drive/node failure |

**When to use local NVMe**: Single-node training with dataset that fits on local drives.

**When to use Neolith**: Multi-node training, datasets larger than local capacity, need for versioning/lifecycle/transforms.

### POSIX Filesystems (Lustre, GPFS, BeeGFS)

| | POSIX FS | Neolith |
|---|---|---|
| Metadata | Central MDS (bottleneck) | Distributed, per-shard |
| Protocol | POSIX + network FS | HTTP/2 (any language, any network) |
| Consistency | Strong (expensive) | Eventual with HLC (fast) |
| Deployment | Complex (kernel modules, clients) | Single binary, zero dependencies |
| Cost | Expensive license + hardware | Apache 2.0, commodity hardware |

### MinIO / Other S3-Compatible Stores

| | MinIO | Neolith |
|---|---|---|
| Batch API | No (one GET per object) | Yes (batch GET + epoch streaming) |
| Server-side transforms | No | Yes (Native + WASM + Container) |
| ML SDK | No | PyTorch DataLoader SDK |
| Shuffle | Client-side only | Server-side deterministic |
| EC codec | Reed-Solomon only | RS + LRC (local repair) |
| Metadata | XL format, per-object JSON | FlatBuffers, zero-copy MetaView |
| IO engine | Standard | Standard + io_uring (Linux) |

## Data Flow Architecture

```
Training Cluster                    Neolith Cluster
+-----------+                      +-----------+
| GPU Node  |  POST ?batch-epoch   | Node 1    |
| Worker 1  | -------------------> | Shuffle   |
|           |  GET ?batch-next     | Prefetch  |
| Worker 2  | -------------------> | Compress  |
|           |                      | Transform |
| Worker N  | -------------------> |           |
+-----------+                      +-----------+
      |                                  |
      v                                  v
  decode_fn()                    EC decode shards
  collate_fn()                   LZ4/zstd compress
  model.forward()                TAR assemble
  loss.backward()                BLAKE3 verify
```

The key insight is that Neolith pushes work (shuffle, prefetch, transform, compress) to the storage cluster, where it can be parallelized across many nodes, while the GPU nodes focus exclusively on model computation.
