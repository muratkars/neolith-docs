---
sidebar_position: 3
title: "Neolith vs Cloud Storage"
---

# Neolith vs Cloud Storage

Cloud object storage services (AWS S3, Google Cloud Storage, Azure Blob Storage) offer massive scale and zero operational overhead. Neolith offers data sovereignty, elimination of egress fees, AI-native features, and full infrastructure control. This page helps you evaluate the tradeoffs and identify where Neolith fits alongside or instead of cloud storage.

## Comparison Overview

| Dimension | AWS S3 | Google Cloud Storage | Azure Blob Storage | Neolith |
|---|---|---|---|---|
| **Deployment** | Managed service | Managed service | Managed service | Self-hosted (on-prem / any cloud) |
| **S3 API** | Native | Interop mode | S3-compatible proxy | Native S3-compatible |
| **Durability** | 11 nines (99.999999999%) | 11 nines | 11+ nines | Configurable (EC ratio dependent) |
| **Availability** | 99.99% (Standard) | 99.99% (Standard) | 99.99% (RA-GRS) | Depends on deployment |
| **Egress Pricing** | $0.09/GB (first 10TB) | $0.12/GB | $0.087/GB | None (your network) |
| **Storage Pricing** | $0.023/GB/mo (Standard) | $0.020/GB/mo (Standard) | $0.018/GB/mo (Hot) | Hardware cost only |
| **Data Sovereignty** | Region-locked (AWS regions) | Region-locked (GCP regions) | Region-locked (Azure regions) | Full control (your hardware) |
| **AI/ML Features** | S3 Select, Athena, SageMaker | BigQuery, Vertex AI | Synapse, Azure ML | Batch GET, ETL-on-GET, PyTorch SDK |
| **Encryption** | SSE-S3, SSE-KMS, SSE-C | CMEK, CSEK | SSE (managed/customer keys) | SSE-S3, SSE-C, Enterprise KMS |
| **License** | Proprietary | Proprietary | Proprietary | Apache 2.0 (OSS) |

## Data Sovereignty

Cloud storage binds your data to a cloud provider's infrastructure, even when using specific regions:

- **Legal jurisdiction**: Your data falls under the cloud provider's ToS and the legal jurisdiction of the provider's country (US for AWS/GCP, US/Ireland for Azure).
- **Government access**: Cloud providers may be compelled to provide data access under CLOUD Act, FISA, or similar legislation, regardless of the region where data is stored.
- **Provider lock-in**: While S3 API compatibility reduces application lock-in, operational lock-in (IAM, VPC, CloudTrail, KMS) is significant.

Neolith runs on your hardware, in your datacenter, under your jurisdiction:
- Data never leaves your physical control
- No third-party provider can be compelled to access your data
- Regulatory compliance (GDPR, DORA, NIS2) is simpler when you control the infrastructure
- Enterprise multi-tenancy with data residency controls restricts data to specific geographic cells

## Egress Costs

Cloud egress fees are the hidden cost that transforms cloud storage economics at scale:

### Cost Comparison: 100 TiB Stored, 50 TiB Monthly Egress

| Cost Component | AWS S3 | Neolith (On-Prem) |
|---|---|---|
| Storage (100 TiB) | $2,355/mo | ~$150/mo (amortized NVMe) |
| Egress (50 TiB) | $4,505/mo | $0 |
| PUT requests (1M) | $5/mo | $0 |
| GET requests (100M) | $40/mo | $0 |
| **Monthly total** | **$6,905/mo** | **~$150/mo** |
| **Annual total** | **$82,860/yr** | **~$1,800/yr** |

The breakeven point is typically 6-12 months of operation, after which on-premises storage with Neolith is 10-40x cheaper depending on egress volume.

### AI/ML Egress Amplification

AI/ML workloads amplify egress costs because training pipelines read the same dataset multiple times:

- A 10 TiB training dataset read 100 times per month (100 epochs) generates 1 PiB of egress: ~$92,000/month on AWS S3.
- The same workload on Neolith: $0 egress, plus Neolith's batch GET reduces per-request overhead by 100-1000x.

## Feature Comparison: AWS S3 vs Neolith

### Where S3 Wins

| Feature | AWS S3 | Neolith |
|---|---|---|
| Global scale | Unlimited, fully managed | Limited by your infrastructure |
| Availability | 11 nines durability, 99.99% availability SLA | No SLA (self-managed) |
| Ecosystem | Lambda triggers, Athena, Glue, SageMaker, etc. | S3 API compatible, fewer integrations |
| Intelligent Tiering | Automatic, ML-driven tier transitions | Rule-based (Enterprise) |
| S3 Glacier / Deep Archive | Sub-$0.004/GB/mo archival | Cold tier depends on your hardware/media |
| Cross-region replication | Built-in, fully managed | Enterprise feature, self-managed |
| Access logging | CloudTrail integration | Enterprise audit logging |

