---
sidebar_position: 1
title: "Use Cases Overview"
---

# Use Cases Overview

Neolith is a general-purpose S3-compatible object storage system, but its architecture and feature set make it especially well-suited for data-intensive workloads. Whether you are training neural networks on petabytes of images, running a data lake for analytics, or managing encrypted backups with point-in-time recovery, Neolith provides the primitives you need without bolting on external tools.

This section walks through the most common deployment patterns and shows how Neolith's features map to real-world requirements.

## ML Training Pipelines

Train models at scale by streaming data directly from Neolith. The Batch GET API eliminates per-object HTTP overhead, epoch-based iteration provides deterministic shuffling, and the PyTorch SDK integrates with standard training loops.

[Read more: ML Training Pipelines](./ml-training)

## Model Serving and Checkpoints

Store model weights and checkpoints with built-in versioning. Use bucket forks for A/B testing, ETL transforms for format conversion, and presigned URLs for secure model distribution.

[Read more: Model Serving and Checkpoints](./model-serving)

## Data Lake

Build a centralized data lake with full S3 compatibility for existing analytics tools. Event notifications trigger downstream pipelines, batch operations handle bulk processing, and bucket forks let analysts explore data without affecting production.

[Read more: Data Lake](./data-lake)

## Backup and Archive

Protect critical data with erasure-coded storage, encryption at rest, and automatic lifecycle management. Object versioning enables point-in-time recovery, while bucket forks provide lightweight snapshot-based backups.

[Read more: Backup and Archive](./backup-archive)

## Migration Guides

Already running MinIO or AWS S3? Neolith's S3 API compatibility makes migration straightforward.

- [Migrate from MinIO](../guides/migration-from-minio) - Configuration mapping, data migration, and feature comparison
- [Migrate from AWS S3](../guides/migration-from-s3) - Data transfer strategies, IAM mapping, and cost considerations

## Choosing the Right Pattern

| Workload | Key Features | Recommended Edition |
|---|---|---|
| ML Training | Batch GET, epochs, PyTorch SDK, ETL | OSS or Enterprise |
| Model Serving | Versioning, forks, presigned URLs | OSS or Enterprise |
| Data Lake | S3 compat, events, lifecycle | Enterprise (multi-tenancy) |
| Backup/Archive | EC durability, encryption, versioning | OSS or Enterprise |
| Multi-tenant SaaS | Catalog, QoS, audit, compliance | Enterprise |

For multi-tenant deployments, regulated industries, or environments requiring advanced observability, see the [Enterprise documentation](/docs/enterprise/overview).
