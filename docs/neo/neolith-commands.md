---
sidebar_position: 3
title: "Neolith Commands"
sidebar_label: "Neolith Commands"
---

# Neolith-only commands

These commands surface Neolith features that have no equivalent in bare S3. Each one drives a server-side capability; the pages linked below document the underlying API and behavior. `neo` is the ergonomic front end.

## neo batch

Batch-fetch many objects as a single TAR+LZ4 stream, and register epochs for shuffled iteration over a dataset. See [Batch Operations](../s3-api/batch-operations.md) and the [Training Data Pipeline](../ai-ml/training-data.md) for the server-side model.

```bash
# Fetch a batch and stream it to a path or stdout
neo batch get <alias>/<bucket> [--output -] [--epoch <ID>] [--max-objects 256] [--prefix <PREFIX>]

# Register an epoch (shuffle and commit a snapshot)
neo batch epoch <alias>/<bucket> <epoch-id> [--seed <N>]
```

| `get` flag | Description |
|---|---|
| `-o`, `--output <PATH>` | Output path, or `-` for stdout (default: `-`) |
| `--epoch <ID>` | Epoch identifier for shuffled-iteration batches |
| `--max-objects <N>` | Maximum objects per batch (default: 256) |
| `--prefix <PREFIX>` | Key prefix filter |

`neo batch epoch` takes an epoch `<id>` and an optional `--seed` for deterministic Fisher-Yates shuffling.

```bash
# Stream a training batch as one TAR+LZ4 archive
neo batch get local/training-data --prefix images/ > epoch.tar.lz4

# Register a deterministic epoch, then fetch it
neo batch epoch local/training-data epoch-5 --seed 42
neo batch get local/training-data --epoch epoch-5 -o epoch-5.tar.lz4
```

## neo fork

Create, list, diff, and merge bucket forks: Neolith's zero-copy, copy-on-write branches of a bucket. See [Bucket Forks](../s3-api/forks.md) for the branching model and merge semantics.

```bash
neo fork create <alias>/<source-bucket> <alias>/<fork-bucket>
neo fork ls <alias>/<source-bucket>
neo fork diff <alias>/<fork-bucket>
neo fork merge <alias>/<fork-bucket> <alias>/<target-bucket>
```

`neo fork diff` reports the added, modified, and deleted keys of a fork relative to its source. `neo fork merge` applies those changes onto a target bucket.

```bash
neo fork create local/main local/experiment-v2
neo fork ls local/main
neo fork diff local/experiment-v2
neo fork merge local/experiment-v2 local/main
```

## neo etl

Register, run, and remove server-side ETL transforms. Transforms are WASM (or native) modules that run at the storage layer. See [ETL Transforms](../ai-ml/etl-transforms.md) for the runtimes and execution model.

```bash
neo etl register <alias> <name> <module.wasm>
neo etl ls <alias>
neo etl run <alias>/<bucket>/<key> <transform> <alias>/<bucket>/<out-key>
neo etl rm <alias> <name>
```

`neo etl register` uploads a `.wasm` module and registers it under a name on the cluster. `neo etl run` applies a registered transform to a source object and writes the result to a destination key.

```bash
neo etl register local to-thumbnail ./transforms/thumbnail.wasm
neo etl ls local
neo etl run local/raw/image.png to-thumbnail local/cdn/thumb.png
```

## neo dataset

Inspect ML datasets without downloading the whole object. `neo` reads the format's header or a bounded sample and prints a summary.

```bash
neo dataset peek <alias>/<bucket>/<key> [--format parquet|safetensors|csv|jsonl]
neo dataset schema <alias>/<bucket>/<key>
neo dataset sample <alias>/<bucket>/<key> [-n 10]
```

- `peek` summarizes the object based on its content-type or extension; `--format` overrides the detected format.
- `schema` prints just the schema of a parquet or safetensors object.
- `sample` returns `-n` records (default 10) from a parquet, jsonl, or csv object.

```bash
neo dataset peek local/datasets/train.parquet
neo dataset schema local/datasets/train.parquet
neo dataset sample local/datasets/labels.jsonl -n 5
```
