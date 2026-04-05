---
sidebar_position: 6
title: "Benchmarks"
---

# Benchmarks

Neolith includes a built-in benchmark tool (`neolith-bench`) for measuring storage performance. This page describes the benchmark suite, the metrics it collects, and how to run and interpret results.

**Note**: Neolith is an early-stage project. The benchmarks below describe the tooling and methodology. Production benchmark results across various hardware configurations are in progress.

## Benchmark Suite

The benchmark crate is located at `crates/neolith-bench/` and provides purpose-built benchmarks for object storage workloads.

### Architecture

The benchmark tool is designed around these principles:

- **HdrHistogram** for latency measurement: Records latencies from 1 microsecond to 60 seconds with 3 significant digits of precision. This captures the full tail latency distribution (p50, p99, p999, p9999) without losing resolution at the extremes.

- **SmallRng** for workload generation: Uses `SmallRng` from the `rand` crate instead of `ThreadRng`. `SmallRng` is `Send`-safe, which is required for use inside `tokio::spawn` tasks where the future must be `Send`.

- **Semaphore-based concurrency**: PUT benchmarks use `tokio::sync::Semaphore` to limit the number of concurrent uploads, preventing the benchmark from overwhelming the server or exhausting client resources.

- **Iterative binary search**: Key discovery for GET benchmarks uses an iterative binary search (not async recursion) to find valid keys in the object namespace.

### Benchmark Types

#### PUT Throughput

Measures write performance by uploading objects of a specified size:

```bash
neolith-bench put \
  --endpoint http://localhost:9000 \
  --bucket bench \
  --objects 10000 \
  --size 1MB \
  --concurrency 64
```

Metrics collected:
- Operations per second (ops/s)
- Throughput in MB/s
- Latency histogram (p50, p99, p999)

#### GET Throughput

Measures read performance by downloading previously uploaded objects:

```bash
neolith-bench get \
  --endpoint http://localhost:9000 \
  --bucket bench \
  --objects 10000 \
  --concurrency 64
```

Metrics collected:
- Operations per second (ops/s)
- Throughput in MB/s
- Latency histogram (p50, p99, p999)

#### Mixed Workload

Measures combined read/write performance with a configurable read/write ratio:

```bash
neolith-bench mixed \
  --endpoint http://localhost:9000 \
  --bucket bench \
  --objects 10000 \
  --size 1MB \
  --concurrency 64 \
  --read-ratio 0.8
```

#### Erasure Coding

Measures EC encode/decode performance independently of the network layer:

```bash
neolith-bench ec \
  --data-shards 8 \
  --parity-shards 4 \
  --block-size 1MB \
  --iterations 10000
```

#### Compression

Measures compression throughput for different codecs and data types:

```bash
neolith-bench compress \
  --codec lz4 \
  --size 1MB \
  --iterations 10000
```

## Metrics

### Latency Histogram

The HdrHistogram captures the full latency distribution with configurable precision:

```
Latency Distribution:
  p50:    0.342ms
  p90:    0.891ms
  p95:    1.234ms
  p99:    3.456ms
  p999:   12.345ms
  p9999:  45.678ms
  max:    89.012ms
  mean:   0.567ms
  stddev: 1.234ms
```

The histogram range (1us to 60s) covers everything from in-memory cache hits to worst-case disk I/O with GC pauses.

### Throughput

```
Throughput:
  ops/s:    15,234
  MB/s:     14,876.95
  duration: 60.00s
  objects:  914,040
```

### Per-Operation Breakdown

For detailed analysis, the benchmark can log per-operation latencies:

```
Operation Log:
  PUT obj-00001: 0.342ms (1048576 bytes)
  PUT obj-00002: 0.298ms (1048576 bytes)
  GET obj-00001: 0.156ms (1048576 bytes)
  ...
```

## Running Benchmarks

### Prerequisites

1. A running Neolith server
2. A pre-created benchmark bucket

```bash
# Start the server
neolith server start /mnt/bench{1...4}

# Create benchmark bucket
aws --endpoint-url http://localhost:9000 s3 mb s3://bench
```

### Benchmark Workflow

