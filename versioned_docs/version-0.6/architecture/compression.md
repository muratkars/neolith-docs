---
sidebar_position: 8
title: Compression
---

# Compression

Neolith compresses data before erasure coding to reduce storage footprint and network bandwidth. Compression is transparent to clients - the S3 API works identically whether compression is enabled or not.

## Supported Codecs

| Codec | Compress Speed | Decompress Speed | Ratio | Use Case |
|-------|---------------|-------------------|-------|----------|
| LZ4 (default) | ~4.5 GB/s | ~14 GB/s | ~2.0x | Latency-sensitive, hot data |
| zstd (level 1) | ~1.5 GB/s | ~4.5 GB/s | ~2.8x | Balanced throughput/ratio |
| zstd (level 3) | ~0.5 GB/s | ~4.5 GB/s | ~3.2x | Cold storage, archive |

LZ4 is the default codec. Its decompression speed (~14 GB/s) exceeds NVMe SSD throughput, meaning decompression is essentially free on modern hardware. The compression speed (~4.5 GB/s) is fast enough that compression overhead is negligible compared to network and disk I/O.

zstd provides significantly better compression ratios at lower throughput. Levels 1-3 are supported. Higher zstd levels (4+) are not offered because the throughput drop is too large for a storage system.

## Pipeline Position

Compression occurs before erasure coding:

```
Raw data -> [Smart Skip] -> [Compress] -> Erasure Code -> Encrypt -> Write
```

This ordering matters:

1. **Before EC**: Compression reduces the data size before splitting into shards. This means fewer bytes per shard, less disk I/O, and less network traffic for replication.
2. **Before encryption**: Encrypted data is incompressible. Compression must happen before encryption.

The `CompressionInfo` in metadata records whether compression was applied, which codec was used, and the original uncompressed size (needed for `Content-Length` in GET responses).

## Smart Skip

Not all data benefits from compression. Attempting to compress already-compressed data (JPEG, MP4, gzip archives) wastes CPU and can even increase the data size. Neolith's smart skip logic avoids this.

Three checks are applied in order. If any check triggers, compression is skipped entirely:

### 1. Content-Type Blacklist

Known incompressible MIME types are skipped immediately:

```
image/jpeg, image/png, image/gif, image/webp
video/mp4, video/webm, video/mpeg
audio/mp3, audio/aac, audio/ogg
application/gzip, application/zip, application/x-bzip2
application/x-xz, application/zstd
application/x-7z-compressed
application/x-rar-compressed
```

This is the cheapest check - just a string comparison on the `Content-Type` header.

### 2. Magic Byte Detection

The first 4-16 bytes of the data are compared against known compressed/encrypted format signatures:

| Bytes | Format |
|-------|--------|
| `1f 8b` | gzip |
| `28 b5 2f fd` | zstd |
| `04 22 4d 18` | LZ4 |
| `ff d8 ff` | JPEG |
| `89 50 4e 47` | PNG |
| `52 49 46 46` | RIFF (WebP, AVI) |
| `50 4b 03 04` | ZIP/DOCX/XLSX |
| `37 7a bc af` | 7z |

This catches cases where the `Content-Type` header is missing or incorrect (e.g., `application/octet-stream` for a JPEG).

### 3. Shannon Entropy

For data that passes the first two checks, a Shannon entropy analysis determines compressibility:

```
H = -sum(p(x) * log2(p(x))) for each byte value x in sample
```

Where `p(x)` is the frequency of byte value `x` in the sample.

- **H < 7.5 bits/byte**: Data is compressible. Proceed with compression.
- **H >= 7.5 bits/byte**: Data is effectively random (encrypted or already compressed). Skip compression.

The maximum possible entropy is 8.0 bits/byte (perfectly uniform random data). A threshold of 7.5 provides a margin of error while catching most incompressible data.

The entropy check is performed on a sample of the data (not the full object) to keep the overhead minimal.

## Per-Bucket Configuration

Compression codec can be configured at the bucket level:

```bash
# Create bucket with zstd compression
aws --endpoint-url http://localhost:9000 s3api put-bucket-configuration \
  --bucket archive-bucket \
  --configuration '{"compression": "zstd"}'

# Create bucket with no compression
aws --endpoint-url http://localhost:9000 s3api put-bucket-configuration \
  --bucket raw-bucket \
  --configuration '{"compression": "none"}'
```

When not specified, the server's default codec (LZ4) is used.

## Metadata

Compression metadata is stored in the `CompressionInfo` struct within `ObjectMeta`:

```rust
pub struct CompressionInfo {
    pub algorithm: CompressionAlgorithm,  // LZ4 or Zstd
    pub original_size: u64,               // uncompressed size
}
```

- `algorithm`: Which codec was used (`LZ4` or `Zstd`)
- `original_size`: The size of the data before compression. This is needed to set the correct `Content-Length` header in GET responses.

If smart skip bypassed compression, `compression_info` is `None` in the metadata, and the stored data is the original uncompressed bytes.

## Decompression on Read

During GET, decompression is the last pipeline stage before streaming the response:

```
Read shards -> Verify -> EC Decode -> Decrypt -> [Decompress] -> HTTP Response
```

The decompress stage checks `ObjectMeta.compression_info`:

- `None`: Data is uncompressed, pass through
- `Some(LZ4)`: Decompress with LZ4
- `Some(Zstd)`: Decompress with zstd

Both LZ4 and zstd decompression produce the exact original bytes. The decompressed size must match `original_size` in the metadata; a mismatch indicates data corruption.

## Batch GET and Compression

For batch GET operations (TAR+LZ4 or TAR+zstd streaming), there are two levels of compression:

1. **Per-object compression**: Individual objects may be compressed (handled in the normal GET pipeline during `ObjectFetcher`)
2. **Batch-level compression**: The assembled TAR stream is compressed with LZ4 or zstd for network transfer

The `ObjectFetcher` in the batch pipeline replicates the full GET pipeline (decrypt + decompress) for each object before adding it to the TAR stream. The batch-level compression then re-compresses the assembled TAR.

## Interaction with ETL

When an object is fetched with an inline ETL transform (`GET ?transform=<name>`), the pipeline is:

```
Read -> Verify -> EC Decode -> Decrypt -> Decompress -> [Transform] -> HTTP Response
```

The transform receives decompressed plaintext data. Transform results are cached in the `TransformCache` with a cache key that includes the transform ID and configuration, so different transforms of the same object are cached independently.
