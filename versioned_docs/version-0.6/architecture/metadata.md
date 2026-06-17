---
sidebar_position: 3
title: Metadata
---

# Metadata

Neolith stores metadata as per-object FlatBuffer sidecar files rather than using an embedded database. This section covers the metadata format, zero-copy access patterns, and the migration strategy from the legacy bincode format.

## Design Rationale

Most object storage systems use an embedded key-value database (RocksDB, bbolt, SQLite) for metadata. Neolith takes a different approach:

| Concern | Embedded DB | Neolith (sidecar files) |
|---------|-------------|------------------------|
| Compaction | Background compaction pauses, write amplification | No compaction needed |
| Crash recovery | WAL replay, potential corruption | Atomic rename - always consistent |
| Backup | Database-specific export tools | Standard filesystem tools (cp, rsync) |
| Inspection | Requires database tooling | Direct file inspection |
| Scalability | Single DB hotspot per drive | Files distributed across directories |
| Zero-copy | Requires deserialization from DB format | FlatBuffer direct field access |

Each object has a corresponding `.neo` metadata file stored alongside its data shards. The metadata file is written atomically (write to `.tmp`, fsync, rename) so it is never partially written.

## File Format

Every metadata file begins with a fixed header:

```
Offset  Size  Field
0       4     Magic bytes: "NEOM" (0x4E 0x45 0x4F 0x4D)
4       1     Format version: 1 (bincode) or 2 (FlatBuffer)
5       var   Payload (format-dependent)
```

### FORMAT_VERSION_V1 (Legacy Bincode)

The original format used in Phases 1-10. Metadata is serialized with bincode v1:

- Compact binary encoding, no schema evolution
- Requires full deserialization to access any field
- Still readable via `ObjectMeta::from_bytes()` backward compatibility

### FORMAT_VERSION_V2 (FlatBuffers)

The current format, introduced in Phase 11. Metadata is serialized as a FlatBuffer:

- Schema-driven, forward and backward compatible
- Zero-copy field access via `MetaView`
- Generated Rust code checked into git (no `flatc` required at build time)

Format version is auto-detected by reading byte 4. Both versions can coexist in the same deployment.

## ObjectMeta Structure

The `ObjectMeta` struct contains all metadata for a single object version:

```rust
pub struct ObjectMeta {
    // Identity
    pub key: String,
    pub bucket: String,
    pub version_id: Option<String>,

    // Object properties
    pub size: u64,                              // original uncompressed size
    pub content_type: Option<String>,
    pub etag: String,                           // BLAKE3 truncated to 128 bits
    pub user_metadata: HashMap<String, String>,

    // Erasure layout
    pub erasure_layout: ErasureLayout,          // K, M, shard sizes, checksums

    // Optional pipeline stages
    pub compression_info: Option<CompressionInfo>,
    pub encryption_info: Option<EncryptionInfo>,

    // Timestamps
    pub created_at: u64,                        // Unix timestamp
    pub hlc_timestamp: Option<u64>,             // HLC: 48-bit physical + 16-bit logical

    // Small object optimization
    pub inline_data: Option<Vec<u8>>,           // objects < 128KB stored inline

    // Versioning
    pub is_delete_marker: bool,
}
```

### ErasureLayout

```rust
pub struct ErasureLayout {
    pub data_shards: u32,                       // K
    pub parity_shards: u32,                     // M
    pub shard_size: u64,                        // size of each shard in bytes
    pub checksums: Vec<[u8; 32]>,               // BLAKE3 per shard
    pub local_parity_shards: u32,               // LRC local parity (0 for standard RS)
    pub group_size: u32,                        // LRC group size (0 for standard RS)
}
```

### CompressionInfo

```rust
pub struct CompressionInfo {
    pub algorithm: CompressionAlgorithm,        // LZ4 or Zstd
    pub original_size: u64,                     // size before compression
}
```

### EncryptionInfo

```rust
pub struct EncryptionInfo {
    pub algorithm: String,                      // "AES256" (SSE-S3) or "AES256-C" (SSE-C)
    pub sealed_dek: Vec<u8>,                    // HKDF-derived DEK (SSE-S3) or key MD5 (SSE-C)
    pub nonce: Vec<u8>,                         // AES-GCM nonce
}
```

## MetaView: Zero-Copy Access

