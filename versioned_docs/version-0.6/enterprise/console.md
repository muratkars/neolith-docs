---
sidebar_position: 8
title: "Web Console"
---

# Web Console

The Neolith Web Console (`neolith-console`) provides a browser-based management interface for Neolith Enterprise clusters. Built with React 18, TypeScript, and Tailwind CSS v4, it offers bucket management, object browsing, user administration, and real-time monitoring.

## Technology Stack

| Component | Technology |
|---|---|
| Framework | React 18 |
| Language | TypeScript |
| Styling | Tailwind CSS v4 |
| Build | Vite |
| Testing | 17 Rust integration tests |
| API Layer | Neolith Admin API + S3 API |

## Modules

The console is organized into 8 modules:

### 1. Dashboard

The landing page provides a cluster health overview:
- Node count and status (online/offline/decommissioning)
- Storage utilization (used/available/projected full date)
- Request rate and latency graphs (last 1h/6h/24h/7d)
- Active alerts from Prometheus alert rules
- Recent admin operations (heal, rebalance, tenant changes)

### 2. Bucket Management

Create, configure, and delete buckets:
- Create bucket with optional versioning, Object Lock, and lifecycle rules
- View bucket list with storage usage, object count, and creation date
- Configure bucket properties: versioning, lifecycle, CORS, bucket policy
- View and edit bucket tags
- Delete bucket (with empty-bucket check)

### 3. Object Browser

Browse and manage objects within a bucket:
- Hierarchical folder-style navigation (using common prefixes)
- Upload files (single and multipart for large objects)
- Download objects (direct download or generate presigned URL)
- View object metadata: size, ETag, content type, storage class, encryption status
- View object versions (when versioning is enabled)
- Delete objects (with version-aware delete marker creation)
- Copy objects between buckets
- Edit object tags

### 4. User Administration

Manage access keys and identity providers:
- Create and delete access key pairs
- View active STS sessions
- Configure OIDC providers (Enterprise)
- Configure LDAP settings (Enterprise)
- Manage bucket policies with a visual policy editor
- View per-user access audit trail

### 5. Cluster Management

Monitor and manage cluster topology:
- View cluster topology map (nodes, pools, drives)
- Node health status with drive-level SMART details
- Start/stop heal operations with progress tracking
- Start/stop rebalance operations
- Decommission nodes with data migration progress
- Manage storage pools (create, add nodes, set read-only)

### 6. Monitoring

Embedded monitoring visualizations:
- Real-time request rate and latency graphs
- Drive I/O metrics per node
- Erasure coding throughput
- Heal queue depth and repair rate
- Replication lag (Enterprise)
- Tiering activity (Enterprise)
- Links to external Grafana dashboards for deeper analysis

### 7. Tenant Management (Enterprise)

Multi-tenant administration:
- Create and manage tenants
- Assign storage cells to tenants
- Configure per-tenant quotas (storage, bandwidth, request rate)
- View tenant resource usage vs quotas
- Tenant-scoped bucket and user views

### 8. Compliance (Enterprise)

Compliance and audit management:
- Object Lock status overview
- Legal hold management
- Audit log search and export
- Compliance report generation
- Data residency configuration

## Integration with Neolith

The console is served as static assets embedded in the Neolith binary. When the Enterprise edition is active, the console is available at the root path (`/`) of the Neolith server:

```
http://localhost:9000/           -> Web Console (if Enterprise)
http://localhost:9000/bucket/key -> S3 API (always)
```

The console communicates with two APIs:
- **S3 API**: For bucket and object operations (using SigV4-signed requests from the browser)
- **Admin API**: For cluster management, user administration, and monitoring (under `/_neolith/admin/v1/`)

### Authentication

The console uses the standard Neolith authentication flow:
1. User enters their access key and secret key in the login screen.
2. The console stores credentials in browser session storage (never localStorage for security).
3. All API requests are signed with SigV4 in the browser using the stored credentials.
4. OIDC login is supported as an alternative: the console redirects to the configured IdP and receives credentials via the STS `AssumeRoleWithWebIdentity` flow.

## Testing

The console includes 17 Rust integration tests that validate:
- Static asset serving and routing
- API endpoint accessibility through the console proxy
- Authentication flow (login, session, logout)
- CORS handling for browser requests
- Content-Security-Policy headers
- Error page rendering

Tests are run as part of the standard `cargo test` workflow in the enterprise repository.

## Deployment

The console is automatically available when running Neolith Enterprise. No separate deployment is required:

```bash
# The console is served at the root path
neolith server start --license /etc/neolith/license.key

# Access the console
open http://localhost:9000/
```

For production deployments behind a reverse proxy, ensure the proxy forwards WebSocket connections (used for real-time monitoring updates) and passes through the required headers for SigV4 authentication.
