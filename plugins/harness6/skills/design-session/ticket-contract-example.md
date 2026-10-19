# Ticket exemplar — Design contract section

A real ticket written in the required shape: kape [#263](https://github.com/dzungtr/kape/issues/263), produced by the design session of 2026-10-19 (spec #261, origin #260) and rewritten to this format afterwards. Match this shape when writing tickets. The Matt Pocock sections (Parent / What to build / Acceptance criteria / Blocked by) are unchanged; the `Design contract` section is what this skill adds.

---

## Parent

#261 (spec) · origin #260

## What to build

The full vertical of the new declarative path, without credentials. CRD API types carrying the **complete v0 schema** (all five spec groups — `controller`, `sandbox`, `modelGateway`, `credentials[]`, `network` — plus `description` and per-credential status conditions; credentials are reconciled in a later ticket but the schema ships now to avoid a CRD rev) with CEL validation (host-pattern syntax, unique credential names, same-namespace secretRef). Operator gains the `KapeAgentServer` reconciler: a **pure renderer** mapping CR → desired state (controller Deployment env + network resources), and a controller-runtime apply loop. Controller serves `KAPE_SERVER_DESCRIPTION` as MCP server `instructions`. Chart: installs CRD + operator + RBAC, templates a default `KapeAgentServer` CR, and **deletes the legacy hand-wired controller Deployment** (clean cut — chart is in development).

Env mapping (renderer-owned): `sandbox.image→KAPE_DEFAULT_IMAGE`, `sandbox.model→KAPE_DEFAULT_MODEL`, `sandbox.resources→KAPE_DEFAULT_RESOURCES`, `modelGateway.url→KAPE_MODEL_GATEWAY_URL`, `description→KAPE_SERVER_DESCRIPTION`, `controller.image`→Deployment container image. `KAPE_CREDENTIAL_BINDINGS` rendered empty until the credential-automation ticket.

## Design contract (slice of #261)

### Modules & contracts

1. **`KapeAgentServer` API types** (new, pure — schema only)
   - pre: none (admission-level).
   - post: a submitted CR round-trips the complete v0 schema (all five groups + `description` + per-credential status conditions); CEL rejects bad host patterns, duplicate credential names, cross-namespace `secretRef`.
   - invariant: the schema carries `credentials[]` and status conditions **now**, though nothing reconciles them until #265 — a later CRD rev is forbidden.

2. **`Render(KapeAgentServer, resolvedSecrets) → DesiredState{DeploymentEnv, NetworkResources, OpenShellRecords}`** (new, **pure**)
   - pre: a CR that passed API validation.
   - post: `DeploymentEnv` contains `KAPE_DEFAULT_IMAGE` / `KAPE_DEFAULT_MODEL` / `KAPE_DEFAULT_RESOURCES` / `KAPE_MODEL_GATEWAY_URL` / `KAPE_SERVER_DESCRIPTION` mapped per the env-mapping table above; `KAPE_CREDENTIAL_BINDINGS` present and empty (`[]`).
   - invariant: no client calls of any kind — same input → same output (golden-testable without a cluster or gateway).

3. **Deployment/network apply** (new, impure — controller-runtime)
   - pre: a `DesiredState` from the renderer.
   - post: the controller Deployment + network resources exist in the CR's namespace and converge on every re-apply.
   - invariant: owns only CR-rendered objects; never adopts or patches anything it did not render.

4. **MCP instructions** (new, controller-side)
   - pre: `KAPE_SERVER_DESCRIPTION` set in the controller env.
   - post: the initialize handshake returns it as server `instructions`.
   - invariant: the 8-tool contract stays byte-identical (#160 is a locked stable surface).

5. **Chart** (modified)
   - post: fresh `helm install` yields CRD + operator + RBAC + a default `KapeAgentServer` CR — and no legacy controller Deployment.
   - invariant: exactly one declarative path; no `legacyController.enabled` (or similar) toggle.

### Data model

- CRD v0 schema: `controller` (image, resources), `sandbox` (default agent image, model, cpu/mem), `modelGateway` (url), `credentials[]` (`{name (DNS label), secretRef{name}, providerType, hostPatterns[]}`), `network` (ingress host/TLS, egress policy refs), `description` (free text). Status: `Ready` condition + per-credential conditions (written by #265; schema present now).
- Env contract (operator → controller): the mapping table above. The controller consumes env verbatim and learns nothing else from the operator.

### Context you cannot infer from the repo

- The controller is **env-first today** by design (existing `Config` contract) — it must stay a pure tool surface: no CRDs, no k8s client (decision 6, #261).
- `ApplyModelGatewayPolicy` is the policy-merge seam reused by #264 (verified 2026-10-19 at `gateway.go:48`, re-verify) — this slice must not break it, but does not use it yet.
- kape workloads are **not ArgoCD-managed** — deployed manually from `charts/kape`; the clean cut will not fight a GitOps sync (triage pre-flight, 2026-10-19).
- Chart is explicitly in development; breaking its consumers is accepted (decision 13, #261).
- The name `KapeAgentServer` is settled after `KapeController` / `KapeProfile` / `KapeMCPServer` / `KapeToolServer` were weighed and rejected (rationale in ADR-0087 and decision 4, #261) — do not reopen.

### Rejected (settled)

- **Do NOT give the controller a k8s client or CRD watch** — rejected: env is the operator→controller contract; a watch adds a k8s client + RBAC dimension to a stateless tool surface (decision 6).
- **Do NOT keep the legacy controller Deployment behind a values toggle** — rejected: clean cut; a side-by-side path doubles the serving surface during a chart-in-development window (decision 13).
- **Do NOT render credential content into `KAPE_CREDENTIAL_BINDINGS`** — that reconcile belongs to #265; this slice renders it empty (decision 4 consequence: schema ships complete, behavior arrives later).

### Validation scenarios

1. Fresh `helm install` → CRD + operator + RBAC + default CR exist; **no** legacy controller Deployment exists.
2. `kubectl apply` a `KapeAgentServer` CR → a working controller Deployment + network resources appear in the CR's namespace; status `Ready` reflects the outcome.
3. MCP `initialize` against the served endpoint returns the CR's `description` as server instructions.
4. `create_agent` / `prompt_agent` work through the CR-managed controller exactly as on the legacy path.
5. CEL negative tests: bad host pattern, duplicate credential name, cross-namespace `secretRef` are rejected at admission.
6. Delete the controller Deployment → the operator recreates it from the CR (reconcile convergence).

### Trace

Covers US 1, 6, 7, 10, 12 · constrained by decisions 4, 5, 6, 8, 13 (#261) · fills handoff **H4** (default CR values for the smoke).

## Acceptance criteria

- [ ] `kubectl apply` of a `KapeAgentServer` CR materializes a working controller Deployment + network resources in the CR's namespace
- [ ] MCP `initialize` against the served endpoint returns the CR's `description` as server instructions
- [ ] `create_agent`/`prompt_agent` work through the CR-managed controller exactly as on the legacy path
- [ ] Legacy controller Deployment removed from the chart; fresh `helm install` yields CRD + operator + default CR only
- [ ] Status `Ready` condition reflects reconcile outcome
- [ ] Tests: renderer golden tests (no-credential specs), envtest CRD validation (CEL rejects bad host patterns / duplicate credential names)
- [ ] **H4 handoff filled** in #261: default CR values for the smoke

## Blocked by

None — can start immediately (targets v0.0.116; no provider API use).
