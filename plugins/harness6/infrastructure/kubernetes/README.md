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
- `deploy.sh` (slice #46) — deploys the Neo4j community chart (pinned
  5.26.30) and the graphiti-mcp raw manifests in dependency order, waits for
  each rollout, and reports endpoints. Run `bootstrap.sh` first: it needs
  `values-user.yaml` and the `harness6-secrets` Secret. graphiti-mcp Service
  is NodePort **30800** (HTTP `/mcp/` and `/health`); when `ingressClassName`
  is set, `manifests/graphiti-mcp-ingress.yaml.template` is rendered and
  applied as an Ingress on top (Service stays NodePort).
- `manifests/graphiti-mcp.yaml` — raw Deployment + NodePort Service for the
  MCP-only image (no upstream chart). Non-secret env comes from the generated
  `graphiti-env` ConfigMap; secrets from `harness6-secrets`; the entity-type
  schema is mounted from the generated `graphiti-config` ConfigMap
  (infrastructure/config.yaml).
- `tests/run-tests.sh` — offline tests (fake `kubectl`) for the bootstrap
  derivation, validation, and warning logic.
- `values-user.yaml` — **generated**, never committed (see `.gitignore`).

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

## Data protection (Retain)

The Neo4j data PVC uses the cluster's **default StorageClass** by default
(spec #42 user story 8), which on most distributions has
`reclaimPolicy: Delete` — deleting the PVC would drop the Graphiti graph.
The Neo4j community chart (5.26.x) exposes no `reclaimPolicy` knob, so to
get `Retain` protection, create a StorageClass yourself and point the stack
at it:

```sh
kubectl apply -f - <<'EOF'
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: harness6-retain
provisioner: <your-provisioner>   # e.g. kubernetes.io/aws-ebs, rancher.io/local-path (set reclaimPolicy)
reclaimPolicy: Retain
EOF
```

then set `neo4jStorageClass: 'harness6-retain'` in `values-user.yaml` (or in
`values/neo4j.yaml`). `deploy.sh` then provisions the data PVC via the
chart's `dynamic` volume mode against that class. Sizing note (spec #42
story 24): the Neo4j chart forces `requests == limits` (500m/2Gi minimums);
dropping hard limits is not supported by the chart — documented deviation,
recorded in spec #42's Handoffs.

Run the tests before touching the bootstrap script:

```sh
bash tests/run-tests.sh
```
