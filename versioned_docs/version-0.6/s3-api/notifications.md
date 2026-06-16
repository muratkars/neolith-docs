---
sidebar_position: 13
title: "Event Notifications"
---

# Event Notifications

Neolith emits S3-compatible event notifications when objects are created or deleted. You can configure per-bucket rules that filter events by type and key pattern, then deliver matching events to webhooks, files, stdout, or message brokers.

## Overview

Event notifications let you react to changes in your buckets in near-real-time. Common use cases include:

- **ML pipeline triggers**: start a training job when new data lands in a bucket
- **Audit logging**: record all writes and deletes to a compliance log
- **Cache invalidation**: purge a CDN edge cache when objects change
- **Data synchronization**: replicate changes to an external system

Events are emitted inline during S3 operations (PUT, COPY, DELETE, CompleteMultipartUpload). Matching events are queued in-memory and delivered asynchronously by a background worker. Failed deliveries are retried with exponential backoff, and events that exhaust all retries are moved to a dead letter queue.

## Event Types

Neolith supports the following S3-compatible event types:

| Event Type | Trigger |
|---|---|
| `s3:ObjectCreated:Put` | Object created via PUT |
| `s3:ObjectCreated:Copy` | Object created via COPY |
| `s3:ObjectCreated:CompleteMultipartUpload` | Object created via multipart upload completion |
| `s3:ObjectRemoved:Delete` | Object deleted |
| `s3:ObjectRemoved:DeleteMarkerCreated` | Delete marker created (versioned bucket) |

### Wildcards

You can use wildcard patterns to match multiple event types:

- `s3:ObjectCreated:*` - matches all creation events (Put, Copy, CompleteMultipartUpload)
- `s3:ObjectRemoved:*` - matches all removal events (Delete, DeleteMarkerCreated)

## Event Record Format

Events follow the AWS S3 event notification format (version 2.1):

```json
{
  "eventVersion": "2.1",
  "eventSource": "neolith:s3",
  "eventTime": "2026-04-01T12:34:56.789Z",
  "eventName": "s3:ObjectCreated:Put",
  "s3": {
    "s3SchemaVersion": "1.0",
    "bucket": {
      "name": "my-bucket"
    },
    "object": {
      "key": "data/training-batch-042.parquet",
      "size": 104857600,
      "eTag": "a1b2c3d4e5f6...",
      "versionId": "v-abc123"
    }
  }
}
```

The `eventSource` field is always `neolith:s3` (not `aws:s3`), which allows consumers to distinguish events from Neolith versus AWS.

## Configuration API

Notification rules are configured per-bucket using the S3 notification API. Rules are stored as `.notifications.json` sidecar files alongside bucket data.

### Set Notification Configuration

```bash
curl -X PUT "http://localhost:9000/my-bucket?notification" \
  -H "Content-Type: application/json" \
  -d '{
    "rules": [
      {
        "id": "new-parquet-files",
        "events": ["s3:ObjectCreated:*"],
        "filter_prefix": "data/",
        "filter_suffix": ".parquet",
        "webhook": {
          "url": "https://hooks.example.com/on-upload",
          "auth_header": "Bearer my-secret-token",
          "headers": {
            "X-Custom-Header": "neolith"
          }
        },
        "destination": {"type": "webhook"}
      }
    ]
  }'
```

### Get Notification Configuration

```bash
curl "http://localhost:9000/my-bucket?notification"
```

### Delete Notification Configuration

```bash
curl -X DELETE "http://localhost:9000/my-bucket?notification"
```

## Notification Rule Structure

Each rule has the following fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique identifier within the bucket |
| `events` | string[] | yes | Event types to match (supports wildcards) |
| `filter_prefix` | string | no | Only match keys starting with this prefix |
| `filter_suffix` | string | no | Only match keys ending with this suffix |
| `webhook` | object | yes | Webhook delivery target (URL, auth, headers) |
| `destination` | object | no | Delivery destination (defaults to `webhook`) |

### WebhookTarget

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | HTTP(S) URL for POST delivery |
| `auth_header` | string | no | Value for the `Authorization` header |
| `headers` | map | no | Additional custom headers |

## Delivery Destinations

Neolith supports multiple delivery destinations per rule.

### Webhook (default)

HTTP POST to a configured URL. Events are delivered as JSON in the request body. The webhook target supports custom authorization headers and additional custom headers.

```json
{
  "destination": {"type": "webhook"}
}
```

Retry behavior: exponential backoff with jitter, up to `max_retries` attempts (default: 5). Events that fail all retries are moved to the dead letter queue.

