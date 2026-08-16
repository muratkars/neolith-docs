---
sidebar_position: 2
title: "Neolith vs. Distributed Storage Systems"
---

# Neolith vs. Distributed Storage Systems

CRUSH-style distributed storage systems compute an object's placement from a
cluster map on every read and serve S3 through a gateway layer. Neolith takes
a different shape: a single binary, S3-native from the first byte, with
manifest-authoritative reads.

## At a Glance

| Dimension | CRUSH-style system | Neolith |
|---|---|---|
| **Language** | C++ | Rust |
| **S3 support** | Gateway daemon | Native, first-class |
| **Deployment** | Multiple daemon types | Single binary |
| **Reads** | Placement-function recompute | Manifest-authoritative descriptors |
| **Healing** | Peering + backfill machinery | Idempotent descriptor rewrite |
| **Erasure coding** | Plugin-based RS | RS + LRC, mandatory SIMD |

## The Placement Question

Recomputing placement from a map drifts from reality the moment healing moves
a shard, which is exactly why peering and backfill subsystems exist in such
designs. Neolith records placement in a descriptor at commit time; reads
trust the descriptor, healing rewrites it idempotently, and no peering
protocol is needed.

## Operational Weight

Multi-daemon systems trade operational complexity for extreme flexibility
(block, file, and object from one substrate). If you need object storage with
an S3 interface, Neolith's single-binary model removes cluster-map tuning,
daemon topology planning, and gateway scaling as ongoing concerns.

## When to Choose Which

Choose a distributed storage substrate when you need unified block/file/object
below the same roof. Choose Neolith when the workload is S3 and the priorities
are tail latency, AI-native reads, and operational simplicity.
