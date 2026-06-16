---
sidebar_position: 4
title: Erasure Coding
---

# Erasure Coding

Neolith uses erasure coding to provide data durability without the storage overhead of full replication. Data is split into K data shards and M parity shards using Reed-Solomon (RS) coding or Locally Repairable Codes (LRC). Any K of the K+M shards are sufficient to reconstruct the original data.

## Reed-Solomon Coding

Reed-Solomon coding operates over a Galois Field (GF). Neolith supports both `GF(2^8)` and `GF(2^16)`:

- `GF(2^8)`: Maximum 255 total shards (K+M ≤ 255). Used for most configurations.
- `GF(2^16)`: Maximum 65535 total shards. Available for specialized use cases.

### Default Configuration

The default erasure coding scheme is **RS(8,4)**: 8 data shards + 4 parity shards.

| Property | Value |
|----------|-------|
| Data shards (K) | 8 |
| Parity shards (M) | 4 |
| Total shards | 12 |
| Storage overhead | 1.5x (50% overhead) |
| Fault tolerance | Up to 4 shard losses |
| Space efficiency | 66.7% (vs 33.3% for 3x replication) |

For comparison, 3-way replication stores 3 full copies at 3x overhead (300% storage). RS(8,4) achieves higher fault tolerance (4 vs 1) at half the overhead (1.5x vs 3x).

### Configurable Ratios

Erasure coding parameters can be configured per-bucket:

| Scheme | Overhead | Tolerance | Use Case |
|--------|----------|-----------|----------|
| RS(4,2) | 1.5x | 2 shards | Small clusters (6 drives) |
| RS(8,4) | 1.5x | 4 shards | General purpose (default) |
| RS(10,4) | 1.4x | 4 shards | Large clusters, balanced |
| RS(14,4) | 1.29x | 4 shards | High capacity, space-optimized |
| RS(16,4) | 1.25x | 4 shards | Maximum space efficiency |

### Encoding Process

1. **Pad**: Input data is padded to a multiple of K bytes
2. **Split**: Padded data is divided into K equal-sized data shards
3. **Encode**: The RS encoder computes M parity shards from the K data shards using matrix multiplication over GF(2^8)
4. **Checksum**: Each shard (data + parity) gets a BLAKE3 checksum stored in the metadata

### Decoding Process

1. **Read**: Attempt to read all K+M shards in parallel
2. **Verify**: Check BLAKE3 checksum for each shard
3. **Classify**: Identify healthy, corrupt, and missing shards
4. **Reconstruct**: If fewer than K healthy shards, reconstruction fails (data loss). If K or more healthy shards are available, RS decode reconstructs the missing/corrupt shards
5. **Assemble**: K data shards are concatenated and unpadded to produce the original data

## Locally Repairable Codes (LRC)

Standard Reed-Solomon requires reading K shards to repair even a single shard failure. For large K values, this means significant network I/O. LRC reduces repair cost by adding local parity shards that cover smaller groups of data shards.

### How LRC Works

LRC augments global RS parity with per-group local parity:

```
Data shards:   [D0 D1 D2 D3 D4] [D5 D6 D7 D8 D9]
                   Group 1            Group 2

Global parity: [P0 P1 P2 P3]      (covers all 10 data shards)
Local parity:  [L0]               [L1]
               (covers Group 1)    (covers Group 2)
```

For a single shard failure in Group 1, only the 5 shards in that group + L0 are needed for repair - not all 10 data shards + 4 global parity shards.

### LRC Standard Ratios

Neolith provides two pre-configured LRC schemes:

| Scheme | Data | Global Parity | Local Parity | Group Size | Repair I/O Reduction |
|--------|------|---------------|--------------|------------|---------------------|
| LRC(10,4,2,5) | 10 | 4 | 2 | 5 | ~75% less |
| LRC(12,3,3,4) | 12 | 3 | 3 | 4 | ~75% less |

The LRC(10,4,2,5) scheme means: 10 data shards, 4 global parity shards, 2 local parity shards (one per group of 5 data shards).

### LRC Encoding

The `LrcCodec` wraps two RS codec instances:

1. **Global RS codec**: `RsCodec(K, M)` encodes all data shards to produce global parity
2. **Per-group RS codec**: `RsCodec(group_size, 1)` encodes each group to produce one local parity shard

### LRC Repair Strategy

The heal engine uses a tiered repair strategy:

1. **Try LRC local repair** (`try_lrc_local_repair()`): For single-shard failures, attempt to repair using only the local group + local parity. This reads `group_size` shards instead of K shards.
2. **Fall back to global RS**: If local repair fails (multiple failures in same group, or local parity also lost), perform standard RS decode using K of the remaining healthy shards.

This reduces repair network I/O by approximately 75% for the common case of single-shard failures.

### Metadata Extension

LRC parameters are stored in the `ErasureLayout` metadata:

```rust
pub struct ErasureLayout {
    pub data_shards: u32,          // K
    pub parity_shards: u32,        // M (global parity)
    pub local_parity_shards: u32,  // LRC local parity count (0 for standard RS)
    pub group_size: u32,           // LRC group size (0 for standard RS)
    // ...
}
```

The FlatBuffer schema uses `default 0` for `local_parity_shards` and `group_size`, maintaining backward compatibility with existing RS-only metadata.

## Mandatory SIMD

Neolith requires SIMD instruction support and refuses to start without it. This is a deliberate design choice: scalar Galois Field multiplication is too slow for production storage workloads.

### Supported Instruction Sets

| Architecture | Instruction Set | Throughput |
|-------------|----------------|------------|
| x86_64 | AVX-512 | 12+ GB/s/core |
| x86_64 | AVX2 | 8+ GB/s/core |
| x86_64 | SSSE3 | 4+ GB/s/core |
| aarch64 | NEON | 6+ GB/s/core |

### SIMD Implementation

The GF(2^8) multiplication uses SIMD lookup tables. For AVX2, each multiply operation processes 32 bytes in parallel:

1. Split the input byte into high and low nibbles
2. Use `vpshufb` (SIMD byte shuffle) to look up partial products in pre-computed tables
3. XOR the partial products to get the final result

This technique (sometimes called "split table" or "PSHUFB multiply") converts a complex field multiplication into two table lookups and a XOR, all operating on 32 bytes at once.

### Startup Check

At server startup, Neolith probes CPU features:

```
[INFO] SIMD: AVX2 detected
[INFO] Erasure coding: RS(8,4), 12 total shards
```

If no supported SIMD instruction set is found:

```
Error: No supported SIMD instruction set detected.
Neolith requires AVX2, SSSE3 (x86_64) or NEON (aarch64).
```

## Per-Shard Checksums

Every shard (data and parity) gets an independent BLAKE3 checksum stored in the `ErasureLayout.checksums` array. Checksums serve two purposes:

1. **Integrity verification**: On read, each shard's checksum is verified. Corrupt shards are identified and excluded from EC decode.
2. **Repair targeting**: The heal engine compares stored checksums against computed checksums to identify which specific shards need repair.

BLAKE3 is used rather than CRC32 or xxHash because it provides cryptographic integrity with similar performance to non-cryptographic hashes on modern CPUs with AES-NI.

## ETag Computation

The S3 ETag for a single-part upload is the BLAKE3 hash of the original (uncompressed, unencrypted) object data, truncated to 128 bits and hex-encoded. This is not MD5 (as in AWS S3) but is format-compatible with the S3 ETag convention.

For multipart uploads, the ETag follows the S3 convention: `BLAKE3(concat(part_etags))-N`, where N is the number of parts.