```bash
# 1. PUT benchmark: upload objects
neolith-bench put \
  --endpoint http://localhost:9000 \
  --bucket bench \
  --objects 100000 \
  --size 1MB \
  --concurrency 128

# 2. GET benchmark: read back the objects
neolith-bench get \
  --endpoint http://localhost:9000 \
  --bucket bench \
  --objects 100000 \
  --concurrency 128

# 3. EC benchmark: measure encode/decode
neolith-bench ec \
  --data-shards 8 \
  --parity-shards 4 \
  --block-size 1MB \
  --iterations 50000

# 4. Compression benchmark
neolith-bench compress \
  --codec lz4 \
  --size 1MB \
  --iterations 50000
```

## Comparison Methodology

When comparing Neolith against other object storage systems (MinIO, Ceph, etc.), follow these guidelines for fair comparisons:

### Hardware Normalization

- Use the **same hardware** for all systems being compared
- Document: CPU model, core count, RAM, drive model/count, network (10G/25G/100G)
- Use the same drive configuration (number of drives, RAID vs JBOD)
- Disable OS-level caching (`echo 3 > /proc/sys/vm/drop_caches`) between runs

### Workload Consistency

- Same object sizes, same number of objects
- Same concurrency level
- Same client machine (to eliminate client-side variability)
- Warm up the system before measuring (discard first 10% of operations)

### What to Measure

| Metric | Why It Matters |
|---|---|
| Throughput (MB/s) | Raw bandwidth - how fast can data move |
| IOPS (ops/s) | Operation rate - critical for small objects |
| p50 latency | Typical request latency |
| p99 latency | Tail latency - affects training stalls |
| p999 latency | Worst-case latency - GC, compaction, etc. |
| CPU utilization | Efficiency - how much CPU per MB/s |
| Memory usage | Resource consumption at steady state |

### Common Pitfalls

- **Client bottleneck**: Ensure the client machine can generate enough load. Use multiple client processes if needed.
- **Network saturation**: Monitor network utilization. If the link is saturated, you are measuring network speed, not storage speed.
- **OS caching**: For read benchmarks, the dataset should be larger than RAM to avoid measuring the page cache.
- **Warm-up effects**: JIT compilation, cache population, and connection pooling affect early results. Discard or measure them separately.
- **Clock skew**: Use monotonic clocks (`Instant::now()` in Rust) for latency measurement, not wall clock time.

## Object Size Profiles

Different workloads have different object size distributions. Use these profiles for representative benchmarks:

| Profile | Sizes | Typical Workload |
|---|---|---|
| ML Training | 50KB - 500KB | Image classification datasets (ImageNet, COCO) |
| ML Inference | 1KB - 10KB | Feature vectors, embeddings |
| ML Checkpoints | 100MB - 100GB | Model weights (ResNet to LLMs) |
| Data Lake | 1MB - 1GB | Parquet files, CSV exports |
| Log Analytics | 10KB - 100KB | JSON log entries, metrics |

## Batch API Benchmarks

In addition to standard S3 benchmarks, measure Neolith-specific batch API performance:

```bash
# Measure batch GET throughput
# This compares per-object GET vs batch GET for the same dataset

# Per-object GET (baseline)
neolith-bench get \
  --endpoint http://localhost:9000 \
  --bucket imagenet-bench \
  --objects 100000 \
  --concurrency 128

# Batch GET (Neolith-specific)
neolith-bench batch-get \
  --endpoint http://localhost:9000 \
  --bucket imagenet-bench \
  --batch-size 256 \
  --format tar+lz4 \
  --concurrency 16
```

Key metrics for batch benchmarks:
- **Effective IOPS**: Total objects delivered per second (not HTTP requests)
- **Amortized latency**: Per-object latency (batch latency / batch size)
- **Compression ratio**: TAR+LZ4 size vs sum of raw object sizes
- **Server CPU per object**: How much server CPU is consumed per object in batch mode vs per-object mode

## Interpreting Results

### Good Performance Indicators

- Linear throughput scaling with concurrency (up to hardware limits)
- Tight p99/p50 ratio (< 10x indicates consistent performance)
- CPU utilization below 80% at peak throughput (headroom for bursts)
- Memory usage stable over time (no leaks or unbounded growth)

### Warning Signs

- p99 >> p50 (> 100x): Indicates contention, GC pauses, or disk queueing
- Throughput drops at high concurrency: Lock contention or connection exhaustion
- Memory growth over time: Possible leak in connection pooling or caching
- Inconsistent results across runs: Thermal throttling, background processes, or fragmented storage
