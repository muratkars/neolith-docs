---
sidebar_position: 7
title: Encryption
---

# Encryption

Neolith provides encryption at rest (SSE-S3, SSE-C) and in transit (TLS 1.3). All cryptographic operations use `aws-lc-rs`, a FIPS 140-3 capable cryptographic library maintained by AWS.

## Encryption Modes

Neolith supports three encryption modes, matching the S3 API:

| Mode | Key Management | Use Case |
|------|---------------|----------|
| None | No encryption | Development, non-sensitive data |
| SSE-S3 | Server-managed master key | Default production encryption |
| SSE-C | Customer-provided key per request | Customer-controlled encryption |

The encryption mode is stored in `ObjectMeta.encryption_info` and auto-detected on read. Objects with different encryption modes can coexist in the same bucket.

## SSE-S3 (Server-Side Encryption with Server-Managed Keys)

SSE-S3 encrypts each object with a unique Data Encryption Key (DEK) derived from a master key. The master key is provided via CLI flag or environment variable.

### Key Hierarchy

```
Master Key (32 bytes, from --master-key or NEOLITH_MASTER_KEY)
    |
    +-- HKDF-SHA256 (salt = object key + bucket)
    |
    v
Per-Object DEK (32 bytes)
    |
    +-- AES-256-GCM encryption
    |
    v
Encrypted shard data
```

Each object gets a unique DEK derived via HKDF-SHA256. The derivation inputs are:

- **IKM** (Input Keying Material): The master key
- **Salt**: Concatenation of bucket name and object key
- **Info**: Empty (not used)

This ensures that even if two objects have identical content, they are encrypted with different keys.

### AES-256-GCM Block Encryption

Each shard is encrypted independently using AES-256-GCM in 64KB blocks:

```
Shard (plaintext)
  |
  [Split into 64KB blocks]
  |
  Block 0: AES-256-GCM(DEK, nonce+0, block_0) -> ciphertext_0 + tag_0
  Block 1: AES-256-GCM(DEK, nonce+1, block_1) -> ciphertext_1 + tag_1
  Block N: AES-256-GCM(DEK, nonce+N, block_N) -> ciphertext_N + tag_N
  |
  [Concatenate: ciphertext_0 || tag_0 || ciphertext_1 || tag_1 || ...]
  |
  Shard (encrypted)
```

Key properties:

- **64KB block size**: Balances authentication granularity with performance overhead. Each block is independently authenticated.
- **Per-block nonce**: Nonce is incremented for each block to ensure uniqueness. The base nonce is randomly generated per object and stored in `EncryptionInfo.nonce`.
- **Authentication tags**: Each block has its own GCM authentication tag. A single-bit flip in any block is detected immediately.

### Metadata Storage

Encryption metadata is stored in the `EncryptionInfo` struct:

```rust
pub struct EncryptionInfo {
    pub algorithm: String,      // "AES256" for SSE-S3
    pub sealed_dek: Vec<u8>,    // HKDF-derived DEK (sealed with master key context)
    pub nonce: Vec<u8>,         // Base nonce for AES-GCM
}
```

The DEK is not stored in plaintext. It is re-derived from the master key + object identity on each read. The `sealed_dek` field stores the HKDF output for verification.

## SSE-C (Server-Side Encryption with Customer-Provided Keys)

SSE-C lets clients provide the encryption key with each request. Neolith never stores the customer key - it is used only for the duration of the request.

### Request Headers

| Header | Description |
|--------|-------------|
| `x-amz-server-side-encryption-customer-algorithm` | Must be `AES256` |
| `x-amz-server-side-encryption-customer-key` | Base64-encoded 256-bit key |
| `x-amz-server-side-encryption-customer-key-MD5` | Base64-encoded MD5 of the key |

### SSE-C vs SSE-S3 Differences

| Property | SSE-S3 | SSE-C |
|----------|--------|-------|
| Key source | Master key (server config) | Client request header |
| Key derivation | HKDF per object | Direct use (no HKDF) |
| Key storage | Never stored (re-derived) | Never stored (client responsibility) |
| Key validation | N/A | MD5 hash comparison |
| Algorithm indicator | `"AES256"` | `"AES256-C"` |

For SSE-C, the `sealed_dek` field in `EncryptionInfo` stores the MD5 hash of the customer key. This allows Neolith to verify that the correct key is provided on read without storing the key itself.

### SSE-C Copy

When copying an SSE-C encrypted object, both source and destination keys must be provided:

| Header | Description |
|--------|-------------|
| `x-amz-copy-source-server-side-encryption-customer-key` | Source object key |
| `x-amz-server-side-encryption-customer-key` | Destination object key |

This allows re-encryption with a different key during copy operations.

## Pipeline Position

Encryption occurs after erasure coding in the PUT pipeline:

```
Raw data -> Compress -> Erasure Code -> Encrypt -> Write
```

This ordering is deliberate:

1. **Compression before encryption**: Encrypted data is incompressible (high entropy). Compression must happen first.
2. **Encryption after EC**: Each shard is encrypted independently. This means repair operations (EC decode of degraded shards) can work on encrypted shards without needing the encryption key. Only the final reassembled data needs decryption.
3. **Independent shard decryption**: A single shard can be decrypted without reading other shards, which is useful for partial reads and streaming.

## TLS 1.3

All network communication uses TLS 1.3 via `rustls`. Neolith does not depend on or use OpenSSL.

### Configuration

```bash
neolith server start /data \
  --tls-cert /path/to/cert.pem \
  --tls-key /path/to/key.pem
```

Key properties:

- **TLS 1.3 only**: TLS 1.2 and earlier are not supported. TLS 1.3 provides forward secrecy by default and has a simpler, more secure handshake.
- **rustls**: Pure-Rust TLS implementation. No OpenSSL dependency, no C code, no CVE exposure from OpenSSL.
- **aws-lc-rs CryptoProvider**: FIPS 140-3 capable cryptographic backend for rustls.
- **tokio-rustls**: Async TLS acceptor for the Axum/hyper server.

### Cipher Suites

With TLS 1.3 and aws-lc-rs, the following cipher suites are available:

- `TLS_AES_256_GCM_SHA384`
- `TLS_AES_128_GCM_SHA256`
- `TLS_CHACHA20_POLY1305_SHA256`

## Mutual TLS (mTLS)

For inter-node communication in a cluster, Neolith supports mutual TLS authentication:

```bash
neolith server start /data \
  --tls-cert /path/to/node-cert.pem \
  --tls-key /path/to/node-key.pem \
  --tls-ca /path/to/ca.pem
```

When `--tls-ca` is configured:

- **Server side**: `WebPkiClientVerifier` requires connecting clients to present a certificate signed by the specified CA.
- **Client side**: `RpcClient::with_tls()` loads the node certificate as a `reqwest::Identity` for client authentication, and the CA certificate as a trusted root.

This ensures that only nodes with certificates signed by the same CA can communicate with each other. External S3 clients can still connect with regular TLS (server-only authentication).

## KMS Roadmap

| Version | Key Management |
|---------|---------------|
| v0.1 | In-memory master key from `--master-key` or `NEOLITH_MASTER_KEY` env |
| v0.2 | HashiCorp Vault integration for master key retrieval and rotation |

The current implementation (v0.1) loads the master key from the CLI flag or environment variable at startup. The key is held in memory for the lifetime of the server process. Key rotation requires a server restart with the new key and a background re-encryption of existing objects.
