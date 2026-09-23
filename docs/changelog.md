---
sidebar_position: 100
title: "Changelog"
sidebar_label: "Changelog"
---

# Changelog

All notable changes to Neolith are documented here. Each release includes highlights - not an exhaustive list. See the [GitHub releases](https://github.com/muratkars/neolith/releases) for full commit history.

---

## Unreleased

- **Tier-out of a versioned object (GH #368)**: the current version of a versioning-enabled bucket transitions to a remote tier like any other object, releasing its per-version bytes once the tier holds them, and reads through the record both at its key and by `?versionId=`. Before this the transition's rewrite check looked at a file the version never had, and a GET by version id of a tiered version answered NoSuchKey. See [Lifecycle Rules](./s3-api/lifecycle.md#reading-a-tiered-object).
- **Versioned writes replicate (GH #366)**: a `PutObject` to a versioning-enabled bucket, the delete marker a `DeleteObject` creates, and `DELETE ?versionId=` now reach the object's placement replicas (versions and markers at the write quorum, rolled back when it is not met; version deletes best effort). A replica records every version it receives and moves its current version forward only. Before this, a versioning-enabled bucket's writes lived only on the node that served them, so a `GET` at a peer answered NoSuchKey or an older version. These responses carry `x-neolith-hlc` like every other write. See [Versioning](./s3-api/versioning.md#versioned-writes-in-a-cluster).
- **Write responses carry `x-neolith-hlc`**: `PutObject`, `CopyObject`, `CompleteMultipartUpload` and `DeleteObject` answer with the HLC stamp of the write they performed, the same version authority `GET` and `HEAD` report since GH #353, so a gateway or replication control plane records what it wrote without a follow-up `HEAD`. Omitted on single-node deployments, which stamp no HLC, and on writes to a versioning-enabled bucket, which are node-local today (GH #366). See [Consistency](./architecture/consistency.md#the-x-neolith-hlc-header).
- **Storage class end to end (GH #348)**: `x-amz-storage-class` is validated on `PutObject`, `CopyObject` and `CreateMultipartUpload` (an S3 canonical name, a configured tier target, or a class with an erasure-coding override; anything else is `400 InvalidStorageClass`), carried through multipart uploads to the completed object, and shown by `ListObjects`, `ListObjectsV2`, `ListObjectVersions` and `ListMultipartUploads` instead of a hardcoded `STANDARD`. Lifecycle rules gained `Filter/And/Tag`, `Date` triggers, several `Transition` elements per rule (the deepest fired one applies), `ExpiredObjectDeleteMarker`, and the scanner now acts on `AbortIncompleteMultipartUpload`; `NoncurrentVersionTransition` is refused with `501` instead of being accepted and ignored, and a `Transition` to an unknown class is refused. The listing index records the class per entry, so the first listing of each bucket after the upgrade re-derives that bucket's index once. See [Lifecycle Rules](./s3-api/lifecycle.md#storage-class-names).
- **Read-repair consults every replica (GH #353)**: before serving a clustered `GET`, the node asks every placement replica for its metadata concurrently and takes the newest version by HLC, instead of trusting the first replica that answered; with a replication factor of 3 and a write quorum of 2, a write that landed on the other two replicas is now found whenever the read arrives at the lagging node. The probe is bounded by the read quorum plus a short straggler grace, so one unresponsive replica does not add its full timeout to every read; a newer delete marker found by the probe answers NoSuchKey; `HEAD` runs the same repair; a probe no replica answered serves the local copy unverified and is counted in `neolith_read_repair_probe_failed_total`. `GET` and `HEAD` responses carry `x-neolith-hlc`, the version authority a downstream cache can revalidate on. See [Consistency](./architecture/consistency.md#read-repair).
- **Last-writer-wins at the replica (GH #352)**: an incoming replicated write is applied only if it is newer than the version the replica already holds (journal first, then metadata store); an older or equal one is acknowledged and dropped, counted in `neolith_replicate_stale_dropped_total`, and an older journal copy is tombstoned so journal-first reads serve the newer record. Replicated deletes apply the same rule and now tombstone a journal copy too. Before this a replica kept whichever version arrived last. See [Consistency](./architecture/consistency.md#last-writer-wins-at-the-replica).
- **Reads served from any node (GH #349)**: a `GET` at a node that does not hold an object's bytes reads them from the placement replica that does, over a new holder-side object route that serves stored bytes whole or as the requested range; read-repair reads the newer version's body from the replica instead of leaving a metadata record without a body; batch `GET` no longer skips non-inline objects that live on peers; remote shard reads for reconstruction move only the requested byte window. See [Cluster Architecture](./architecture/cluster.md#reads-at-a-node-that-does-not-hold-the-object).
- **Tiered objects read back at their key (GH #347)**: an object a lifecycle `Transition` moved to a remote S3-compatible tier is served again by a plain `GET`, `HEAD`, range `GET`, batch `GET`, `CopyObject` source and fork read-through; whole and ranged reads of an uncompressed, unencrypted object stream from the tier without buffering. The transition writes the pointer record before it drops the local copy, keeps a write that raced it, never clears the pointer on a later relabel, moves the copy when a later rule names a second tier, and `DELETE` or expiration release the remote copy. A `[[tiers]]` entry for GCS or Azure, an unknown provider, or a missing endpoint or bucket is refused at startup instead of being accepted and then destroying every object it transitioned. Tier failures surface as `503 ServiceUnavailable` (unreachable tier) or `500 InternalError` (tier not configured on this node). See [Lifecycle Rules](./s3-api/lifecycle.md#transitions-and-cloud-tiering).
- **Partition placement exchange (GH #332)**: topology snapshots are stored by placement view and epochs alias them; every node publishes, per partition, every placement view it wrote the partition under, peers fetch the maps and views over the heartbeat, and reads resolve the union of every view a partition was written under plus live. New `[placement] exact_reads` (default off) lets a node drop the pre-exchange safety nets while the exchange is complete for it. See [Placement and Durability](./architecture/placement.md).
- **Retiring a permanently lost drive (GH #328)**: `neolith admin drive retire <index>` re-stripes every stripe that had a shard on a lost `[storage]` drive onto the remaining drives, records the index as retired in the shard-layout manifest, excludes it from placement (cluster-wide, via the topology), and lets later starts run with no drive behind it. Refuses when a stripe is already beyond its parity budget unless forced. See [Configuration](./operations/configuration.md#journal-wal-drive-sharding) and [Admin CLI](./cli/admin.md#drive-commands).
- **Read-path efficiency (GH #326)**: pinned topology snapshots are decoded once per epoch and cached (no disk read per GET, DELETE or batch read), a pin that places like the live topology is skipped, range GETs stream the requested bytes without moving them in memory, and the listing-index warm-up scans the journal's keys once for all buckets. See [Placement and Durability](./architecture/placement.md) and [Server startup](./cli/server.md).
- **Checksum algorithm agreement is enforced at the heartbeat**: each node advertises its `journal.checksum_algorithm` in the gossiped topology, a peer on a different algorithm is fenced offline before any shard is placed on it, and a node that disagrees with all its peers logs an error naming itself. See [Configuration](./operations/configuration.md#journal-checksum-algorithm).
- **Drives carry their journal's identity**: a drive taken from another node and mounted at a new path is refused at startup (naming the journal it belongs to) instead of being adopted as new capacity; drives stamped before this existed are accepted and stamped on the next start. See [Configuration](./operations/configuration.md#journal-wal-drive-sharding).
- **Drive reorders resolve themselves at startup**: the configured `[storage]` drives are put back into the recorded order by drive identity, so a reordered list or a drive re-plugged at another device path boots normally with no data moved; the startup check still refuses a recorded drive that is missing, a shorter list, or two paths with one identity. See [Configuration](./operations/configuration.md#journal-wal-drive-sharding).
- **Cluster epoch advances at runtime**: placement-changing topology events (a peer going offline or returning, confirm-dead, decommission, a split-brain merge) now advance the cluster epoch immediately and persist the new topology snapshot before any write, so reads are pinned to the topology each object was actually placed under. Heartbeats exchange the epoch so it is comparable across nodes. See [Placement](./architecture/placement.md#reads-stay-correct-across-topology-changes).
- **Drive layout is pinned and drive identity is stamped**: the journal's shard-layout manifest now records the ordered `[storage]` drive list (every erasure-coded stripe shard is addressed by its drive's position), and each drive root is stamped with `.neolith/drive-id`. A reorder, insertion, removal, replacement, or physical re-plug that puts a different drive behind a configured path is refused at startup with the affected index and both drives named; appending drives at the end is the supported way to add capacity, and replacing a failed drive uses the `.neolith/accept-as-replacement` marker. See [Configuration](./operations/configuration.md#journal-wal-drive-sharding).
- **Range GET across multipart parts (journal scheme)**: a `Range` request against a multipart-uploaded object now reads only the overlapping part(s) instead of reconstructing the whole object first, for a plain (unencrypted, uncompressed) journal-scheme object. Previously the full object was always assembled and decoded before slicing the response.
- **Re-spread bandwidth throttle**: the automatic background pass that migrates under-protected partitions onto a better placement (`[placement]`) can now be capped by network egress, not just a fixed per-object delay - `respread_bandwidth_limit_bytes_per_sec` scales with object size, so it bounds actual re-spread network load directly. Unset (default) preserves the existing per-object-delay-only behavior. See [Placement & Failure Domains](/docs/architecture/placement).
- **Topology epoch persistence survives a restart**: reads that resolve placement against a partition's pinned write-time topology snapshot (rather than the live, possibly-since-changed topology) now keep working correctly across a server restart. Previously the per-partition epoch cache was in-memory only, so a restart silently fell back to live-topology placement for every already-written partition until it was next written to - a correctness gap for the exact mislocation this mechanism exists to prevent. Internal only, no config surface change.
- **`storage.scheme` defaults to `journal` on single-node deployments**: new deployments (and existing ones that never set `storage.scheme`) get the journal write path by default; multi-node clusters and deployments with server-side encryption keep the `replicated` default (the journal scheme does not yet support multipart uploads with SSE). A boot guard refuses a `replicated` downgrade over existing journal data, with dedicated guidance for the single-node-growing-into-a-cluster case. See [Configuration](./operations/configuration.md#storage).
- **Journal WAL drive sharding (`journal.shard_drives`)**: each commit shard's write-ahead log can land on its own `[storage]` drive (round-robin), removing fsync contention between shards. The shard-to-drive layout is persisted in a manifest at first boot; any later drive-list change that would remap a shard away from its data is refused at startup with the affected shard and both locations named. See [Configuration](./operations/configuration.md#journal-wal-drive-sharding).
- **Internal RPC authentication (`cluster.rpc_token`)**: a shared secret now authenticates the inter-node RPC surface (shard transfer, replication, journal mirror, topology). Unset keeps the previous open behavior with a startup warning. See [Configuration](./operations/configuration.md#cluster).
- **Cluster read resilience**: reads that need a shard from an unreachable peer now degrade to erasure-code reconstruction within seconds (a configurable per-shard read timeout, `cluster.shard_read_timeout_secs`, plus a per-peer circuit breaker) instead of stalling for the full 30-second RPC timeout per missing shard, and background stripe scrubbing no longer runs its repairs on the write-commit path.
- **Large-object writes moved off the commit threads**: PUTs above `journal.max_object_bytes` now erasure-code and write on the requesting task, so large-object throughput scales with client concurrency instead of `commit_shards`, and a client disconnect mid-write can no longer strand a half-written object (the write runs to a clean commit or a clean abort). The new `journal.large_put_concurrency` knob (default 0 = auto, half the CPU parallelism) caps concurrent large-object encodes to bound memory and drive contention under bursts. See [Configuration](./operations/configuration.md#large-object-write-concurrency).
- **`journal.commit_shards` defaults to 2 and is documented**: the #227 commit-path sharding knob now defaults to 2, the bench-sweep frontier value (near-neutral on 4 KiB durable PUTs, +78% on 8 MiB PUTs vs one shard); the measured trade-off curve and the choose-before-first-write rule (the server refuses a value that differs from what an existing journal was written with) are covered in [Configuration](./operations/configuration.md).
- **Batch GET: cluster-mode fetches and honest skip accounting**: batch responses now carry `x-neolith-batch-skipped` so clients can reconcile unserved objects instead of trusting archive size; in cluster mode, keys whose data lives on peer nodes are now fetched from replicas when the data is inline (small objects), and the `content_type` filter resolves remote keys instead of silently dropping them. Cluster listing enumeration no longer stops early at pages consisting entirely of delete markers. The notification dead-letter queue documented on the [Notifications](./s3-api/notifications.md) page is now wired end-to-end (`dlq_enabled`/`dlq_dir` under `[notify]`), and EC-override/pool admin mutations persist atomically before taking effect (a failed persist now returns HTTP 500 and leaves state unchanged). See [Batch Operations](./s3-api/batch-operations.md).
- **I/O engine hardening and failure semantics**: `[io] engine = "auto"` now resolves to the standard engine unconditionally (the ratified post-benchmark default; `uring` remains a fail-fast explicit opt-in), `queue_depth` gains a validated floor of 2, and a persistently failing io_uring reactor now fails all queued I/O loudly, shuts down, and surfaces as HTTP 503 on `/health` so orchestrators restart the process. See [I/O Engine](./architecture/io-engine.md).
- **Docs accuracy pass (cluster config, EC overrides, enterprise replication)**: [Cluster Architecture](./architecture/cluster.md)'s peer-discovery/heartbeat sections described a config schema (`node_id`, `[[cluster.peers]]` with inline zone/rack, a 5s polling/3s-timeout/3-consecutive-failure health model) that never matched the shipped `advertise`/`peers`/`[[cluster.nodes]]` fields, the real `/_neolith/v1/cluster/topology` response shape, or the actual single-failure-marks-offline health logic (no `suspect` state exists) - rewritten against the real config struct and RPC handler. [Erasure Coding](./architecture/erasure-coding.md) and [Configuration](./operations/configuration.md#erasure-scheme-overrides) now document the real per-bucket/storage-class/pool EC-scheme and max-EC-stripe-size admin API (endpoints, request body, precedence, and the LRC-override-is-skipped-not-truncated caveat), which shipped but was never written up. [Replication & Tiering](./enterprise/replication.md)'s cross-site config section described a `[enterprise.replication.sites]` TOML block that isn't real - cross-site policies are managed as runtime `ReplicationPolicy` objects (source/target cell, three conflict-resolution strategies, optional key-prefix scoping), not static config.
- **On-disk listing index is now the only backend**: the listing index stores every bucket's key set as partition-sharded sorted runs on disk instead of keeping every key in RAM, for buckets with tens of millions of objects - bounded memory (fences + blooms + small write buffers), per-shard incremental crash recovery, and listings served straight from the index rows. The earlier in-RAM alternative (`[meta] index = "memory"`) is retired: the memory and rebuild-time gates passed with real margin (26.6x lower resident memory at 1M keys, 34.7x at 10M, both well past the >10x target and improving with bucket size), so there was no case left for keeping two backends. `[meta] index` is no longer a config option. See [Configuration](/docs/operations/configuration).
- **neo client documentation**: the [neo client](./neo/overview.md), Neolith's native command-line client, is now fully documented in a new "neo Client" section covering install and overview, [S3 commands](./neo/s3-commands.md) (`alias`, `cp`, `ls`, `mb`/`rb`, `rm`, `stat`, `sync`, `presign`, `completions`), [Neolith-only commands](./neo/neolith-commands.md) (`batch`, `fork`, `etl`, `dataset`, cross-linked to the underlying server APIs), and [configuration](./neo/configuration.md). `neo` versions independently of the server; the docs previously described it as early-development, and the Quickstart now recommends it as the day-to-day client.
- **Public Docker image**: `ghcr.io/muratkars/neolith` is now published on every merge to main (`latest`) and on releases (semver tags). Built with `etl-wasm` + `iouring`; the web console ships in the enterprise image only. See [Installation](/docs/installation#docker).
- **Release binaries**: tagged releases now attach `neolith-linux-x86_64` and `neolith-linux-aarch64` assets (used by the neolith-k8s Ansible bare-metal deploy).
- **`NEOLITH_ADVERTISE`**: per-node override for `cluster.advertise`, for deployments where all nodes share one config file (Kubernetes ConfigMaps, baked images). See [Configuration](/docs/operations/configuration).
- **Kubernetes deployment tooling**: the new [neolith-k8s](https://github.com/muratkars/neolith-k8s) repo ships the operator, Helm charts, Ansible playbooks, and Terraform modules (Apache 2.0).
- **Distributed LIST**: in cluster mode, `ListObjects`/`ListObjectsV2` now fan out to every online node and merge the results, fixing a correctness gap where a node returned only the objects it stored locally. Merging deduplicates replicas by newest modification time and suppresses deleted keys; if any online peer fails to answer, the LIST returns 503 (`SlowDown`) instead of a silently partial listing. See [Cluster Architecture](./architecture/cluster.md).
- **`[io]` I/O engine config surface**: a rewritten `io_uring` reactor (Linux, opt-in) is now selectable via `[io] engine = "auto"|"standard"|"uring"`, with `queue_depth` and `rings_per_drive` tuning knobs, for the journal's EC shard flush, narrow-path GET read, and group-commit segment writes. `auto` currently resolves to `standard` - the reactor is fully implemented and tested, but hasn't yet shown a measured throughput win over the standard engine for the callers wired so far. See [I/O Engine](/docs/architecture/io-engine) for the architecture and current benchmark status.

---

## v0.6.0 - Limits and Beyond

**Released: 2026-04-25** | **Enterprise update: 2026-04-29**

A hardening release focused on correctness and operability, plus the first Enterprise RDMA transport. Every hardcoded limit in the codebase was audited, 11 were promoted to TOML-configurable values with startup validation, and a new introspection endpoint lets operators inspect all effective limits at runtime. The web console gains multipart upload support for files of any size.

### Highlights

- **Config-driven limits**: 11 previously hardcoded constants are now configurable via TOML. `server.max_body_size_bytes` (raised from 128 MiB to 512 MiB default), `server.max_key_length`, `server.max_tags_per_object`, `server.list_parallelism`, `server.max_clock_skew_seconds`, plus multipart TTL, concurrent uploads, and spill threshold - all tunable per deployment.
- **Limits introspection**: `GET /_neolith/admin/v1/limits` returns 22 effective limits across 7 categories (s3, auth, storage, compression, heal, batch, etl) with source, human-readable value, and reloadable flag.
- **Config validation hardening**: `Config::validate()` now enforces range checks on all configurable limits and cross-field consistency (e.g. spill threshold must not exceed body size). Invalid configs are rejected at startup with descriptive errors.
- **Console multipart upload**: Files >= 64 MiB automatically use S3 multipart upload (CreateMultipartUpload, UploadPart with 4-way concurrency, CompleteMultipartUpload). No more HTTP 413 on large files.
- **Console bug fixes**: 5 bugs fixed in the web console - useState misuse in event notification editor, stale metrics ring buffers on logout, error rate miscounting 3xx as errors, SSE header reading wrong header for SSE-S3, and no-op string replacements in event formatter.
- **Property-based testing**: Added `proptest` and `test-case` for boundary testing. Key length validation, clock skew boundaries, multipart saturation, entropy invariants, and config fuzz testing - all exercised without needing a cluster.
- **Entropy threshold deduplication**: `should_compress()` now accepts a configurable threshold parameter, eliminating a redundant constant that shadowed the TOML config value.
- **Builder consolidation**: `with_server_limits()` and `with_multipart_config()` apply all config-derived limits to `AppState` in a single call, reducing wiring boilerplate.

### Durability & Placement — Architecture Hardening (Phase 28, in progress)

The first milestone of the multi-exabyte architecture-hardening track makes the durability story explicit and configurable. These are foundational, user-facing controls; the replicated journal and erasure-coded data path that build on them are on the roadmap below.

- **Write-ahead durability policy** (`[durability] fsync`, default `true`): every newly created file (object data, tags, version files) **and its parent directory entry** are `fsync`'d before a write is acknowledged, and again after the metadata rename. Closes the acked-write-loss-on-power-failure gap on the single-node and per-replica path. Set `fsync = false` only for throughput-oriented dev/test where durability is not required.
- **Failure-domain placement policy** (`[cluster] placement_policy`, `"pack"` default or `"strict"`): under `strict`, writes that cannot spread across distinct failure domains (zone/rack/host) are refused with `507 Insufficient Storage` rather than silently under-protected. A **startup guardrail** fails fast when `strict` + the configured erasure/replication scheme + cluster size are unsatisfiable, so misconfigurations are caught at boot, not at first data loss.
- **Per-scope erasure scheme resolution**: the effective erasure scheme is now resolved with a defined precedence — **storage-class > bucket > pool > global** — and stamped per object at write time.
- **`replication_factor` wired end-to-end**: the configured `[cluster] replication_factor` is now applied to cluster placement (previously partially unwired).
- **`tolerate` target** (`[placement] tolerate`): declare the failure-domain level shards must spread across to survive losing one domain: `auto` (default), `drive` / `drive:N`, `node`, and (Enterprise) `rack` / `zone`. `auto` picks the coarsest level with at least `parity + 1` distinct instances and never selects rack/zone on OSS.
- **Failure-domain labels** (`[[cluster.nodes]]`): each node can declare its `zone`, `rack`, and `drives`, so placement spreads across racks, zones, and distinct drives. Supersedes `peers` when present.
- **Budgeted spread and balanced fill**: each domain is capped at `ceil(total_shards / domains)` and never more than the parity budget; leftovers fill the least-loaded domain, so 12 shards over 3 racks land 4 / 4 / 4. Selection stays HRW-deterministic, so minimal reshuffle is preserved.
- **Distinct-drive guarantee** (`(node, drive)` placement): placement now resolves each shard to a `(node, drive)` target. When more than one shard of an object lands on a node, each takes a distinct drive, so a single node with `N` drives holds a `k + m <= N` erasure stripe on `k + m` distinct drives and tolerates any `m` drive losses, and a small three-node cluster balances shards over `(node, drive)` pairs. The drive is chosen deterministically (a read resolves the same `(node, drive)` the write chose, over the pinned epoch snapshot), the first shard on a node stays on drive 0 (backward compatible, no migration), and a drive shared by two shards is recorded as drive-under-protected. Whole-object replication is unchanged (one copy per node).
- **Reads correct across topology changes**: partitions are stamped with the cluster epoch and reads resolve over a pinned per-epoch topology snapshot, so adding or removing a node no longer mislocates existing data. Unstamped partitions fall back to recompute-over-live.
- **Protection report**: `GET /_neolith/admin/v1/placement/protection` reports under-protected partitions, the achieved tolerance level, and re-spread candidates. A partition is under-protected when one domain holds more shards than the parity budget OR two shards share one physical drive (`max_per_drive > 1`); each sample now carries `max_per_drive` alongside `max_per_domain` and `domains`.
- **Re-spread migration**: `rebalance start` now migrates under-protected partitions onto their improved placement after you add domains. Loss-free by construction (copy-up to the new placement at quorum, then advance the partition epoch, with no copy deleted), resumable, and a no-op when there is nothing to fix. `rebalance status` reports progress. A throttled background pass (`[placement] respread_interval_secs`, default 300, `0` disables) runs the same migration automatically in cluster mode, with an inter-object throttle so it never starves foreground traffic.
- **Re-spread reclamation** (`[placement] respread_delete_old`, default off): an opt-in delete-old sweep reclaims surplus copies left on nodes no longer in a partition's placement after a re-spread. A copy is deleted only when every node in its new placement confirms a copy at least as new, so the durable copy count never drops below the replication factor; otherwise the copy is kept and retried.
- **Data-residency enforcement** (Enterprise): a bucket pinned to allowed zones/racks (`PUT .../residency`) now actually constrains placement, not just configuration. Residency is applied as a candidate filter before placement runs (constrain-before): an object's copies only land in the allowed domains on write, read-repair, delete, and both the automatic and manual (`rebalance`) background re-spread. A write whose allowed domains cannot meet the durability policy is rejected with `507 Insufficient Storage`. Previously the residency config was stored but never enforced. Set residency before storing data (changing it on a bucket with existing data needs a rebalance); applies to the replicated storage scheme. See [Compliance](./enterprise/compliance.md#residency-enforcement).
- **Data-residency config validation** (Enterprise): `PUT .../residency` now validates the config at set time and rejects it with `400 Bad Request` if it is malformed (blank, whitespace-padded, or duplicate labels) or names a `zone`/`rack` that no `[[cluster.nodes]]` entry declares, so a typo (for example `eu-west-1z`) is caught at configuration time instead of silently making the bucket unwritable. Constraining a dimension the cluster declares no labels for is likewise rejected (it would leave the bucket unwritable); leaving a dimension's allow-list empty means unconstrained, so a drive- or node-level-only cluster simply sets no zone/rack residency. See [Compliance](./enterprise/compliance.md#bucket-level-residency).
- **Cross-node journal replication** (`storage.scheme = "journal"`, opt-in and experimental): in a cluster, each group-commit batch is now replicated to the segment's peers and acknowledged only once it is durable on a write quorum (`replication_factor / 2 + 1` copies, counting the local one). A peer that is down or slow is tolerated up to the quorum margin; below quorum the write is refused rather than acked. Single-node deployments are unaffected.
- **Multipart uploads as erasure-coded segments** (`storage.scheme = "journal"`, opt-in and experimental): when the journal scheme is on, each multipart part is erasure-coded into its own stripe as it arrives (durable before complete, so an in-flight upload survives a restart), and `CompleteMultipartUpload` stitches the chosen part stripes into one multi-stripe object with no whole-object reassembly buffer. Reads return the parts concatenated; abort and TTL expiry free the staged stripes; re-uploading a part replaces it (last write wins). The default replicated path is unchanged.
- **Stripe compaction** (`journal.compaction_min_live_ratio`, default 0.5; opt-in journal scheme): the journal's stripe-reclamation sweep frees an EC stripe only once every object in it is dead, so an overwrite/delete-heavy workload left mostly-dead stripes pinning their full shard footprint. A background pass now re-packs a sparse stripe (live bytes below `compaction_min_live_ratio * stripe_len`) into a fresh dense stripe, after which the old stripe is fully dead and reclaimed. Set the ratio to `0.0` to disable. The maintenance pass runs flush, then compact, then reclaim.
- **S3 behavior verified on the journal scheme** (`storage.scheme = "journal"`, opt-in and experimental): object tagging (`PUT`/`GET`/`DELETE ?tagging`), server-side copy (`x-amz-copy-source`), and `UploadPartCopy` now work for objects that live in the journal. They previously returned `404 NoSuchKey` because they consulted only the meta store, where a journaled object never lives. Range GET, conditional requests, SSE-C, user metadata, and Content-MD5 validation are confirmed to behave identically to the replicated layout. A versioning-enabled bucket continues to write through the meta store (the journal holds no version history), so enabling versioning opts a bucket out of the journal path by design.
- **Object metadata on GET** (all storage layouts): `GET` dropped `x-amz-meta-*` user-metadata headers and `x-amz-storage-class` for objects that carried them, because the response fast path built a metadata stub without them (`HEAD` was unaffected). `GET` now returns the same user metadata and storage class as `HEAD`.
- **Journal/meta-store consistency on overwrite and delete** (`storage.scheme = "journal"`, opt-in and experimental): with the journal scheme a key can transiently exist in both stores, and writes/deletes now keep them reconciled so journal-first reads never serve a stale or deleted object. Overwriting a journaled object with one that routes to the meta store (a larger object, a copy destination, or a write to a now-versioned bucket) tombstones the superseded journal entry; deleting an object that had been overwritten across the small-object size boundary no longer resurrects the old copy; bulk `DeleteObjects` now actually removes journal-resident objects (previously a silent no-op that left them readable); and a delete marker on a journaled object correctly hides it on the latest GET. Single-node and the default replicated path are unaffected.
- **Journal EC stripe scrub** (`journal.scrub_interval_secs`, default 86400; opt-in journal scheme): the metadata-store heal scanner does not see the erasure-coded stripes that the journal flusher produces, so those stripes had no proactive repair and lost shards accumulated toward the parity budget unrecovered. A background pass now verifies every live stripe's shards against their manifest BLAKE3 checksums and regenerates any missing or bitrotten shard via Reed-Solomon decode, writing it back to its recorded location. A stripe that has lost more than its parity budget is reported unrecoverable and left untouched; a shard that fails to read with a non-"not found" error (a failing drive) is counted as a scrub error rather than a lost shard, so a flaky disk does not inflate the unrecoverable count. Each pass walks the live set in bounded chunks with a stripe-id cursor, so the maintenance thread returns to serving writes between chunks rather than being held for the whole corpus. Four metrics track each pass (`neolith_journal_stripe_scrub_stripes_total`, `neolith_journal_stripe_shards_repaired_total`, `neolith_journal_stripe_unrecoverable_total`, `neolith_journal_stripe_scrub_errors_total`; alert on the last two). Runs on the journal maintenance thread after flush, compact, and reclaim; the interval is validated to be `0` (disabled) or at least `segment_max_age_secs`. See [Healing](./operations/healing.md#journal-ec-stripe-scrub-experimental).
- **Journal stripe reads verify shard checksums** (opt-in journal scheme): a flushed-object read now checks each EC stripe shard against its recorded BLAKE3 checksum and excludes any corrupt shard before Reed-Solomon decode. Previously a present-but-bitrotten shard was decoded as-is, which could return silently corrupted bytes; reads now reconstruct correct data from the surviving shards, or fail loud with `InsufficientShards` if too few healthy shards remain, never returning corrupt data. Complements the background stripe scrub (which repairs on a cadence) with read-time integrity. See [Healing](./operations/healing.md#journal-ec-stripe-scrub-experimental).
- **New documentation**: see [Placement and Durability](./architecture/placement.md) for the failure-domain model, the `tolerate` target, and re-spread, and [Deployment Topologies & Minimums](./operations/deployment-topologies.md) for drive/node minimums per topology and what each topology survives.

### Enterprise: S3 over RDMA / RoCEv2 (Phase E - complete)

RDMA-1 through RDMA-3 shipped with the initial v0.6.0 release (2026-04-25). RDMA-4 and RDMA-5 shipped in the Enterprise update (2026-04-29). All 5 RDMA features are complete.

- **neolith-rdma crate**: New `neolith-rdma` enterprise crate implementing the full RDMA/RoCEv2 transport layer. `RdmaManager` provides `pull_from_client` (PUT - RDMA READ) and `push_to_client` (GET - RDMA WRITE) with transparent TCP fallback.
- **Dual-transport architecture**: HTTP/S3 control plane always available; RDMA data plane activated per-request via `x-neolith-rdma-*` headers. Standard AWS SDKs continue to work unchanged on the TCP path.
- **Per-cell configuration**: Enable RDMA per cell via environment variables (`NEOLITH_RDMA_ENABLED=true`) or Kubernetes CRD (`spec.network.rdmaEnabled: true`). Cells without RDMA enabled are unaffected.
- **Automatic TCP fallback**: `NEOLITH_RDMA_FALLBACK_TCP=true` (default) — any RDMA setup failure silently falls back to the HTTP body path. Set to `false` only in validated environments.
- **ibverbs integration**: Full QP lifecycle support (INIT→RTR→RTS) via `IbverbsTransport` on Linux + `rdma` feature. `MockRdmaTransport` on all other platforms for development and testing.
- **MR pool**: Pre-registered memory region pool (default 512 MiB). Set `NEOLITH_RDMA_MR_POOL_MB=0` to use On-Demand Paging (ODP) on ConnectX-4 Lx or newer.
- **Admin API**: `GET /_neolith/admin/v1/rdma/status`, `GET /_neolith/admin/v1/rdma/devices`, `POST /_neolith/rdma/connect`, `POST /_neolith/rdma/disconnect/{id}`.
- **Prometheus metrics**: 11 new RDMA metrics covering bytes transferred, operation counts, fallback reasons, QP state, MR pool utilization, and CQ overflows.
- **Minimum object threshold**: Objects below `NEOLITH_RDMA_MIN_OBJ_KB` (default 256 KiB) always use TCP — RDMA setup overhead is not worth it for small objects.
- **KV Cache RDMA Transport** (RDMA-4, AI tier): `BlockTransport` trait with `get_block`/`put_block`/`is_rdma`. `HttpBlockTransport` (reqwest) and `RdmaBlockTransport` (Arc\<RdmaManager\>, lazy QP connect, auto-fallback to HTTP). `TransportKind` enum dispatch. `KvRdmaConfig` in `KvConfig`. `G4Prefetcher` upgraded with `with_rdma()` constructor.
- **GPU-Direct RDMA wiring** (RDMA-5, AI tier): `IbverbsGpuEngine` implements `GpuDirectEngine` via `Arc<RdmaManager>` (RDMA READ/WRITE + file I/O fallback). `GpuEngineKind::select()` fallback tower (ibverbs → mock). `GpuTopology::discover()` with `nic_affinity_score()` + `best_gpu_for_nic()`. Linux x86_64/aarch64 cfg-gate.

### Breaking Changes

- `server.max_body_size_bytes` default changed from 128 MiB to 512 MiB. If you relied on the old 128 MiB limit to restrict upload sizes, set `max_body_size_bytes = 134217728` in your config.
- `neolith_compress::should_compress()` now takes a third parameter (`entropy_threshold: f64`). Use `neolith_compress::DEFAULT_ENTROPY_THRESHOLD` to preserve the old behavior.
- `neolith_s3::build_router()` now reads `state.max_body_size_bytes` instead of using a hardcoded constant. No change needed if you use the standard server startup path.

### New Crates

- **neolith-rdma**: RDMA/RoCEv2 transport layer with `RdmaManager`, `IbverbsTransport`, `MockRdmaTransport`, and Prometheus metrics (Enterprise)

### Docs

- All user-facing CLI examples migrated from aws-cli to mc (S3-compatible CLI). Use `mc alias set myn http://localhost:9000 KEY SECRET` to configure the `myn` alias; every `aws --endpoint-url` command in the quickstart, S3 API reference, and use-case guides has a direct mc equivalent. SSE-C, CORS, S3 Select, multipart low-level, and object-lock examples retain aws s3api (no mc equivalent for those operations).

### Stats

- 120/120 OSS features complete (Phase 28 architecture hardening ongoing)
- 59/60 Enterprise features complete (all 5 RDMA features shipped)
- 1,025+ tests, zero clippy warnings

---

## v0.5.0 - Fork You Very Much

**Released: 2026-04-05**

Bucket forks and event notifications - the features that set Neolith apart. Forks bring zero-copy branching to object storage (a first for self-hosted systems), and notifications make Neolith a reactive building block in data pipelines.

### Highlights

- **Bucket forks**: zero-copy branching with `PUT /{bucket}?fork={source}`. Fork, modify, diff, and merge - all without copying data at creation time. Copy-on-write semantics, mask-based deletes, and full lifecycle management (Active, Merged, Detached).
- **Fork diff and merge**: `GET ?fork-diff` computes added/modified/deleted keys between fork and source. `POST ?fork-merge={target}` applies changes back to any bucket.
- **S3 event notifications**: emit events on PUT, COPY, DELETE, and CompleteMultipartUpload. Per-bucket rules with prefix/suffix filters and wildcard event matching.
- **Multiple delivery destinations**: Webhook (HTTP POST with auth and custom headers), File (JSONL append), Stdout, and NATS (feature-gated). AMQP and Kafka config stubs for future implementation.
- **Dead letter queue**: failed events are persisted as JSONL for inspection and replay. Append-only, grep-friendly format.
- **Config Admin API**: `GET/PUT /_neolith/admin/v1/config` for runtime configuration management. CLI commands: `neolith admin config get/set/export/import`.
- **Object browser enhancements**: detail drawer with metadata display, inline preview (images, video, audio, PDF, JSON with syntax coloring, CSV as table, plain text), tag management, and version history timeline.

### New Crates

- **neolith-notify**: event notification engine (1,240 LOC, 39 tests)
- **neolith-fork**: bucket fork operations (32 tests)

### Stats

- 85/85 OSS features complete
- 928+ tests, zero clippy warnings

---

## v0.4.0 - Revenge of the Dashboard

**Released: 2026-03-09**

The web console arrives. Neolith is no longer CLI-only - you get a full browser-based dashboard with bucket management, object browsing, user administration, and real-time metrics.

### Highlights

- **Web Console v1**: React 18 + TypeScript + Tailwind v4, embedded as a single-page app via `rust-embed`. Eight modules: Dashboard, Buckets, Objects, Users, Login, Settings, FeatureGate, and Layout.
- **Console backend**: JWT HS256 authentication, embedded SPA serving, API proxy to S3 endpoints. `build_console_router()` integrates with the main server.
- **Bearer JWT auth for S3 API**: `ConsoleSessionValidator` trait allows Bearer tokens alongside SigV4 authentication, enabling the console to call S3 endpoints directly.
- **Bucket policy**: JSON-based bucket policies with `PUT/GET/DELETE /?policy`. Wildcard matching for principals, actions, and resources.
- **POST Object**: browser form upload support with policy validation and PUT pipeline delegation.
- **Static website hosting**: per-bucket `.website.json` configuration with index documents, error documents, and redirect rules.
- **Config hot-reload**: SIGHUP signal handler and `notify` file watcher for live config updates. Reloadable: TLS certs, credentials, log level, rate limits, notification settings.
- **User metadata**: `x-amz-meta-*` headers on PUT are stored and returned on HEAD/GET.
- **S3 router fix**: `.fallback_service(s3_router)` prevents S3 wildcard routes from capturing console and admin paths.

### New Crates

- **neolith-console**: embedded SPA backend with JWT auth (17 tests)

### Stats

- 68/68 features (at time of release), 809 Rust tests + 17 console tests + 27 conformance + 22 Python
- Zero clippy warnings

---

## v0.2.1 - The Need for Speed

**Released: 2026-03-03**

A performance-focused release delivering 13 optimizations identified during architectural review. No new features - just making everything faster.

### Highlights

- **PUT hot-path optimization**: `try_compress()` single-pass check+compress+size guard replaces two-pass `should_compress` + `compress`. Dual-hash MD5+BLAKE3 in a single pass.
- **Zero-copy PUT body**: store functions accept `&[u8]` directly, eliminating one full `body.to_vec()` allocation per PUT.
- **Copy object shortcut**: skip decompress/recompress when possible - decrypt source, re-encrypt dest, clone ETag and compression metadata.
- **Block-aligned encrypted Range GET**: `decrypt_range()` decrypts only the needed AEAD 64KB blocks instead of the full object.
- **Listing cache persistence**: save/load via bincode with atomic temp+rename. Cache survives server restarts.
- **Lock-free caches**: `DashMap` for `ListingCache` outer map and ETL transform cache, replacing `RwLock<HashMap>`.
- **Multipart parts spill to disk**: parts >= 1 MiB are written to temp files instead of held in memory, reducing memory pressure during large uploads.
- **BLAKE3 128-bit XOF direct output**: use `finalize_xof().fill()` instead of truncating the full 256-bit hash.
- **Batch fetch concurrency bounds**: Semaphore(32) in `ObjectFetcher` prevents unbounded parallel fetches.
- **RPC connection pool tuning**: `pool_max_idle_per_host` increased to 64, `pool_idle_timeout` set to 90s across all RPC client builders.

---

## v0.2.0 - The Blob Strikes Back

**Released: 2026-03-02**

Scaling beyond single-node with LRC erasure coding and pool-based online expansion. Day-2 operations get a proper admin CLI. This release also delivers the full v0.3 feature set: consistency, versioning, and operational readiness.

### Highlights

- **LRC erasure coding**: `LrcCodec` wraps global Reed-Solomon with per-group local parity. Standard ratios: (10,4,2,5) and (12,3,3,4). Local repair reads only ~25% of shards for single-shard failures.
- **Pool-based online expansion**: `PoolStore` with `.neolith/pools.json` sidecar. Add storage pools without downtime via CRUD admin endpoints and CLI.
- **Admin CLI and API**: `neolith admin heal/rebalance/pool` commands, `/_neolith/admin/v1/` REST API, edition gating with upsell messaging.
- **io_uring I/O engine**: `IoUringEngine` with dedicated OS thread and `mpsc` channel. Feature-gated behind `iouring`, Linux-only. Auto-detection falls back to `StandardEngine`.

### Consistency and Write Safety

- **Write quorum**: fan-out replicate to N/2+1 nodes, rollback on failure, orphan shard GC.
- **HLC-based consistency**: 64-bit hybrid logical clock (48ms physical + 16 logical), write ordering, read-repair, split-brain detection and merge.
- **Disk-full handling**: pre-write statvfs check with 1 GB reserve, ENOSPC catch-on-write returns 507.
- **Orphan scanner**: background cleanup of stale `.tmp` files older than 5 minutes.

### Versioning, Auth, and Encryption

- **Object versioning**: UUID v4 version IDs, delete markers, list versions, `v/` subdirectory storage layout.
- **Lifecycle rules**: S3-compatible expiration with days-based rules, noncurrent version expiration, prefix+tag filtering, 1-hour background scanner.
- **SSE-C encryption**: customer-provided keys with AES-256-GCM, MD5 validation, copy support with source and destination SSE-C headers.
- **STS temporary credentials**: `ASIA`-prefixed temporary access keys, session tokens, 900-43200s configurable duration, background cleanup task.

### Testing

- **Chaos testing framework**: `neolith-chaos` crate with 22 tests covering heal, HLC, topology, orphan GC, EC, and concurrency scenarios.
- **Performance regression CI**: offline benchmark suite with compare CLI, `bench.yml` GitHub Actions workflow, 15%/20% regression thresholds.

### New Crates

- **neolith-admin**: admin API and CLI (700 LOC, 34 tests)
- **neolith-chaos**: chaos testing framework (22 tests)

---

## v0.1.0 - Let There Be Blobs

**Released: 2026-02-28**

The initial release of Neolith. A complete S3-compatible object storage server in a single binary, with erasure coding, encryption, authentication, clustering, healing, batch APIs, ETL transforms, and a PyTorch SDK.

### Highlights

- **Single-binary server**: TOML config, graceful shutdown, Axum HTTP/2, single port 9000.
- **S3 API core**: PUT, GET, HEAD, DELETE, LIST (v2), multipart upload (6 endpoints), presigned URLs.
- **Erasure coding**: Reed-Solomon with mandatory SIMD (AVX2/NEON), BLAKE3 checksums, streaming 1MB chunk encode.
- **Per-shard metadata**: FlatBuffer v2 on-disk format with `MetaView` zero-copy access for LIST/HEAD hot paths. Bincode v1 backward compatibility with lazy migration.
- **Compression**: LZ4 and zstd with 3-stage smart skip (entropy detection).
- **SSE-S3 encryption**: AES-256-GCM with 64KB AEAD blocks, HKDF per-object DEK, aws-lc-rs.
- **SigV4 authentication**: full signature verification with constant-time comparison. IAM policies with deny-overrides-allow and wildcard matching.
- **Multi-node cluster**: TCH placement with HRW hashing, failure-domain spread, HTTP/2 RPC, heartbeat polling.
- **Healing engine**: on-read + reactive heal, priority queue (criticality > hotness > age), parallel shard I/O via JoinSet, 30-day background scanner, exponential backoff retry.
- **Batch GET API**: TAR+LZ4/zstd format, Fisher-Yates shuffle for ML training, epoch-based streaming with `PrefetchPipeline` and Semaphore memory budget.
- **ETL engine**: native + WASM (Wasmtime, feature-gated) transforms. Three built-in: identity, checksum-blake3, to-json-meta. BLAKE3-keyed LZ4 disk cache with LRU eviction.
- **PyTorch SDK**: `NeolithDataset` (IterableDataset), thread-based prefetch, manual POSIX ustar TAR parsing, LZ4 decompression.
- **Prometheus metrics**: `/metrics` endpoint with request counters, latency histograms, and storage gauges.
- **TLS**: rustls TLS 1.3 only, mTLS support via `WebPkiClientVerifier`, TLS-aware RPC client.
- **Benchmarks**: HdrHistogram latency tracking, Semaphore-based concurrency, iterative binary search for key discovery.
- **S3 completeness**: byte-range GET, copy object, conditional requests (If-Match/None-Match/Modified-Since), virtual-hosted-style addressing, CORS, tagging, request IDs, Content-MD5 validation, Unicode NFC key normalization, streaming LIST.

### New Crates

- **neolith-common**: shared types, errors, config
- **neolith-meta**: per-shard FlatBuffer metadata, listing cache, MetaView
- **neolith-ec**: Reed-Solomon erasure coding with SIMD
- **neolith-compress**: LZ4/zstd compression with smart skip
- **neolith-rio**: I/O engine abstraction
- **neolith-crypto**: AES-256-GCM encryption
- **neolith-s3**: S3 API handlers
- **neolith-iam**: SigV4 auth and IAM policies
- **neolith-batch**: batch GET and epoch-based streaming
- **neolith-etl**: WASM transform engine and cache
- **neolith-cluster**: TCH placement, RPC, heartbeat
- **neolith-heal**: healing engine with priority queue
- **neolith-metrics**: Prometheus metrics
- **neolith-server**: main binary
- **neolith-bench**: benchmark tool

### Stats

- 20 core features across 13 phases
- 809 Rust tests + 27 conformance tests + 22 Python tests
- 18.7 MB release binary, 11.4 MB idle memory, 16ms startup time
