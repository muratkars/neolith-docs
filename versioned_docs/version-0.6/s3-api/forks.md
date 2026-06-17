---
sidebar_position: 14
title: "Bucket Forks"
---

# Bucket Forks

Bucket forks are Neolith's zero-copy branching mechanism for object storage. A fork creates a lightweight, metadata-only branch of a source bucket - no data is copied at creation time. Writes to the fork go to the fork bucket (copy-on-write), while reads fall through to the source bucket for keys that have not been modified or masked.

## Overview

Think of forks as Git branches for your object storage. They enable:

- **ML experiment isolation**: fork a training dataset, modify it freely, merge back if results improve
- **Data pipeline staging**: fork production data, run transforms against the fork, promote on success
- **A/B testing**: fork a model artifact bucket, deploy variant B from the fork
- **Safe exploration**: fork any bucket, make destructive changes, discard without affecting the original

### Key Properties

- **Zero-copy creation**: forking a bucket with millions of objects is instant (only metadata is written)
- **Copy-on-write**: data is only duplicated when you write to the fork
- **Source isolation**: deletes and writes on a fork never touch the source bucket
- **Full S3 compatibility**: forks are regular buckets that support all S3 operations

## Creating a Fork

Create a fork by sending a PUT request with the `fork` query parameter specifying the source bucket:

```bash
curl -X PUT "http://localhost:9000/experiment-1?fork=training-data"
```

Response:

```json
{
  "fork_bucket": "experiment-1",
  "source_bucket": "training-data",
  "state": "active",
  "created_at": "2026-04-01T12:00:00Z"
}
```

The fork records an HLC timestamp at creation time, capturing the point-in-time snapshot of the source bucket.

### Prerequisites

- The source bucket must exist
- The fork bucket name must not already exist
- The source bucket cannot itself be a fork (no fork-of-fork)

## Read-Through Semantics

When you GET an object from a fork bucket, Neolith follows this lookup order:

1. **Mask check**: if the key is in the fork's mask set, return 404 (the key was explicitly deleted from this fork's view)
2. **Fork bucket**: if the key exists in the fork bucket's own storage, return it (this is a fork-local write)
3. **Source fallback**: if the key exists in the source bucket, return it (transparent read-through)
4. **Not found**: return 404

This means a freshly created fork immediately "contains" all objects from the source bucket without copying any data.

```bash
# Source bucket has file.txt
curl -X PUT "http://localhost:9000/training-data/file.txt" -d "original"

# Create a fork
curl -X PUT "http://localhost:9000/experiment-1?fork=training-data"

# Read through to source - returns "original"
curl "http://localhost:9000/experiment-1/file.txt"
```

## Writing to a Fork

Writes always go to the fork bucket's own storage. The source bucket is never modified.

```bash
# Write to the fork - creates a fork-local copy
curl -X PUT "http://localhost:9000/experiment-1/file.txt" -d "modified for experiment"

# The fork now returns the modified version
curl "http://localhost:9000/experiment-1/file.txt"
# -> "modified for experiment"

# The source is untouched
curl "http://localhost:9000/training-data/file.txt"
# -> "original"
```

If you PUT a key that was previously masked (deleted from the fork), the mask entry is removed and the fork-local copy becomes visible.

## Deleting from a Fork (Masking)

When you DELETE an object from a fork, Neolith adds the key to the fork's mask set instead of removing data from the source bucket. This preserves source data integrity while giving each fork an independent view.

```bash
# Delete a key from the fork's view
curl -X DELETE "http://localhost:9000/experiment-1/old-data.csv"

# The fork returns 404
curl "http://localhost:9000/experiment-1/old-data.csv"
# -> 404

# The source still has it
curl "http://localhost:9000/training-data/old-data.csv"
# -> 200 OK
```

The mask is stored as a JSON sidecar file (`.neolith/forks/<fork_bucket>.mask.json`). It uses a `BTreeSet` for deterministic ordering, which makes debugging and diff output reproducible.

## Fork Diff

Compute the difference between a fork and its source bucket:

```bash
curl "http://localhost:9000/experiment-1?fork-diff"
```

Response:

```json
{
  "added": ["new-file.txt", "extra-data.parquet"],
  "modified": ["file.txt", "config.json"],
  "deleted": ["old-data.csv"]
}
```

