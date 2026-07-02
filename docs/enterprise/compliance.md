---
sidebar_position: 4
title: "Compliance"
---

# Compliance

Neolith Enterprise's `neolith-compliance` crate provides regulatory compliance features including Object Lock (WORM), data retention policies, legal hold, and GDPR-aligned data residency controls.

## Object Lock (WORM)

Object Lock implements Write-Once-Read-Many (WORM) storage semantics, preventing objects from being deleted or overwritten for a specified retention period. This is required for regulatory compliance with SEC Rule 17a-4(f), FINRA, MiFID II, and other financial regulations.

### Retention Modes

Neolith supports two retention modes, matching the S3 Object Lock specification:

| Mode | Behavior |
|---|---|
| **Governance** | Prevents deletion by normal users. Users with `s3:BypassGovernanceRetention` permission can override the lock. Suitable for internal data governance. |
| **Compliance** | Prevents deletion by all users, including the root account. The retention period cannot be shortened. Required for SEC 17a-4(f) and similar regulations. |

### How It Works

1. **Enable Object Lock on bucket creation**: Object Lock must be enabled when the bucket is created. It cannot be added to an existing bucket.
2. **Set default retention**: A bucket-level default retention policy (mode + period) is applied to all objects unless overridden per-object.
3. **Per-object retention**: Individual objects can have their own retention mode and period, set via `x-amz-object-lock-mode` and `x-amz-object-lock-retain-until-date` headers.

```bash
# Create a bucket with Object Lock enabled
aws s3api create-bucket \
  --bucket compliance-records \
  --object-lock-enabled-for-object-lock-configuration \
  --endpoint-url http://localhost:9000

# Set default retention: Compliance mode, 7 years
aws s3api put-object-lock-configuration \
  --bucket compliance-records \
  --object-lock-configuration '{
    "ObjectLockEnabled": "Enabled",
    "Rule": {
      "DefaultRetention": {
        "Mode": "COMPLIANCE",
        "Years": 7
      }
    }
  }' \
  --endpoint-url http://localhost:9000
```

### Versioning Requirement

Object Lock requires versioning to be enabled on the bucket. When an object is "deleted" in a versioned bucket with Object Lock, a delete marker is created but the locked version remains protected. The actual data version cannot be permanently deleted until the retention period expires.

## Legal Hold

Legal hold is an indefinite retention flag that can be applied to or removed from any object version, independent of the retention period. It is used when data must be preserved for litigation or investigation, often with no predetermined end date.

```bash
# Place a legal hold
aws s3api put-object-legal-hold \
  --bucket compliance-records \
  --key financial-report-2025.pdf \
  --legal-hold '{"Status": "ON"}' \
  --endpoint-url http://localhost:9000

# Remove a legal hold (requires s3:PutObjectLegalHold permission)
aws s3api put-object-legal-hold \
  --bucket compliance-records \
  --key financial-report-2025.pdf \
  --legal-hold '{"Status": "OFF"}' \
  --endpoint-url http://localhost:9000
```

An object under legal hold cannot be deleted even if its retention period has expired. Both the legal hold and retention period must be cleared/expired before the object can be deleted.

## Data Retention Policies

Beyond Object Lock, Neolith supports lifecycle-based retention policies for general data governance:

| Policy Type | Description |
|---|---|
| **Minimum retention** | Objects cannot be deleted before a minimum age |
| **Maximum retention** | Objects are automatically deleted after a maximum age (data minimization) |
| **Transition retention** | Objects transition to cold storage after a specified age, with a separate deletion age |

These policies are configured via the lifecycle API and enforced by the background lifecycle scanner:

```json
{
  "Rules": [
    {
      "ID": "gdpr-data-minimization",
      "Filter": {"Prefix": "user-data/"},
      "Status": "Enabled",
      "Expiration": {"Days": 730},
      "NoncurrentVersionExpiration": {"NoncurrentDays": 90}
    }
  ]
}
```

## GDPR Data Residency

Neolith Enterprise supports data residency controls to help meet GDPR, data sovereignty, and cross-border data transfer requirements:

### Tenant-Level Residency

In multi-tenant mode, each tenant can be restricted to specific storage cells that map to geographic regions:

```toml
[tenant.eu-customer]
cells = ["cell-eu-west-1", "cell-eu-central-1"]
# Data for this tenant will ONLY be stored in EU cells
# Replication is restricted to cells in the allowed regions
```

