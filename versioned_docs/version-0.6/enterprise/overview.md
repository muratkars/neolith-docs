---
sidebar_position: 1
title: "Enterprise Overview"
---

# Enterprise Overview

Neolith Enterprise extends the open-source core with production-grade multi-tenancy, compliance, advanced security, and operational tooling. All Enterprise features are built as separate crates that wrap the OSS `neolith-server::core` module via `build_server_core` and `serve`, ensuring a clean separation between open-source and commercial code.

## OSS vs Enterprise Comparison

| Capability | OSS (Apache 2.0) | Enterprise | AI Edition |
|---|---|---|---|
| S3-compatible API | Yes | Yes | Yes |
| Erasure coding (Reed-Solomon) | Yes | Yes | Yes |
| LRC erasure coding | Yes | Yes | Yes |
| SSE-S3 / SSE-C encryption | Yes | Yes | Yes |
| SigV4 authentication | Yes | Yes | Yes |
| Object versioning | Yes | Yes | Yes |
| Lifecycle policies | Yes | Yes | Yes |
| Multipart uploads | Yes | Yes | Yes |
| Batch GET / Epoch API | Yes | Yes | Yes |
| ETL transforms (Native + WASM) | Yes | Yes | Yes |
| PyTorch SDK | Yes | Yes | Yes |
| TLS 1.3 / mTLS | Yes | Yes | Yes |
| io_uring acceleration | Yes | Yes | Yes |
| Multi-tenancy & QoS | - | Yes | Yes |
| OIDC / LDAP integration | - | Yes | Yes |
| Bucket policies (deny-overrides-allow) | - | Yes | Yes |
| Compliance & Object Lock (WORM) | - | Yes | Yes |
| Tamper-evident audit logging | - | Yes | Yes |
| Active-active replication | - | Yes | Yes |
| Data tiering (hot/warm/cold) | - | Yes | Yes |
| Disaster recovery | - | Yes | Yes |
| KMS integration | - | Yes | Yes |
| Grafana dashboards | - | Yes | Yes |
| Prometheus alert rules | - | Yes | Yes |
| Drive SMART monitoring | - | Yes | Yes |
| Web Console | - | Yes | Yes |
| K8s Operator (CRD) | - | Yes | Yes |
| Ed25519 offline licensing | - | Yes | Yes |
| Opt-in telemetry | - | Yes | Yes |
| RDMA / RoCEv2 data plane | - | Yes | Yes |
| Iceberg REST Catalog | - | - | Yes |
| Streaming ingest | - | - | Yes |
| Advanced ETL pipelines | - | - | Yes |

## Edition Hierarchy

Neolith uses a three-tier edition model with an `includes()` hierarchy:

```
AI Edition
  includes -> Enterprise Edition
    includes -> OSS Edition
```

The edition is determined at startup via the `NEOLITH_EDITION` environment variable or the `edition` field in the TOML configuration file. The environment variable takes precedence over the config file. Valid values are `oss`, `enterprise`, and `ai`.

```rust
pub enum Edition {
    Oss,
    Enterprise,
    Ai,
}

impl Edition {
    pub fn includes(&self, other: &Edition) -> bool {
        match self {
            Edition::Ai => true,
            Edition::Enterprise => matches!(other, Edition::Oss | Edition::Enterprise),
            Edition::Oss => matches!(other, Edition::Oss),
        }
    }
}
```

When a feature requires a higher edition, the server prints an ASCII-boxed upsell message via `check_and_print_upsell()` and returns an appropriate error response. The feature is not silently ignored: operators always know what they are missing and why.

## Enterprise Features by Phase

Neolith Enterprise includes 57 features across 13 phases:

| Phase | Area | Features |
|---|---|---|
| Phase A | Foundation | Ed25519 licensing, opt-in telemetry, capacity scanning, K8s Operator (kube-rs 0.98), enterprise server wrapper, Grafana dashboards, Prometheus alert rules |
| Phase B | Security & Compliance | OIDC integration, LDAP integration, bucket policies (deny-overrides-allow), Object Lock (WORM), compliance mode retention, legal hold, tamper-evident audit logging, audit log search, audit log export, compliance reporting |
| Phase C1 | Multi-Tenancy & QoS | Tenant catalog, cell catalog, gateway proxy, per-tenant rate limiting, resource quotas, QoS scheduling, tenant isolation, tenant routing, request admission control, overload protection |
| Phase C2 | Bucket Forks | Fork-on-write branching, fork merge, fork diff, fork garbage collection, fork metadata tracking |
| Phase C3 | Streaming & Iceberg | Streaming ingest pipeline, Iceberg REST Catalog, Iceberg table management |
| Phase C4 | KMS Integration | External KMS client, key rotation, key policy management |
| Phase C5 | Operations | Rolling upgrade orchestration, config hot-reload |
| Phase C6 | Self-Healing | Proactive drive failure detection, automated data migration |
| Phase C7 | Replication | Active-active cross-site replication, conflict resolution |
| Phase C8 | Disaster Recovery | Point-in-time recovery, cross-region failover |
| Phase C9 | Data Platform | S3 Select pushdown, advanced ETL orchestration |
| Phase C10 | Performance | Backend proxy optimization, connection pooling |
| Phase C11 | Auth Extensions | Presigned URL policy constraints, advanced bucket policies |
| Phase C12 | Observability | Distributed tracing, drive SMART monitoring, drive latency tracking |
| Phase C13 | Web Console | React-based management UI, monitoring dashboards |
| Phase E | RDMA Transport | S3 over RDMA/RoCEv2, per-cell enable/disable, TCP fallback, QP lifecycle, MR pool, Prometheus metrics |

## Enterprise Crate Architecture

The Enterprise edition is composed of the following crates, each with a focused responsibility:

| Crate | Purpose |
|---|---|
| `neolith-license` | Ed25519 offline license validation, 14-day grace period, feature gating |
| `neolith-telemetry` | Opt-in usage telemetry, HTTPS POST, 24h interval, CancellationToken shutdown |
| `neolith-enterprise-server` | Enterprise server binary, wraps OSS core via `build_server_core` + `serve` |
| `neolith-operator` | Kubernetes Operator using kube-rs 0.98, NeolithCluster CRD v1alpha1 |
| `neolith-compliance` | Object Lock (WORM), retention policies, legal hold, compliance reporting |
| `neolith-audit` | Hash-chain tamper-evident audit log, search and export capabilities |
| `neolith-auth-ext` | OIDC/LDAP integration, extended authentication and authorization |
| `neolith-catalog` | Multi-tenant catalog (tenant/cell), Iceberg REST Catalog |
| `neolith-proxy` | Gateway proxy with QoS, forks, streaming, replication, tiering, and more |
| `neolith-rdma` | Optional RDMA/RoCEv2 data plane; `MockRdmaTransport` on all platforms, `IbverbsTransport` on Linux + `rdma` feature |

All enterprise crates depend on the OSS crates (`neolith-server`, `neolith-meta`, `neolith-s3`, etc.) but never the reverse. The OSS codebase has zero knowledge of enterprise features.

## Deployment

Enterprise features are activated by providing a valid license file at startup. Without a license, Neolith runs in OSS mode with a 14-day grace period for Enterprise evaluation.

```bash
# OSS mode (default)
neolith server start

# Enterprise mode with license
NEOLITH_EDITION=enterprise neolith server start --license /etc/neolith/license.key

# AI edition
NEOLITH_EDITION=ai neolith server start --license /etc/neolith/license.key
```

The license file is validated offline using Ed25519 signature verification. No license server or network call is required. The license encodes the edition, enabled feature set, expiry date, and node/capacity limits.