`MetaView<'a>` provides zero-copy field access to FlatBuffer metadata. It borrows the raw metadata bytes and reads fields directly from the buffer without allocating or copying:

```rust
pub struct MetaView<'a> {
    buf: &'a [u8],
    // Internal FlatBuffer table references
}

impl<'a> MetaView<'a> {
    pub fn key(&self) -> &str;
    pub fn size(&self) -> u64;
    pub fn etag(&self) -> &str;
    pub fn content_type(&self) -> Option<&str>;
    pub fn created_at(&self) -> u64;
    pub fn hlc_timestamp(&self) -> Option<u64>;
    pub fn is_compressed(&self) -> bool;
    pub fn is_encrypted(&self) -> bool;
}
```

### Performance

MetaView is the hot path for LIST and HEAD operations. Benchmark results show it is 10-100x faster than full `ObjectMeta` deserialization:

| Operation | Full Deser | MetaView | Speedup |
|-----------|-----------|----------|---------|
| Read key + size | ~850 ns | ~12 ns | ~70x |
| Read all LIST fields | ~1200 ns | ~45 ns | ~27x |
| HEAD response fields | ~950 ns | ~30 ns | ~32x |

MetaView is used when the object is unencrypted and uncompressed. For objects with encryption or compression, the GET pipeline needs the full `ObjectMeta` to access `EncryptionInfo` and `CompressionInfo`, so full deserialization is performed.

### Usage in LIST

The `list_keys` function in `store.rs` uses MetaView as the primary path:

1. Read the metadata file bytes
2. Check format version (byte 4)
3. If V2: construct `MetaView`, extract fields directly (zero-copy)
4. If V1: fall back to full `ObjectMeta::from_bytes()` deserialization

This means V2 metadata files are listed significantly faster than V1 files, providing a natural incentive for the lazy migration.

## Listing Cache

For large buckets with millions of objects, Neolith uses a listing cache backed by DashMap (concurrent hash map) with bloom filters for prefix filtering:

- **DashMap**: Lock-free concurrent reads, sharded for write scalability
- **Bloom filters**: Fast negative lookups for prefix-based LIST queries
- **Disk persistence**: Cache state is persisted to disk and restored on restart
- **Lazy rebuild**: Cache is populated on first LIST, then kept warm by PUT/DELETE operations

The listing cache stores only the fields needed for LIST responses (key, size, ETag, last modified), not the full ObjectMeta. This keeps memory usage bounded.

## FlatBuffer Schema

The FlatBuffer schema (`meta.fbs`) defines the wire format:

```flatbuffers
namespace neolith.meta;

table ObjectMetaFbs {
    key: string;
    bucket: string;
    version_id: string;
    size: uint64;
    content_type: string;
    etag: string;
    created_at: uint64;
    hlc_timestamp: uint64 = 0;
    is_delete_marker: bool = false;

    // Erasure layout
    data_shards: uint32;
    parity_shards: uint32;
    shard_size: uint64;
    checksums: [Checksum];
    local_parity_shards: uint32 = 0;
    group_size: uint32 = 0;

    // Compression
    compression_algorithm: ubyte = 0;  // 0=None, 1=LZ4, 2=Zstd
    original_size: uint64 = 0;

    // Encryption
    encryption_algorithm: string;
    sealed_dek: [ubyte];
    nonce: [ubyte];

    // Inline data
    inline_data: [ubyte];

    // User metadata
    user_metadata: [KeyValue];
}

table Checksum {
    hash: [ubyte];  // 32-byte BLAKE3
}

table KeyValue {
    key: string;
    value: string;
}

root_type ObjectMetaFbs;
```

The generated Rust code is checked into the repository. There is no `build.rs` or `flatc` dependency at build time, which means the crate builds without any system dependencies.

## Lazy V1-to-V2 Migration

Neolith supports a gradual migration from V1 (bincode) to V2 (FlatBuffer) metadata:

- **No big-bang migration**: Both formats coexist. Reads auto-detect the format.
- **Lazy upgrade**: The `BackgroundScanner` rewrites V1 metadata to V2 during its regular 30-day scan cycle.
- **Write path**: All new writes use V2. Only existing V1 files need migration.
- **Backward compatibility**: `ObjectMetaV1` in `legacy.rs` handles deserialization of the old format.

The migration is transparent to clients. The only observable difference is that V2 metadata is faster for LIST and HEAD operations.
