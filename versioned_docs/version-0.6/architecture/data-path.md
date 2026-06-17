---
sidebar_position: 2
title: Data Path
---

# Data Path

This document describes the complete PUT and GET data flow through Neolith, from HTTP request to disk I/O and back.

## PUT Pipeline

When a client uploads an object, it passes through five stages in sequence. Each stage is optional depending on configuration and object properties.

```
HTTP Body
  |
  v
[1. Receive] --> contiguous buffer or streaming chunks
  |
  v
[2. Smart Skip] --> decide: compress or pass through
  |
  v
[3. Compress] --> LZ4 (default) or zstd
  |
  v
[4. Erasure Code] --> K data shards + M parity shards
  |
  v
[5. Encrypt] --> AES-256-GCM per shard (if SSE enabled)
  |
  v
[6. Write Shards] --> parallel I/O to drives
  |
  v
[7. Write Meta] --> meta.neo FlatBuffer sidecar
  |
  v
[8. Replicate] --> fan-out to N/2+1 nodes (quorum)
  |
  v
HTTP 200 + ETag
```

### Stage 1: Receive

The full object body is received into a contiguous byte buffer. Neolith does not use chunked processing for the PUT pipeline because erasure coding operates on the complete object. The `DefaultBodyLimit` middleware enforces maximum object size.

For multipart uploads, each part is processed independently through the pipeline. Parts are assembled during the CompleteMultipartUpload call, which re-processes the concatenated data through compress, EC, and encrypt stages.

### Stage 2: Smart Skip

Before compression, Neolith analyzes the data to decide whether compression would be beneficial. Compressing already-compressed data wastes CPU and can actually increase size. Three checks are performed in order:

1. **Content-Type blacklist**: Known incompressible MIME types are skipped (e.g., `image/jpeg`, `image/png`, `video/mp4`, `application/gzip`, `application/zip`).
2. **Magic byte detection**: The first few bytes are checked against known compressed format signatures (gzip `1f 8b`, zstd `28 b5 2f fd`, JPEG `ff d8 ff`, PNG `89 50 4e 47`).
3. **Shannon entropy**: A sample of the data is analyzed. If entropy exceeds 7.5 bits/byte (out of a maximum 8.0), the data is effectively random and incompressible.

If any check triggers, compression is skipped and the data passes through unchanged. The `CompressionInfo` in metadata records whether compression was applied and which codec was used.

### Stage 3: Compress

If smart skip did not trigger, the data is compressed:

- **LZ4** (default): ~4.5 GB/s compress, ~14 GB/s decompress. Best for latency-sensitive workloads.
- **zstd** (level 1-3): Higher compression ratio at lower throughput. Best for cold storage or bandwidth-constrained environments.

Compression codec can be configured per-bucket or globally.

### Stage 4: Erasure Code

The (possibly compressed) data is split into K data shards and M parity shards using Reed-Solomon coding over GF(2^8):

```
Input data (possibly compressed)
  |
  [pad to K-aligned boundary]
  |
  [split into K equal data shards]
  |
  [RS encode: compute M parity shards]
  |
  K data shards + M parity shards
```

Default configuration is RS(8,4): 8 data shards + 4 parity shards = 12 total shards. This tolerates up to 4 shard losses. For LRC, additional local parity shards are computed per group.

All erasure coding uses mandatory SIMD instructions (AVX2/NEON/SSSE3) for performance. Neolith refuses to start on CPUs without SIMD support.

### Stage 5: Encrypt

If server-side encryption is enabled (SSE-S3 or SSE-C), each shard is encrypted independently:

- **SSE-S3**: A per-object Data Encryption Key (DEK) is derived via HKDF from the master key. Each shard is encrypted with AES-256-GCM in 64KB AEAD blocks.
- **SSE-C**: The customer-provided key is used directly (no HKDF derivation).

Encrypting after erasure coding (rather than before) means each shard is independently decryptable. This is critical for repair operations - a single corrupt shard can be reconstructed from other shards without needing to decrypt the entire object first.

### Stage 6: Write Shards

Shards are written in parallel to local drives. Each shard is written atomically:

1. Write to a temporary file (`.tmp` suffix)
2. `fsync` the file
3. Rename to the final path

This ensures a crash at any point leaves either the old data or the new data, never a partial write.

### Stage 7: Write Metadata

A FlatBuffer metadata sidecar (`meta.neo`) is written alongside the shards, containing:

