# 8. Kubernetes variant of the infrastructure stack: upstream charts own internal topology; compose parity dropped at the infra-component level

Date: 2026-09-21

## Status

Accepted

## Context

harness6's shared infrastructure (SigNoz observability, Graphiti temporal memory,
memsearch, and their stores) was delivered exclusively as a Docker Compose deployment
(ADR 0004). Users with a Kubernetes cluster — homelab or internal dev — could not run
the stack in-cluster and had to fall back to host Docker, which also limited where the
stack could live (container port publishing vs NodePort/Ingress).

The Compose stack was built as a curated, hand-wired topology: ClickHouse with vendored
config XMLs (`infrastructure/signoz/clickhouse/*.xml`), the `histogramQuantile` UDF
init job, and SigNoz internals wired by hand. Porting that topology 1:1 into Kubernetes
would have meant maintaining a second, hand-built copy of the same internals.

## Decision

Deliver the Kubernetes variant under `infrastructure/kubernetes/` with **upstream Helm
charts owning each stack's internal topology** — Milvus from `zilliztech/milvus` with
its bundled etcd + minio subcharts, Neo4j from the community chart, SigNoz from
`SigNoz/charts` (pinned to chart 0.129.0 for app-version parity with Compose), whose
chart manages ClickHouse, zookeeper, the schema migrator, users, and ships the
`histogramQuantile` UDF init container natively. Only `graphiti-mcp` (the MCP-only
image with no upstream chart) is a raw Deployment/Service manifest. harness6 owns just
the values layer (per-stack `values.yaml` + generated `values-user.yaml` derived from
`infrastructure/.env`), deploy-time Secrets (`kubectl create secret generic` — never
committed Secret YAML), a single `harness6-system` namespace, NodePort exposure, and
deploy ordering/health gates.

**Compose parity is intentionally dropped at the infra-component level.** The vendored
ClickHouse XMLs are not carried over; the charts' managed topology is accepted as the
source of truth in-cluster. Parity is kept at the **behavioral** level: same SigNoz app
version, same secret/value sources (`.env`), same user-facing capabilities. Data does
not migrate between the two variants; each starts fresh.

## Considered Options

**Port the vendored ClickHouse configs and hand-build SigNoz internals in-cluster.**
Rejected: duplicates the maintenance burden of the Compose topology in a second
manifest set, drifts on every SigNoz upgrade, and re-implements what the chart already
owns (UDF init container, migrator, cluster topology). Do not re-introduce vendored
ClickHouse XMLs or hand-built internal topology on the Kubernetes path.

**Kustomize packaging.** Rejected: the values layer is a small, reviewable flat
directory (per-stack `values.yaml`); Kustomize overlays add ceremony without
multi-environment need (single parameterized namespace only).

## Consequences

- Chart internals are maintained upstream; upgrades are chart-bump-and-values reviews,
  not manifest surgery. The chart release pin must be verified against the SigNoz app
  version at upgrade time.
- The charts' own constraints apply: e.g. the Neo4j community chart forces
  `requests == limits` and exposes no `reclaimPolicy` knob — `Retain` protection for
  the Graphiti PVC requires a user-provided StorageClass
  (`infrastructure/kubernetes/README.md`).
- Two delivery surfaces (Compose and Kubernetes) must both be considered when changing
  stack-wide behavior; the shared contract is `infrastructure/.env` plus the
  documented secret/derivation keys.
- Fresh start only: no Compose→K8s data migration; memsearch collections are rebuilt
  by re-running memsearch-init against the cluster's Milvus NodePort.