### File

Append events as JSONL (one JSON object per line) to a file on disk. Useful for local audit logs.

```json
{
  "destination": {
    "type": "file",
    "path": "/var/log/neolith/events.jsonl"
  }
}
```

### Stdout

Write events as JSONL to the server's standard output. Useful for development and log aggregation pipelines.

```json
{
  "destination": {"type": "stdout"}
}
```

### NATS (feature-gated)

Deliver events to a NATS messaging server. Requires the `nats` feature flag at compile time.

```json
{
  "destination": {
    "type": "nats",
    "url": "nats://localhost:4222",
    "subject": "neolith.events.my-bucket"
  }
}
```

If `subject` is omitted, the default pattern `neolith.events.{bucket}` is used.

### AMQP / Kafka (planned)

Configuration stubs exist for AMQP (RabbitMQ) and Apache Kafka delivery. These destinations are defined in the configuration schema but delivery is not yet implemented. AMQP supports `url`, `exchange`, and `routing_key` fields. Kafka supports `brokers` and `topic` fields.

## Dead Letter Queue

Events that fail all delivery retries are persisted to a dead letter queue (DLQ). The DLQ uses JSONL format for append-only, grep-friendly inspection.

### DLQ Entry Format

```json
{
  "record": { "...event record..." },
  "error": "connection refused",
  "failed_at": "2026-04-01T12:35:00Z",
  "attempts": 5,
  "destination": "webhook"
}
```

### DLQ File Location

By default, the DLQ file is stored at `.neolith/dlq/dead-letters.jsonl` under the data directory. You can override this with the `dlq_dir` setting.

### Inspecting the DLQ

```bash
# Count failed events
wc -l /data/.neolith/dlq/dead-letters.jsonl

# Find failures for a specific bucket
grep '"name":"my-bucket"' /data/.neolith/dlq/dead-letters.jsonl | jq .

# Tail new failures in real-time
tail -f /data/.neolith/dlq/dead-letters.jsonl | jq .
```

## Server Configuration

The `[notify]` section in your TOML config controls global notification behavior:

```toml
[notify]
# Enable notifications (default: true)
enabled = true

# In-memory event queue capacity (default: 10000)
queue_capacity = 10000

# Maximum delivery retries before moving to DLQ (default: 5)
max_retries = 5

# Webhook HTTP timeout in seconds (default: 10)
webhook_timeout_seconds = 10

# Enable dead letter queue (default: true)
dlq_enabled = true

# Custom DLQ directory (default: .neolith/dlq/ under data dir)
# dlq_dir = "/var/log/neolith/dlq"
```

## Examples

### Track All Writes to a Bucket

```bash
curl -X PUT "http://localhost:9000/training-data?notification" \
  -H "Content-Type: application/json" \
  -d '{
    "rules": [{
      "id": "all-writes",
      "events": ["s3:ObjectCreated:*"],
      "webhook": {
        "url": "https://mlops.internal/on-data-change",
        "auth_header": "Bearer pipeline-token-xyz"
      }
    }]
  }'
```

### Log Deletes to a File

```bash
curl -X PUT "http://localhost:9000/production?notification" \
  -H "Content-Type: application/json" \
  -d '{
    "rules": [{
      "id": "delete-audit",
      "events": ["s3:ObjectRemoved:*"],
      "webhook": {"url": ""},
      "destination": {
        "type": "file",
        "path": "/var/log/neolith/deletes.jsonl"
      }
    }]
  }'
```

### Filter by Prefix and Suffix

```bash
curl -X PUT "http://localhost:9000/data-lake?notification" \
  -H "Content-Type: application/json" \
  -d '{
    "rules": [{
      "id": "new-parquet",
      "events": ["s3:ObjectCreated:Put", "s3:ObjectCreated:CompleteMultipartUpload"],
      "filter_prefix": "raw/",
      "filter_suffix": ".parquet",
      "webhook": {
        "url": "https://spark.internal/trigger-etl"
      }
    }]
  }'
```

## Architecture Notes

- Events are queued in a bounded `mpsc` channel (default capacity: 10,000). If the queue is full, events are dropped with a warning log.
- The delivery worker runs as a background tokio task and drains remaining events on graceful shutdown.
- Per-bucket notification configs are cached in memory with lazy loading from the `.notifications.json` sidecar file.
- The DLQ never returns errors to callers: if a DLQ write fails, it logs a warning and drops the entry to avoid cascading failures in the event pipeline.
