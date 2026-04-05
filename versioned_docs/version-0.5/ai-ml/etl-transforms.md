---
sidebar_position: 4
title: "ETL Transforms"
---

# ETL Transforms

Neolith includes a server-side ETL (Extract-Transform-Load) engine that applies data transformations at the storage layer. This moves computation to where the data lives, reducing network transfer and client CPU usage. Transforms can be applied inline (during GET requests) or as part of batch operations.

## Transform Runtimes

The ETL engine supports three runtime environments:

### Native

Built-in Rust functions compiled into the Neolith binary. These are the fastest option but limited to the transforms shipped with Neolith.

**Built-in transforms:**

| Name | Description | Input | Output |
|---|---|---|---|
| `identity` | Pass-through (no transformation) | Any | Same as input |
| `checksum-blake3` | Compute BLAKE3 hash of content | Any | 64-char hex hash string |
| `to-json-meta` | Extract object metadata as JSON | Any | JSON with key, size, content-type, etc. |

### WASM (WebAssembly)

Sandboxed WebAssembly modules executed via [Wasmtime](https://wasmtime.dev/). WASM transforms are safe (sandboxed, no filesystem/network access), portable (any language that compiles to WASM), and fast (near-native speed via JIT compilation).

**Requirements:**
- The `etl-wasm` Cargo feature must be enabled at compile time
- WASM modules must export: `alloc(size) -> ptr`, `dealloc(ptr, size)`, `transform(ptr, size) -> ptr`
- Input/output uses a simple ABI: the transform function receives a pointer and size, returns a pointer to the output (first 4 bytes = output length)

**WASM Sandbox:**
- Wasmtime `Engine` and `Module` are cached per registered transform (compile once, run many times)
- Each invocation gets a fresh `Store` for isolation
- Memory is managed via the module's `alloc`/`dealloc` exports
- No WASI capabilities are granted (no filesystem, no network, no clock)

### Container

Docker/OCI containers for transforms that require full system libraries (e.g., TensorFlow, OpenCV, FFmpeg). Container transforms have the highest overhead but maximum flexibility.

## Managing Transforms

### Register a Transform

```bash
# Register a native transform (built-in)
curl -X PUT "http://localhost:9000/etl/v1/transforms/my-checksum" \
  -H "Content-Type: application/json" \
  -d '{
    "runtime": "native",
    "function": "checksum-blake3"
  }'

# Register a WASM transform
# The module is base64-encoded in the request body
curl -X PUT "http://localhost:9000/etl/v1/transforms/resize-224" \
  -H "Content-Type: application/json" \
  -d '{
    "runtime": "wasm",
    "module_base64": "<base64-encoded .wasm file>",
    "config": {"width": 224, "height": 224}
  }'

# Register a container transform
curl -X PUT "http://localhost:9000/etl/v1/transforms/ocr-extract" \
  -H "Content-Type: application/json" \
  -d '{
    "runtime": "container",
    "image": "ghcr.io/my-org/ocr-transform:v1",
    "config": {"language": "en"}
  }'
```

### Get Transform Info

```bash
curl "http://localhost:9000/etl/v1/transforms/resize-224"
```

```json
{
  "name": "resize-224",
  "runtime": "wasm",
  "config": {"width": 224, "height": 224},
  "created_at": "2026-03-15T10:30:00Z"
}
```

### List All Transforms

```bash
curl "http://localhost:9000/etl/v1/transforms"
```

```json
{
  "transforms": [
    {"name": "identity", "runtime": "native"},
    {"name": "checksum-blake3", "runtime": "native"},
    {"name": "to-json-meta", "runtime": "native"},
    {"name": "resize-224", "runtime": "wasm"}
  ]
}
```

### Delete a Transform

```bash
curl -X DELETE "http://localhost:9000/etl/v1/transforms/resize-224"
```

## Applying Transforms

### Inline Transform (GET)

Apply a transform during a standard GET request:

```bash
curl "http://localhost:9000/my-bucket/image.jpg?transform=resize-224" \
  -o resized.jpg
```

The response includes a cache status header:

```
x-neolith-transform-cache: hit    # Served from cache
x-neolith-transform-cache: miss   # Computed and cached
```

### Batch + Transform

Apply transforms during batch GET or epoch streaming:

```bash
# Batch GET with transform
curl -X POST "http://localhost:9000/imagenet?batch-get" \
  -H "Content-Type: application/json" \
  -d '{
    "keys": ["train/n01440764/img001.JPEG", "train/n01440764/img002.JPEG"],
    "format": "tar+lz4",
    "transform": "resize-224"
  }'

# Epoch with transform
curl -X POST "http://localhost:9000/imagenet?batch-epoch" \
  -H "Content-Type: application/json" \
  -d '{
    "prefix": "train/",
    "seed": 42,
    "batch_size": 256,
    "format": "tar+lz4",
    "transform": "resize-224"
  }'
```

In the batch pipeline, the transform is applied per-object:
1. Fetch object data (decrypt + decompress)
2. Apply transform
3. Add transformed result to TAR archive

The `neolith-etl` crate does NOT depend on `neolith-batch` - there is no circular dependency. Instead, the batch assembler calls the ETL state's `apply_transform` method for each object.

## Transform Cache

Transform results are cached to avoid redundant recomputation across requests, epochs, and restarts.

### Cache Key

The cache key is computed as:

```
BLAKE3( BLAKE3(data) || transform_id || serde_json(config) )
```

This ensures that:
- Different input data produces different cache keys
- The same data with different transforms produces different cache keys
- The same data with the same transform but different configs produces different cache keys

### Cache Storage

- **Location**: `<data_dir>/.neolith/etl-cache/`
- **Format**: LZ4-compressed files, named by hex-encoded BLAKE3 cache key
- **Eviction**: LRU (Least Recently Used) based on file access time
- **Persistence**: Cache survives server restarts (disk-backed)
- **Atomicity**: Results are written to temporary files and renamed atomically (`temp + rename`)

### Cache Flow

```
apply_transform(data, transform_id, config)
  |
  +-> Compute cache key = BLAKE3(BLAKE3(data) || id || json(config))
  |
  +-> Look up cache key in index
  |     |
  |     +-> HIT: Read LZ4 file, decompress, return
  |     |
  |     +-> MISS: Execute transform
  |               |
  |               +-> Write result to temp file
  |               +-> LZ4 compress
  |               +-> Rename to cache key
  |               +-> Update LRU index
  |               +-> Return result
```

### Cache Eviction

A background task runs at a configurable interval (default from `EtlConfig::eviction_interval`) and:
1. Lists all files in the cache directory
2. Sorts by last access time
3. Removes oldest files until total size is under the budget

### Cache Rebuild

On server startup, `rebuild_cache_index()` scans the cache directory and populates the in-memory index. This allows the cache to be effective immediately after restart without a cold-start penalty.

## Writing a WASM Transform

### Rust Example

```rust
// lib.rs - compile with: cargo build --target wasm32-unknown-unknown --release

#[no_mangle]
pub extern "C" fn alloc(size: usize) -> *mut u8 {
    let layout = std::alloc::Layout::from_size_align(size, 1).unwrap();
    unsafe { std::alloc::alloc(layout) }
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, size: usize) {
    let layout = std::alloc::Layout::from_size_align(size, 1).unwrap();
    unsafe { std::alloc::dealloc(ptr, layout) }
}

#[no_mangle]
pub extern "C" fn transform(ptr: *const u8, size: usize) -> *mut u8 {
    // Read input
    let input = unsafe { std::slice::from_raw_parts(ptr, size) };

    // Process (example: uppercase ASCII)
    let output: Vec<u8> = input.iter().map(|b| b.to_ascii_uppercase()).collect();

    // Write output: 4-byte LE length prefix + data
    let out_len = output.len();
    let total = 4 + out_len;
    let out_ptr = alloc(total);
    unsafe {
        // Write length prefix
        std::ptr::copy_nonoverlapping(
            (out_len as u32).to_le_bytes().as_ptr(),
            out_ptr,
            4,
        );
        // Write data
        std::ptr::copy_nonoverlapping(
            output.as_ptr(),
            out_ptr.add(4),
            out_len,
        );
    }
    out_ptr
}
```

### ABI Contract

| Export | Signature | Description |
|---|---|---|
| `alloc` | `(size: i32) -> i32` | Allocate `size` bytes, return pointer |
| `dealloc` | `(ptr: i32, size: i32)` | Free previously allocated memory |
| `transform` | `(ptr: i32, size: i32) -> i32` | Transform input, return pointer to output |

The output pointer must point to a buffer where:
- Bytes 0-3: `u32` little-endian output length
- Bytes 4+: Output data

### Registering the WASM Module

The WASM binary is uploaded as base64-encoded data (no external crate needed - Neolith uses a manual base64 decoder):

```bash
# Compile
cargo build --target wasm32-unknown-unknown --release

# Base64 encode and register
MODULE=$(base64 < target/wasm32-unknown-unknown/release/my_transform.wasm)

curl -X PUT "http://localhost:9000/etl/v1/transforms/uppercase" \
  -H "Content-Type: application/json" \
  -d "{\"runtime\": \"wasm\", \"module_base64\": \"$MODULE\"}"
```

## Transform Registry

Transforms are stored in a `TransformRegistry` protected by `RwLock<HashMap<String, Arc<RegisteredTransform>>>`. The registry has a configurable `max_transforms` limit to prevent unbounded memory growth from registered WASM modules.

Each `RegisteredTransform` contains:
- Transform name and runtime type
- For native: function pointer
- For WASM: cached `Module` (compiled once)
- For container: image reference and config
- Registration timestamp

## Configuration

The ETL engine is configured through `EtlConfig`:

```rust
let config = EtlConfig::builder()
    .cache_dir(data_dir.join(".neolith/etl-cache"))
    // Additional config fields set via builder pattern
```

The cache directory is created automatically at startup if it does not exist.
