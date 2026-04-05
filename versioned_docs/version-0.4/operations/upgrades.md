---
sidebar_position: 5
title: "Rolling Upgrades"
---

# Rolling Upgrades

Neolith is designed for zero-downtime upgrades. The single-binary architecture, backward-compatible metadata format, and graceful shutdown mechanism enable rolling upgrades across a cluster without service interruption.

## Single Binary Replacement

Neolith is distributed as a single static binary. Upgrading is as simple as replacing the binary and restarting the process:

```bash
# Download new version
curl -Lo /tmp/neolith https://releases.neolith.dev/v0.5.0/neolith-linux-amd64

# Replace binary
chmod +x /tmp/neolith
mv /tmp/neolith /usr/local/bin/neolith

# Restart (systemd)
systemctl restart neolith
```

There are no external dependencies, migration scripts, or database schema changes.

## Graceful Shutdown

When upgrading, the existing process must be stopped before the new one starts (they share the same port). Neolith handles this gracefully:

### Shutdown Sequence

1. **Signal**: Send `SIGTERM` (or `SIGINT`):
   ```bash
   kill -TERM $(pidof neolith)
   # or: systemctl stop neolith
   ```

2. **Stop accepting**: The TCP listener closes immediately. No new connections are accepted.

3. **Drain in-flight requests**: Active requests are allowed to complete. New requests to existing connections receive HTTP 503 `SlowDown` responses.

4. **Drain timeout**: The server waits up to `drain_timeout_seconds` (default: 30s) for in-flight requests to finish:
   ```
   INFO in_flight=12 timeout_secs=30 "draining connections"
   INFO "all connections drained"
   ```

5. **Persist state**: The listing cache is saved to `.neolith/listing-cache.bin` for fast restart:
   ```
   INFO count=45230 "listing cache snapshot saved"
   ```

6. **Cancel background tasks**: Notification workers, heal scanner, lifecycle scanner, and other background tasks receive cancellation via `CancellationToken`.

7. **Exit**: Process exits with code 0.

### Monitoring Drain Status

Check drain progress via the admin endpoint:

```bash
curl http://localhost:9000/_neolith/admin/v1/drain
```

```json
{
  "in_flight": 5,
  "draining": true
}
```

### Systemd Integration

Configure systemd for graceful shutdown:

```ini
[Unit]
Description=Neolith Object Storage
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/neolith server start --config /etc/neolith/config.toml /mnt/disk{1...16}
ExecReload=/bin/kill -HUP $MAINPID
TimeoutStopSec=45
KillSignal=SIGTERM
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Set `TimeoutStopSec` higher than `drain_timeout_seconds` to allow the drain to complete before systemd force-kills the process.

## Metadata Backward Compatibility

Neolith supports two metadata serialization formats and handles migration transparently:

### Format Versions

| Version | Format | Introduced | Status |
|---|---|---|---|
| `FORMAT_VERSION_V1` (1) | bincode v1 | v0.1 | Legacy, read-only |
| `FORMAT_VERSION_V2` (2) | FlatBuffers v2 | v0.2 | Current |

### Format Detection

Metadata files start with the `NEOM` magic bytes followed by a version byte. The deserializer (`ObjectMeta::from_bytes()`) auto-detects the format:

```
Bytes 0-3: NEOM (magic)
Byte 4:    Version (1 or 2)
Byte 5+:   Serialized metadata
```

- V1 files are deserialized via `ObjectMetaV1` (in `legacy.rs`) using bincode
- V2 files are deserialized via FlatBuffers with zero-copy `MetaView` for read-hot paths

### Lazy Migration

There is no big-bang migration step when upgrading from v1 to v2 metadata. Instead:

1. **Reads**: Both v1 and v2 formats are supported transparently. `from_bytes()` checks the version byte and dispatches to the appropriate deserializer.

2. **Writes**: All new writes use v2 (FlatBuffers).

3. **Background migration**: The `BackgroundScanner` lazily upgrades v1 metadata to v2 during its normal scan cycle. When it encounters a v1 file, it deserializes it, re-serializes as v2, and atomically replaces the file.

4. **LIST optimization**: The `list_keys` function tries `MetaView` (zero-copy v2 fast path) first, then falls back to full `ObjectMeta::from_bytes()` for v1 files.

This means:
- Upgrading is instantaneous (no migration downtime)
- Both formats coexist safely until the background scanner completes
- The scanner runs at low priority, taking up to 30 days to complete a full cycle
- Performance gradually improves as v1 files are converted to v2

## Config Hot-Reload

Many configuration changes can be applied without restarting the server:

### Hot-Reloadable Settings

| Setting | Reload Method | Effect |
|---|---|---|
| TLS certificates | SIGHUP or file watcher | New connections use updated certs |
| Log level | SIGHUP or file watcher | Immediate log level change |
| Rate limit parameters | SIGHUP or file watcher | Immediate rate limit update |

### Non-Hot-Reloadable Settings

These require a full restart:

| Setting | Why |
|---|---|
| Listen address | TCP listener is bound at startup |
| Drive paths | Data directories are initialized at startup |
| Cluster peers | Topology is built at startup |
| Erasure coding parameters | EC codec is initialized at startup |
| Compression codec | Codec is set during initialization |

### Triggering Reload

**SIGHUP:**

```bash
kill -HUP $(pidof neolith)
```

**File watcher:**

If `--config` is specified, the server watches the config file for modifications and automatically reloads hot-reloadable settings.

**Reload logging:**

```
INFO "config reload triggered (SIGHUP)"
INFO "logging level updated to debug"
INFO "TLS certificates reloaded successfully"
INFO "rate limits updated: global=15000 ops/s, per-credential=2000 ops/s"
```

## Rolling Upgrade Procedure

For a multi-node cluster, upgrade one node at a time:

### Step-by-Step

```bash
# 1. Check cluster health before starting
neolith cluster status --endpoint http://node1:9000

# 2. Upgrade node 1
ssh node1 "systemctl stop neolith"
ssh node1 "cp /tmp/neolith-new /usr/local/bin/neolith"
ssh node1 "systemctl start neolith"

# 3. Verify node 1 is healthy
neolith cluster info --endpoint http://node1:9000
# Confirm version shows the new version

# 4. Wait for heal scanner to verify data integrity
neolith admin heal status --endpoint http://node1:9000
# Ensure no unexpected corruption

# 5. Repeat for nodes 2, 3, 4...
```

### Safety Checks

Before upgrading each node, verify:

1. **All nodes online**: `neolith cluster status` shows all nodes as `online`
2. **No active heal**: `neolith admin heal status` shows zero queue depth
3. **No active rebalance**: `neolith admin rebalance status` shows `running: false`
4. **Health check passes**: `curl http://nodeN:9000/health` returns `{"status":"ok"}`

### Rollback

If an upgrade introduces issues:

1. Stop the upgraded node: `systemctl stop neolith`
2. Replace the binary with the previous version
3. Start the node: `systemctl start neolith`
4. The node will rejoin the cluster with the old version

Because metadata is backward-compatible (v1 and v2 coexist), rolling back to an older version is safe. Objects written with the new version in v2 format are still readable by older versions that support v2.

## Version Compatibility Matrix

| Cluster State | Supported |
|---|---|
| All nodes same version | Yes (recommended) |
| Mixed v0.3 + v0.4 | Yes (during rolling upgrade) |
| Mixed v0.2 + v0.4 | Yes (metadata compat) |
| Downgrade v0.4 to v0.3 | Yes (v2 metadata readable by v0.3+) |
| Downgrade v0.2 to v0.1 | No (v0.1 cannot read v2 FlatBuffer metadata) |

The general rule: any version that supports `FORMAT_VERSION_V2` can coexist with any other version that supports it. The transition from v1 (bincode) to v2 (FlatBuffers) happened in v0.2.
