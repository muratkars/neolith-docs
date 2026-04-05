---
sidebar_position: 4
title: "TLS & mTLS"
---

# TLS & mTLS

Neolith uses [rustls](https://github.com/rustls/rustls) for TLS, supporting only TLS 1.3 with the [aws-lc-rs](https://github.com/aws/aws-lc-rs) cryptography provider. This provides modern, memory-safe TLS with FIPS-capable cryptographic primitives.

## Server TLS

### Configuration

Enable TLS by adding a `[tls]` section to the config file:

```toml
[tls]
cert_file = "/etc/neolith/tls/server.pem"
key_file = "/etc/neolith/tls/server-key.pem"
```

Then start the server:

```bash
neolith server start --config /etc/neolith/config.toml /mnt/disk{1...4}
```

The server log confirms TLS is active:

```
INFO neolith server ready listen=0.0.0.0:9000 edition="Neolith OSS" tls=true
```

### Certificate Requirements

- **Format**: PEM-encoded X.509 certificates and PKCS#8 private keys
- **Chain**: The cert file should contain the full chain (server cert + intermediates)
- **Key types**: RSA (2048+), ECDSA (P-256, P-384), Ed25519
- **TLS version**: Only TLS 1.3 is supported (TLS 1.2 and below are rejected)

### Generating Self-Signed Certificates (Development)

```bash
# Generate CA
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout ca-key.pem -out ca.pem -days 3650 -nodes \
  -subj "/CN=Neolith CA"

# Generate server certificate
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout server-key.pem -out server.csr -nodes \
  -subj "/CN=neolith-server" \
  -addext "subjectAltName=DNS:localhost,DNS:*.neolith.local,IP:127.0.0.1"

openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem \
  -CAcreateserial -out server.pem -days 365 \
  -copy_extensions copy

# Verify
openssl verify -CAfile ca.pem server.pem
```

### Production Certificates

For production, use certificates from a trusted CA or an internal PKI:

```bash
# Let's Encrypt (certbot)
certbot certonly --standalone -d neolith.example.com

# Copy to Neolith config directory
cp /etc/letsencrypt/live/neolith.example.com/fullchain.pem /etc/neolith/tls/server.pem
cp /etc/letsencrypt/live/neolith.example.com/privkey.pem /etc/neolith/tls/server-key.pem
```

## Mutual TLS (mTLS)

mTLS adds client certificate verification, ensuring that only clients with certificates signed by a trusted CA can connect. This is primarily used for inter-node communication in a cluster.

### Configuration

```toml
[tls]
# Server certificate and key
cert_file = "/etc/neolith/tls/server.pem"
key_file = "/etc/neolith/tls/server-key.pem"

# CA certificate for client verification (enables mTLS)
ca_file = "/etc/neolith/tls/ca.pem"

# Client certificate for this node's outgoing connections
client_cert_file = "/etc/neolith/tls/client.pem"
client_key_file = "/etc/neolith/tls/client-key.pem"
```

### How mTLS Works

When `ca_file` is configured:

1. The server constructs a `WebPkiClientVerifier` from the CA certificate
2. All incoming TLS connections must present a client certificate
3. The client certificate must be signed by the specified CA
4. Connections without a valid client certificate are rejected at the TLS handshake level

### Inter-Node mTLS

In a cluster, nodes communicate via HTTP/2 RPC on the `/_neolith/v1/` path prefix. When TLS is enabled, inter-node RPC uses mTLS:

1. **Server side**: The `TlsAcceptor` verifies the connecting node's client certificate
2. **Client side**: `RpcClient::with_tls()` loads a `reqwest::Identity` from the `client_cert_file` and `client_key_file`, and adds the CA root certificate to the trust store

```rust
// Internal API - how the RPC client configures mTLS
let rpc_client = RpcClient::with_tls(
    peer_url,
    client_cert_path,
    client_key_path,
    ca_cert_path,
);
```

### Generating Client Certificates

```bash
# Generate client certificate (for inter-node mTLS)
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout client-key.pem -out client.csr -nodes \
  -subj "/CN=neolith-node1"

openssl x509 -req -in client.csr -CA ca.pem -CAkey ca-key.pem \
  -CAcreateserial -out client.pem -days 365

# Each node needs its own client cert, but all signed by the same CA
```

### Full mTLS Cluster Setup

For a 4-node cluster with mTLS:

```bash
# 1. Generate CA (one per cluster)
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout ca-key.pem -out ca.pem -days 3650 -nodes \
  -subj "/CN=Neolith Cluster CA"

# 2. For each node, generate server + client certs
for i in 1 2 3 4; do
  # Server cert
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout node${i}-server-key.pem -out node${i}-server.csr -nodes \
    -subj "/CN=node${i}.neolith.local" \
    -addext "subjectAltName=DNS:node${i}.neolith.local"

  openssl x509 -req -in node${i}-server.csr \
    -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
    -out node${i}-server.pem -days 365 -copy_extensions copy

  # Client cert
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout node${i}-client-key.pem -out node${i}-client.csr -nodes \
    -subj "/CN=node${i}-client"

  openssl x509 -req -in node${i}-client.csr \
    -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
    -out node${i}-client.pem -days 365
done

# 3. Distribute certs to each node
# Node 1 gets: ca.pem, node1-server.pem, node1-server-key.pem, node1-client.pem, node1-client-key.pem
```

Node 1's config:

```toml
[tls]
cert_file = "/etc/neolith/tls/node1-server.pem"
key_file = "/etc/neolith/tls/node1-server-key.pem"
ca_file = "/etc/neolith/tls/ca.pem"
client_cert_file = "/etc/neolith/tls/node1-client.pem"
client_key_file = "/etc/neolith/tls/node1-client-key.pem"

[cluster]
advertise = "https://node1.neolith.local:9000"
peers = [
    "https://node2.neolith.local:9000",
    "https://node3.neolith.local:9000",
    "https://node4.neolith.local:9000",
]
```

## Certificate Hot-Reload

Neolith supports reloading TLS certificates without restarting the server. This is critical for certificate rotation in production.

### Mechanism

The TLS acceptor uses `arc-swap` (via `ReloadableTlsAcceptor`) for atomic certificate replacement:

1. A new `ServerConfig` is built from the updated certificate files
2. The new config is atomically swapped into the `ReloadableTlsAcceptor`
3. New connections use the updated certificates immediately
4. Existing connections continue using the previous certificates until they close

### Triggering Reload

**SIGHUP signal:**

```bash
# Replace certificates
cp new-server.pem /etc/neolith/tls/server.pem
cp new-server-key.pem /etc/neolith/tls/server-key.pem

# Trigger reload
kill -HUP $(pidof neolith)
```

**File watcher:**

If `--config` is specified, the server watches the config file for changes. Modifying the TLS section triggers an automatic reload. The file watcher also detects changes to the certificate files themselves.

### Reload Logging

```
INFO "config reload triggered (SIGHUP)"
INFO "TLS certificates reloaded successfully"
```

If the new certificates are invalid:

```
WARN "TLS certificate reload failed: invalid PEM format"
```

The server continues serving with the previous certificates on reload failure.

## TLS Implementation Details

### Cryptography Provider

Neolith uses `aws-lc-rs` as the rustls cryptography provider, not the default `ring`. This provides:

- FIPS 140-2 validated cryptographic module (when compiled with FIPS mode)
- Maintained by AWS with regular security updates
- Performance-optimized assembly routines for x86_64 and aarch64

### TLS Serving Architecture

```
TcpListener
    |
    v
ReloadableTlsAcceptor (arc-swap wrapped ServerConfig)
    |
    v
tokio-rustls TlsStream
    |
    v
hyper_util Builder + tower ServiceExt
    |
    v
Axum Router
```

The TLS acceptor sits between the raw TCP listener and the HTTP/2 handler. The `serve_reloadable_tls_router` function handles the integration:

1. Accept TCP connection
2. Perform TLS handshake via `TlsAcceptor`
3. If mTLS: verify client certificate against CA
4. Pass the TLS stream to hyper for HTTP/2 processing
5. Forward to the Axum router

### Connecting with TLS

**curl:**

```bash
# Trust the CA
curl --cacert ca.pem https://node1.neolith.local:9000/health

# With client cert (mTLS)
curl --cacert ca.pem \
     --cert client.pem \
     --key client-key.pem \
     https://node1.neolith.local:9000/health
```

**boto3:**

```python
import boto3

s3 = boto3.client(
    "s3",
    endpoint_url="https://neolith.example.com:9000",
    aws_access_key_id="key",
    aws_secret_access_key="secret",
    verify="/path/to/ca.pem",  # Trust custom CA
)
```

**aws-cli:**

```bash
aws --endpoint-url https://neolith.example.com:9000 \
    --ca-bundle /path/to/ca.pem \
    s3 ls
```