- Object key, bucket, size, content type, ETag
- Erasure layout (K, M, shard sizes, BLAKE3 checksums per shard)
- Compression info (codec, original size)
- Encryption info (algorithm, sealed DEK, nonce)
- HLC timestamp
- Custom metadata and tags

### Stage 8: Replicate

For multi-node clusters, the object is replicated to achieve write quorum:

1. Local write completes first
2. Replicate RPC is sent to N/2+1 remote nodes in parallel
3. The RPC body contains `[meta_bytes | data_bytes]` with the `x-neolith-meta-size` header for demarcation
4. HLC timestamp is propagated via the `x-neolith-hlc` header
5. Once quorum is achieved, the client receives HTTP 200
6. If quorum fails, the local write is rolled back

## GET Pipeline

The GET pipeline is the reverse of PUT, with additional steps for integrity verification and read-repair.

```
HTTP GET Request
  |
  v
[1. Locate] --> TCH: key -> partition -> nodes -> drives
  |
  v
[2. Read Meta] --> MetaView (zero-copy) for HEAD; full ObjectMeta for GET
  |
  v
[3. Read Shards] --> parallel read of K shards (of K+M available)
  |
  v
[4. Verify] --> BLAKE3 checksum per shard
  |
  v
[5. EC Decode] --> reconstruct if degraded (< K healthy shards read)
  |
  v
[6. Decrypt] --> AES-256-GCM per shard (if encrypted)
  |
  v
[7. Decompress] --> LZ4/zstd (if compressed)
  |
  v
[8. Read-Repair] --> async: check remote HLC, repair if stale
  |
  v
HTTP 200 + body
```

### Fast Path: HEAD and LIST

For HEAD requests and LIST operations, Neolith uses the MetaView zero-copy fast path. MetaView reads FlatBuffer fields directly from the mapped metadata bytes without deserializing the entire ObjectMeta structure. This is 10-100x faster than full deserialization and is the hot path for listing operations.

The MetaView fast path is used when the object is unencrypted and uncompressed - the common case for metadata-only queries. For encrypted or compressed objects, full ObjectMeta deserialization is used.

### Small Object Optimization

Objects smaller than 128KB are stored inline in the metadata file itself, in the `inline_data` field of ObjectMeta. This avoids the overhead of shard files for small objects:

- No erasure coding overhead (single copy in metadata)
- Single I/O operation instead of K+1 (K shards + 1 metadata)
- Metadata and data are co-located for cache efficiency

### Range Requests

HTTP Range GET requests (e.g., `Range: bytes=1000-1999`) follow the full pipeline:

1. Read all required shards
2. Verify, EC decode, decrypt, decompress the full object
3. Slice the requested byte range from the result
4. Return only the requested bytes with `206 Partial Content`

For compressed and encrypted objects, the full object must be reconstructed before slicing. This is a deliberate trade-off: compression and encryption operate on the whole object, so random access within them requires full reconstruction.

### Read-Repair

After serving the response to the client (without adding latency), Neolith performs read-repair in the background:

1. Check one remote replica's HLC timestamp
2. If the remote version is newer, fetch it and update the local copy
3. If the local version is newer, push it to the remote

This provides eventual convergence of all replicas without a dedicated anti-entropy protocol.

## Buffer Management

Neolith uses contiguous byte buffers (`Vec<u8>` and `Bytes`) throughout the pipeline. Key properties:

- **No copies between stages**: Each stage operates on the same buffer or produces a new one. There are no unnecessary copies.
- **Pre-allocated pools**: The I/O engine maintains buffer pools to reduce allocation pressure.
- **Zero-copy metadata**: MetaView reads fields directly from FlatBuffer bytes without allocation.
- **Streaming response**: GET responses are streamed to the client using Axum's body streaming, not buffered in full.

## Conditional Requests

Neolith supports conditional request headers for cache validation:

| Header | Behavior |
|--------|----------|
| `If-Match` | Return object only if ETag matches; 412 otherwise |
| `If-None-Match` | Return object only if ETag does not match; 304 otherwise |
| `If-Modified-Since` | Return object only if modified after date; 304 otherwise |
| `If-Unmodified-Since` | Return object only if not modified after date; 412 otherwise |

## Copy Object

`PUT /{bucket}/{key}` with `x-amz-copy-source` header triggers a server-side copy:

1. GET pipeline reads the source object (including decrypt + decompress)
2. PUT pipeline writes the destination object (including compress + encrypt)
3. Response includes `CopyObjectResult` XML with the new ETag

This allows re-encryption, re-compression, or moving objects between buckets without client-side data transfer.