| Category | Meaning |
|---|---|
| `added` | Keys that exist in the fork but not in the source |
| `modified` | Keys that exist in both but the fork has its own version |
| `deleted` | Keys in the mask set (deleted from the fork's view) |

## Fork Merge

Merge a fork's changes back into a target bucket:

```bash
curl -X POST "http://localhost:9000/experiment-1?fork-merge=training-data"
```

Response:

```json
{
  "merged": 5,
  "deleted": 1,
  "skipped": 0
}
```

The merge operation:

1. Computes the diff between fork and source
2. Copies all added and modified objects from the fork to the target bucket (via direct MetaStore calls)
3. Deletes masked keys from the target bucket
4. Transitions the fork state to `Merged`

The target bucket is typically the source bucket, but you can merge into any existing bucket.

**Important**: merge is not atomic. If the server crashes mid-merge, some objects may be copied while others are not. Re-running the merge is safe because it is idempotent: already-copied objects will be overwritten with the same data.

## Listing Forks

List all forks of a bucket:

```bash
curl "http://localhost:9000/training-data?fork-list"
```

Response:

```json
[
  {
    "fork_bucket": "experiment-1",
    "source_bucket": "training-data",
    "state": "active",
    "created_at": "2026-04-01T12:00:00Z"
  },
  {
    "fork_bucket": "experiment-2",
    "source_bucket": "training-data",
    "state": "merged",
    "created_at": "2026-04-02T09:30:00Z"
  }
]
```

## Fork Lifecycle States

Forks have three lifecycle states with one-way transitions:

```
Active --> Merged
Active --> Detached
```

| State | Description |
|---|---|
| `Active` | Fork is live and accepting reads/writes with read-through to source |
| `Merged` | Fork has been merged into a target. No further operations allowed. |
| `Detached` | Fork has been disconnected from its source (standalone bucket). |

A merged or detached fork cannot be reactivated. Create a new fork instead.

## Complete Example: ML Experiment Workflow

Here is a full workflow showing how to use forks for ML experiment isolation:

```bash
# 1. Start with a production training dataset
curl -X PUT "http://localhost:9000/training-data"
curl -X PUT "http://localhost:9000/training-data/labels.csv" -d "id,label\n1,cat\n2,dog"
curl -X PUT "http://localhost:9000/training-data/config.json" -d '{"epochs": 10}'

# 2. Fork it for an experiment
curl -X PUT "http://localhost:9000/exp-augmented?fork=training-data"
# -> {"fork_bucket":"exp-augmented","source_bucket":"training-data","state":"active",...}

# 3. Modify the fork: add augmented data, tweak config
curl -X PUT "http://localhost:9000/exp-augmented/augmented-labels.csv" \
  -d "id,label\n3,cat-rotated\n4,dog-flipped"
curl -X PUT "http://localhost:9000/exp-augmented/config.json" \
  -d '{"epochs": 20, "augmentation": true}'

# 4. Remove a file that is not needed for this experiment
curl -X DELETE "http://localhost:9000/exp-augmented/legacy-data.bin"

# 5. Check what changed
curl "http://localhost:9000/exp-augmented?fork-diff"
# -> {"added":["augmented-labels.csv"],"modified":["config.json"],"deleted":["legacy-data.bin"]}

# 6. Run training against the fork (your ML code uses exp-augmented as the bucket)
# ... training completes with better results ...

# 7. Merge improvements back to production
curl -X POST "http://localhost:9000/exp-augmented?fork-merge=training-data"
# -> {"merged":2,"deleted":1,"skipped":0}

# 8. Verify the merge
curl "http://localhost:9000/training-data/augmented-labels.csv"
# -> 200 OK (merged from fork)
curl "http://localhost:9000/training-data/config.json"
# -> {"epochs": 20, "augmentation": true} (updated)
```

## Limitations

- **No fork-of-fork**: you cannot fork a bucket that is itself a fork. Create a new fork from the original source instead.
- **Full key enumeration**: diff and merge operations enumerate all keys in both the fork and source buckets. For buckets with millions of keys, these operations may be slow. Pagination support is planned.
- **Sequential merge**: merge copies objects one at a time. Parallel merge execution is planned.
- **No cross-node forks (OSS)**: in the OSS edition, forks and their source must reside on the same node. The enterprise proxy layer supports cross-node fork semantics.
- **No time-travel queries**: while the HLC timestamp is recorded at fork creation, querying the source at that historical point is not yet implemented.

## Fork Metadata Storage

Fork metadata is stored in JSON sidecar files under `.neolith/forks/`:

- `.neolith/forks/<fork_bucket>.json` - fork metadata (source, state, timestamps)
- `.neolith/forks/<fork_bucket>.mask.json` - mask set (keys deleted from the fork's view)

These files are loaded into memory at server startup and cached in the `ForkStore`.
