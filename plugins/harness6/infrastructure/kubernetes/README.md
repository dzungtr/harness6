# harness6 infrastructure — Kubernetes variant

Kubernetes deployment of the harness6 infrastructure stack (observability,
temporal memory, memsearch), packaged alongside the Compose variant in the
parent directory. Spec: harness6 issue #42; this directory is slice #43's
values/Secrets layer consumed by slices #44–#47.

Layout:

- `values/<stack>.yaml` — per-stack **default** Helm values (SigNoz, Milvus,
  Neo4j) and manifest tuning. Each exposes `namespace` as the top-level
  parameter (single-namespace deployment, default `harness6-system`) and
  `ingressClassName` (empty = NodePort-only; set it to route HTTP endpoints
  via Ingress — OTLP and Milvus gRPC always stay NodePort).
- `bootstrap.sh` — creates the namespace, derives non-secret
  `values-user.yaml` from `infrastructure/.env`, and creates the
  `harness6-secrets` Secret via `kubectl create secret generic` at deploy
  time. Secret YAML with `stringData` is never committed to this repo.
- `tests/run-tests.sh` — offline tests (fake `kubectl`) for the bootstrap
  derivation, validation, and warning logic.
- `values-user.yaml` — **generated**, never committed (see `.gitignore`).
- `deploy-milvus.sh` — installs/upgrades Milvus from the upstream
  `zilliztech/milvus` chart with the bundled etcd + minio subcharts
  (slice #45), waits for rollouts, and prints the auto-assigned NodePort
  for the Milvus gRPC endpoint (19530). PVCs carry the chart's default
  `helm.sh/resource-policy: keep`; the `Retain` reclaim policy itself is
  a StorageClass attribute the chart cannot set — leave it to the
  cluster's default StorageClass.

Secret/derivation contract (consumed by slices #44–#47):

- Secret keys (`harness6-secrets`): `OPENAI_API_KEY`, `NEO4J_PASSWORD`,
  `SIGNOZ_JWT_SECRET`, `SIGNOZ_USER_ROOT_PASSWORD`.
- Derived non-secret values (`values-user.yaml`, flat camelCase):
  `openaiApiUrl`, `memExtractorModel`, `embedderApiUrl`, `embedderModel`,
  `embedderDimensions`, `neo4jDatabase`, `graphitiGroupId`, `semaphoreLimit`,
  `signozIdentnImpersonationEnabled`, `signozIdentnTokenizerEnabled`,
  `signozIdentnApikeyEnabled`, `signozUserRootEmail`,
  `signozUserRootOrgName`.
- LLM/embedder endpoints are plain external URLs from `.env`. `bootstrap.sh`
  warns (does not fail) when `OPENAI_API_URL` or `EMBEDDER_API_URL` contains
  `host.docker.internal` or `localhost` — those are Compose-only values and
  will not resolve from inside the cluster.

Fresh start: no data migration from the Compose stack.

Run the tests before touching the bootstrap script:

```sh
bash tests/run-tests.sh
```
