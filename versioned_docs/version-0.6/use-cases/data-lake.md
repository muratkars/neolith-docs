---
sidebar_position: 4
title: "Data Lake"
---

# Data Lake

Neolith serves as the storage foundation for a modern data lake: a centralized repository where structured, semi-structured, and unstructured data coexist under a single S3-compatible API. Existing analytics tools - Spark, Presto, Trino, DuckDB, Pandas - connect to Neolith without modification. Event notifications trigger downstream pipelines, batch operations handle bulk processing, and bucket forks let analysts explore data safely without affecting production tables.

## S3 Compatibility for Existing Tools

Neolith implements the S3 API surface that analytics engines rely on. You can point any S3-compatible tool at Neolith by setting the endpoint URL:

### Apache Spark

```python
spark = SparkSession.builder \
    .config("spark.hadoop.fs.s3a.endpoint", "http://neolith:9000") \
    .config("spark.hadoop.fs.s3a.access.key", "neolith-access-key") \
    .config("spark.hadoop.fs.s3a.secret.key", "neolith-secret-key") \
    .config("spark.hadoop.fs.s3a.path.style.access", "true") \
    .getOrCreate()

df = spark.read.parquet("s3a://data-lake/events/2026/03/")
df.groupBy("event_type").count().show()
```

### DuckDB

```sql
INSTALL httpfs;
LOAD httpfs;
SET s3_endpoint = 'neolith:9000';
SET s3_access_key_id = 'neolith-access-key';
SET s3_secret_access_key = 'neolith-secret-key';
SET s3_use_ssl = false;
SET s3_url_style = 'path';

SELECT event_type, count(*)
FROM read_parquet('s3://data-lake/events/2026/03/*.parquet')
GROUP BY event_type;
```

### Pandas

```python
import pandas as pd
import s3fs

fs = s3fs.S3FileSystem(
    endpoint_url="http://neolith:9000",
    key="neolith-access-key",
    secret="neolith-secret-key",
)

df = pd.read_parquet("s3://data-lake/events/2026/03/01.parquet", filesystem=fs)
```

### Supported S3 Operations

The following operations are fully supported for data lake workloads:

| Operation | Status | Notes |
|---|---|---|
| GET / PUT / DELETE | Supported | Standard object CRUD |
| LIST (v2) | Supported | Prefix filtering, delimiter, streaming |
| Multipart upload | Supported | 5 MiB min part, 10K max parts |
| Conditional requests | Supported | If-Match, If-None-Match, If-Modified-Since |
| SigV4 auth | Supported | Header and query-string signing |
| Virtual-hosted style | Supported | Configurable endpoint domain |
| Presigned URLs | Supported | Up to 7-day expiry |

## Event Notifications for Pipeline Triggers

Neolith publishes event notifications when objects are created, deleted, or modified. Use these to trigger downstream ETL pipelines automatically:

```json
{
  "Events": [
    {
      "eventName": "s3:ObjectCreated:Put",
      "bucket": "data-lake",
      "key": "raw/events/2026/03/28/batch_001.parquet",
      "size": 52428800,
      "etag": "a1b2c3d4e5f6..."
    }
  ]
}
```

Events are delivered via HTTP webhooks to any endpoint: an Airflow DAG trigger, a Kafka producer, a custom microservice, or a serverless function. A typical pipeline flow is: data sources PUT to `raw/`, events trigger Spark/ETL processing, results are written to `curated/`, and further events notify dashboards and notebooks.

## Batch API for ETL Workloads

When an ETL job needs to process thousands of small files (JSON logs, CSV records, sensor readings), the Batch GET API eliminates per-object HTTP overhead:

```bash
# Fetch all files for a partition in one request
curl -X POST http://neolith:9000/data-lake?batch-get \
  -H "Content-Type: application/json" \
  -d '{
    "keys": ["raw/events/2026/03/28/event_001.json",
             "raw/events/2026/03/28/event_002.json",
             "..."],
    "format": "tar+lz4"
  }' \
  -o partition.tar.lz4
```

For recurring ETL jobs, epoch-based iteration handles partitioning and progress tracking: register an epoch with `POST ?batch-epoch`, then fetch batches sequentially with `GET ?batch-next` until all batches are consumed (204 response).

Server-side ETL transforms can also reduce data movement by applying field extraction, format conversion, or aggregation at the storage layer before data crosses the network. See [ETL Transforms](/docs/ai-ml/etl-transforms) for details.

## Bucket Forks for Safe Data Exploration

Data analysts and data scientists often need to experiment with transformations, test new schemas, or explore subsets of data. Bucket forks provide isolated workspaces without duplicating data:

```bash
# Create a fork for an analyst's exploration
curl -X POST http://neolith:9000/data-lake?fork \
  -d '{"name": "data-lake-analysis-q1"}'

# Analyst can write derived tables to the fork
aws --endpoint-url http://neolith:9000 s3 cp aggregated.parquet \
  s3://data-lake-analysis-q1/derived/user_cohorts.parquet

# Fork reads from parent for any key not overridden
# So queries against the fork see: original data + analyst's additions

# When done, either promote useful artifacts or delete the fork
aws --endpoint-url http://neolith:9000 s3 cp \
  s3://data-lake-analysis-q1/derived/user_cohorts.parquet \
  s3://data-lake/curated/user_cohorts.parquet
```

### Use Cases for Forks

| Scenario | Benefit |
|---|---|
| Schema migration testing | Test new Parquet schema without touching production |
| Ad-hoc analysis | Write intermediate results without polluting shared namespace |
| Data quality validation | Compare fork output against production to validate changes |
| Training data prep | Augment or filter datasets for ML without copying |

## Lifecycle Rules for Data Retention

Data lakes accumulate data rapidly. Lifecycle rules automate tiering and expiration:

```bash
aws --endpoint-url http://neolith:9000 s3api put-bucket-lifecycle-configuration \
  --bucket data-lake \
  --lifecycle-configuration '{
    "Rules": [
      {
        "ID": "expire-raw-zone",
        "Status": "Enabled",
        "Filter": {"Prefix": "raw/"},
        "Expiration": {"Days": 90}
      },
      {
        "ID": "expire-temp-zone",
        "Status": "Enabled",
        "Filter": {"Prefix": "temp/"},
        "Expiration": {"Days": 7}
      },
      {
        "ID": "keep-curated-versions",
        "Status": "Enabled",
        "Filter": {"Prefix": "curated/"},
        "NoncurrentVersionExpiration": {"NoncurrentDays": 365}
      }
    ]
  }'
```

### Recommended Data Lake Layout

```
data-lake/
  raw/              # Immutable landing zone (90-day expiry)
    events/
      2026/03/28/
    logs/
      2026/03/28/
  curated/          # Cleaned, validated data (versioned, long retention)
    user_cohorts.parquet
    daily_metrics.parquet
  temp/             # Scratch space (7-day expiry)
    job-12345/
  derived/          # Aggregations and features (30-day expiry)
    weekly_rollups/
```

## Enterprise Features for Data Lakes

For production data lake deployments, Neolith Enterprise adds:

- **Multi-tenancy**: Isolate teams or departments with tenant-level catalog, QoS quotas, and access policies
- **Audit logging**: Full audit trail of every data access for compliance (SOC 2, HIPAA, GDPR)
- **Replication**: Cross-region replication for disaster recovery
- **Observability**: Grafana dashboards and Prometheus alerts for storage health, throughput, and latency

See [Enterprise Overview](/docs/enterprise/overview) for details.