### Bucket-Level Residency

Individual buckets can be pinned to a set of failure domains (zones and/or racks). Placement then only ever stores that bucket's replicas within the allowed domains:

```bash
# Pin a bucket to specific zones (and optionally racks)
curl -X PUT http://localhost:9000/_neolith/admin/v1/buckets/eu-data/residency \
  -H "Content-Type: application/json" \
  -d '{
    "allowed_zones": ["eu-west-1a", "eu-west-1b"],
    "allowed_racks": []
  }'
```

An empty list for a dimension leaves it unconstrained (allow-all).

The request is validated at set time and rejected with `400 Bad Request` if it is malformed or names a domain the cluster does not declare, so a typo cannot silently make the bucket unwritable:

- **Structural:** blank/whitespace-only entries, entries with leading or trailing whitespace, and duplicates within a list are rejected (placement matches labels verbatim, so a padded label would never match a node).
- **Existence:** when you constrain a dimension (a non-empty `allowed_zones`/`allowed_racks`), every value must match a label declared in `[[cluster.nodes]]`. A value no node carries (for example `eu-west-1z` instead of `eu-west-1a`) is rejected, and the error lists the declared labels. Constraining a dimension the cluster declares **no** labels for is also rejected, because pinning to a domain no node carries would make the bucket unwritable. Leaving a dimension's allow-list empty means "unconstrained", so a drive- or node-level-only cluster simply sets no zone/rack residency.

This is a best-effort set-time check, not a durable guarantee. The declared labels are read from `[[cluster.nodes]]` once at startup (the same source placement uses), so a label added to the topology later is rejected until the receiving node restarts, and the topology can change afterward (for example every node of an allowed zone is decommissioned), which the placement path still handles by refusing writes it cannot satisfy. Validation runs only when you set the config through the API: a pre-existing or hand-edited `.residency.json` sidecar is loaded as-is.

> **Important:** enforcement is fail-closed. A node that does not carry a constrained label is treated as not allowed (its residency cannot be confirmed). If a bucket ends up pinned to a `zone`/`rack` value that no cluster node carries (for example nodes were later redeployed without that label), **every** node becomes ineligible: new writes to the bucket are rejected and its existing objects become unreadable (reads and deletes resolve within the same allowed domains). Set-time validation catches this at configuration time for labels the topology already declares; still set residency to labels your `[[cluster.nodes]]` topology actually declares, and set it before storing data.

### Residency Enforcement

Residency is enforced as a placement candidate filter (constrain-before, not a post-hoc reject): the allowed zones/racks restrict the candidate nodes before placement runs, so an object's copies only ever land in allowed domains.

1. **Write**: placement is restricted to the bucket's allowed domains. If those domains cannot satisfy the durability policy (replication factor and spread), the write is rejected with `507 Insufficient Storage`.
2. **Read-repair and delete**: resolve the replica set within the same allowed domains, so they always reach the actual copies.
3. **Background re-spread**: both the automatic re-spread pass and the manual `admin rebalance` stay within the allowed domains, so background migration never moves a pinned bucket out of its region.
4. **Audit**: residency configuration changes are recorded in the tamper-evident audit log.

Notes and limitations:

- **Set residency before storing data.** Changing a bucket's residency after it already holds objects requires a migration (rebalance); until that runs, reads and deletes of objects placed under the previous policy may not resolve correctly.
- **Scope**: applies to the replicated storage scheme (the default). The experimental journal scheme and the future cross-node erasure-coded path are handled separately.

## Compliance Reporting

Neolith Enterprise generates compliance reports for auditors:

| Report | Content |
|---|---|
| **Retention report** | All objects under retention, their mode, and expiry date |
| **Legal hold report** | All objects under legal hold, who placed the hold, and when |
| **Residency report** | Data distribution by region, any residency constraint violations |
| **Access report** | Who accessed what data, when, and from where (from audit log) |

Reports are generated on demand via the Admin API or on a schedule via the Web Console:

```bash
# Generate a retention compliance report
curl http://localhost:9000/_neolith/admin/v1/compliance/reports/retention \
  -H "Accept: application/json"
```

## Configuration

```toml
[enterprise.compliance]
enabled = true
default_retention_mode = "GOVERNANCE"
default_retention_days = 365
enforce_versioning_on_lock = true

[enterprise.compliance.gdpr]
enabled = true
default_max_retention_days = 730  # 2 years
require_residency_on_tenant_create = true
```