### Where Neolith Wins

| Feature | AWS S3 | Neolith |
|---|---|---|
| Egress cost | $0.09/GB | $0 |
| Batch GET (AI/ML) | No native support | TAR+LZ4/zstd, epoch-based, shuffled |
| ETL on GET | Lambda (separate service, cold starts) | Inline transforms (Native, WASM) |
| PyTorch integration | S3 FileSystem (per-object GET) | Native IterableDataset with prefetch |
| Data sovereignty | Region-locked to AWS | Full control |
| Source code | Proprietary | Apache 2.0 |
| Vendor lock-in | Significant (IAM, KMS, VPC, CloudTrail) | None |
| Zero-copy metadata | No | FlatBuffer MetaView |
| LRC erasure coding | Not exposed | 75% repair I/O reduction |
| Predictable pricing | Varies (egress, requests, tiering) | Fixed (hardware cost) |

## Feature Comparison: Google Cloud Storage vs Neolith

Google Cloud Storage offers strong analytics integration (BigQuery, Dataflow) and competitive pricing. The tradeoffs are similar to AWS S3:

- **GCS advantage**: Autoclass (automatic tiering), strong BigQuery integration, Dual-region with turbo replication.
- **Neolith advantage**: No egress fees ($0.12/GB on GCS), batch GET for ML training, full data sovereignty, Apache 2.0 license.

## Feature Comparison: Azure Blob Storage vs Neolith

Azure Blob Storage integrates deeply with the Microsoft ecosystem (Synapse, Azure ML, Active Directory). Key considerations:

- **Azure advantage**: RA-GRS (read-access geo-redundant storage), Azure AD integration, immutable storage with legal hold, Lifecycle management with last access tracking.
- **Neolith advantage**: No egress fees ($0.087/GB on Azure), AI-native batch and ETL features, no vendor lock-in, Rust memory safety, Apache 2.0 license.

## Hybrid Strategies

Neolith and cloud storage are not mutually exclusive. Neolith Enterprise supports hybrid deployments:

### 1. On-Prem Primary + Cloud DR

Store primary data on Neolith (on-premises) and replicate to cloud storage for disaster recovery:

```
On-Premises Datacenter              Cloud (DR)
┌─────────────────────┐            ┌──────────────┐
│ Neolith Cluster     │            │  S3 Bucket   │
│ (hot data, compute) │ ─ async ─> │  (cold DR    │
│                     │  replicate │   copy)      │
└─────────────────────┘            └──────────────┘
```

Benefits:
- No egress for AI/ML training (reads from on-prem)
- Cloud DR for catastrophic site failure
- Cost-effective: only pay cloud storage for DR copy, minimal egress

### 2. On-Prem Hot + Cloud Cold Tier

Use Neolith Enterprise's tiering engine to automatically move cold data to cloud storage:

```toml
[[enterprise.tiering.rules]]
name = "archive-to-s3"
source_tier = "warm"
destination_tier = "cloud-s3"
condition = "last_access_age > 180d"

[enterprise.tiering.backends.cloud-s3]
type = "s3"
endpoint = "https://s3.amazonaws.com"
bucket = "neolith-archive"
region = "us-east-1"
storage_class = "GLACIER"
```

Benefits:
- Hot data stays on fast local NVMe
- Cold data automatically moves to cheap cloud archival
- Transparent recall on access (TierStub in Neolith, automatic fetch from S3)

### 3. Multi-Cloud with Neolith Gateway

Use Neolith as a unified S3 gateway in front of multiple cloud backends:

- Single API endpoint for applications
- Policy-based routing to different cloud providers
- Avoid lock-in to any single cloud provider
- Batch GET and ETL transforms applied regardless of backend

## When to Choose Cloud Storage

- You have minimal egress (write-heavy, archive-only workloads)
- You need global scale without managing infrastructure
- Your team has no capacity for storage operations
- You need deep integration with cloud-native services (Lambda, BigQuery, Synapse)
- Regulatory requirements are met by the cloud provider's compliance certifications

## When to Choose Neolith

- Egress costs are significant (AI/ML training, analytics, content delivery)
- Data sovereignty or regulatory requirements prohibit cloud storage
- You need AI-native features (batch GET, ETL-on-GET, PyTorch SDK)
- Predictable, fixed-cost storage economics are preferred
- You want to avoid cloud vendor lock-in
- You have datacenter infrastructure and operational capability
- Apache 2.0 licensing is important for your organization

## When to Use Both

- On-prem Neolith for hot data and AI/ML workloads + cloud for DR and archival
- Neolith as a caching/processing layer in front of cloud storage
- Gradual migration from cloud to on-prem as data volumes grow
