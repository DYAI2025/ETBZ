# ETBZ Service

Service foundation for ETBZ. **Slice: ETBZ-9.**

This repository currently contains a foundation, not a product. It is
installable, typecheckable, testable, buildable, containerisable, secret-safe,
architecturally bounded, CI-verified and provenance-capable — and it has
**no business pipeline**.

Everything it claims is checked by a gate in this repository. Nothing it does
not check is claimed.

---

## What exists in ETBZ-9

| Endpoint | Meaning | Status codes |
| --- | --- | --- |
| `GET /health` | **Liveness only.** The process is running and can serve HTTP. | `200` — always, including while the configuration is invalid |
| `GET /ready` | Readiness for exactly one capability: `configuration`. | `200` valid config · `503` missing/malformed mandatory config |

`GET /health` returns exactly:

```json
{ "status": "alive" }
```

It asserts **nothing** about FuFirE, a database, Etsy, PDF rendering, delivery
or production readiness. That is the point: a liveness probe that depends on a
dependency restarts a healthy container during a dependency outage.

`GET /ready` is **fail-closed** and reports variable *names* and static
expectations — never a configuration value:

```json
{
  "status": "not_ready",
  "capabilities": [
    { "name": "configuration", "status": "fail",
      "issues": [{ "variable": "ETBZ_ENV", "code": "missing",
                   "expectation": "one of: local | development | test | staging | production" }] }
  ]
}
```

The complete public surface is described in
[`openapi/etbz.openapi.yaml`](openapi/etbz.openapi.yaml) and is verified against
the live router by `tests/contract/`.

## What deliberately does not exist

No FuFirE call or adapter, no Etsy, no webhook, no receipt handling, no
persistence, no job state, no idempotency, no PDF/WeasyPrint/Chromium, no
approval, no delivery, no deployment, no nginx, no Docker network changes, no
production secrets.

These are not omissions to be filled in quietly — `tests/architecture/` fails if
a business route, a business contract or an out-of-scope dependency appears.

---

## Architecture

```
        inbound                                  outbound
   ┌──────────────┐                        ┌──────────────┐
   │   src/http   │                        │ src/adapters │
   └──────┬───────┘                        └──────┬───────┘
          │                                       │
          └──────────────┐         ┌──────────────┘
                         ▼         ▼
                   ┌──────────────────────┐
                   │   src/application    │  use cases + ports
                   └──────────┬───────────┘
                              ▼
                   ┌──────────────────────┐
                   │      src/domain      │  rules, no framework, no driver
                   └──────────────────────┘

   src/app  =  composition root (configuration, logging, readiness, wiring)
```

The dependency rule points **inward only** and is enforced by a test, not by
convention. `src/domain` and `src/application` may not import a framework or a
driver; the guard uses an **allowlist** of permitted packages rather than a
denylist, because any new package name defeats a denylist.

`src/app` (composition root) and `src/application` (layer) are distinct despite
the shared prefix; the guard matches whole path segments.

| Path | Responsibility |
| --- | --- |
| `src/domain/` | Business rules. Empty in ETBZ-9 — no fake abstractions. |
| `src/application/` | Use cases and ports. Empty in ETBZ-9. |
| `src/adapters/` | Outbound infrastructure. Empty in ETBZ-9. |
| `src/http/` | Thin Express 5 inbound adapter: routes, middleware, errors. |
| `src/app/` | Composition root: configuration, logging, readiness, build info, server. |
| `contracts/` | Cross-boundary data contracts. **No business schema in ETBZ-9.** |
| `openapi/` | The public HTTP surface contract. |
| `docs/adr/` | Architecture decisions, including what is *not* claimed. |
| `scripts/` | The executable verification contract. |

Decisions are recorded in [`docs/adr/`](docs/adr/):
[0001 modular monolith / hexagonal-lite](docs/adr/0001-modular-monolith-hexagonal-lite.md) ·
[0002 project-local configuration](docs/adr/0002-project-local-configuration.md) ·
[0003 selective Sizhu reuse](docs/adr/0003-selective-sizhu-reuse.md) ·
[0004 delivery mode](docs/adr/0004-delivery-mode-gated-direct-to-main.md) ·
[0005 reproducibility scope](docs/adr/0005-reproducibility-scope.md).

---

## Configuration

Configuration is **project-local and explicitly injected**. The loader is a pure
function over a supplied environment record: it reads no file, performs no
discovery, and **never reads `/root/.env`** or any other host configuration.
`process.env` is read exactly once, in `src/main.ts`.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `ETBZ_ENV` | **yes** | *none* | `local` \| `development` \| `test` \| `staging` \| `production`. No default of any kind, and in particular no implicit `production`. |
| `LOG_LEVEL` | **yes** | *none* | `debug` \| `info` \| `warn` \| `error` |
| `ETBZ_PORT` | no | `8120` | A malformed value still fails readiness. |

Unknown variables cannot change the configuration: only declared names are read,
asserted by a byte-equality test. Names reserved for later slices are documented
in [`.env.example`](.env.example) and are explicitly **not** readiness-relevant
in ETBZ-9.

Build metadata (`ETBZ_GIT_COMMIT`, `ETBZ_BUILD_VERSION`,
`ETBZ_SOURCE_REPOSITORY`, `ETBZ_BUILD_TIMESTAMP`) is injected by the image
build. A missing or placeholder revision **fails the build** — it never
degrades to `unknown`.

## Logging

Structured single-line JSON. Every record carries a correlation id: a safe
inbound `x-correlation-id` / `x-request-id` is reused, anything else is
regenerated. Credential-shaped **keys** and credential-shaped **values** are
both redacted, and payload fields cannot overwrite the log envelope.

---

## Running it

```bash
npm ci
npm run typecheck
npm test
npm run build

ETBZ_ENV=local LOG_LEVEL=info npm start        # http://localhost:8120
```

### Container

```bash
docker build \
  --build-arg GIT_COMMIT="$(git rev-parse HEAD)" \
  --build-arg BUILD_VERSION="$(node -p "require('./package.json').version")" \
  --build-arg SOURCE_REPOSITORY="https://github.com/DYAI2025/ETBZ" \
  --build-arg BUILD_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -t etbz-service:local .
```

Node 24 LTS pinned by digest · multi-stage · runs as non-root uid/gid
`10002` · OCI provenance labels · no environment file in the image.

---

## Verification

`scripts/ci-verify.sh` is the **single definition of "verified"**. The GitHub
Actions `verify` job runs the same script, so local and remote enforcement
cannot drift apart.

```bash
bash scripts/ci-verify.sh                 # full gate
bash scripts/ci-verify.sh --skip-docker   # without BUILD_DRY_RUN
```

| Gate | What it proves |
| --- | --- |
| install | `npm ci` — lockfile drift fails the install |
| typecheck | `tsc --noEmit`, strict |
| tests | all suites, **with a minimum executed-test count** and a per-suite assertion, so an empty run cannot pass as green |
| build | `tsc -p tsconfig.build.json` plus an output assertion |
| guards | architecture + contract, each with a **mutation proof** |
| secrets | gitleaks over tree and history, with a **scanner mutation proof** |
| dependencies | `npm audit` on the runtime tree at `high` |
| container | `BUILD_DRY_RUN` — build, provenance, non-root, image-content, runtime smoke, reproducibility, cleanup |

### Why mutation proofs

A guard that has never been observed failing is not evidence of anything.
`scripts/verify-guards.sh` injects real violations — a framework import in
`src/domain`, a layer-escaping import in `src/application`, an undocumented
route, a business schema in `contracts/`, lockfile drift — and **requires each
guard to turn red** before reverting every mutation and re-proving the baseline.

`scripts/secret-scan.sh` does the same for the secret scanner, using a fixture
created at runtime that is never committed, never pushed, and whose value is
never printed. (The AWS documented example key is deliberately not used as the
fixture: gitleaks allowlists it, which would report a working scanner as
broken.)

### BUILD_DRY_RUN is not a deployment

It builds, inspects, runs short-lived `--rm` containers with `--network none`,
smokes the foundation over loopback *inside* the container, compares artefact
hashes across two builds, and removes its images. It never publishes a port,
creates a Docker network, mounts a volume, uses compose, or contacts anything.

### What reproducibility means here

Same commit + same lockfile + same Dockerfile + same build args + clean context
⇒ same **application artefact hash** and identical revision metadata. The
comparison build runs with `--no-cache`, because a cache-served rebuild would
only re-report the first build's artefact. Bit-identical images are **not**
claimed — see
[ADR 0005](docs/adr/0005-reproducibility-scope.md), which also records that the
authoritative runtime is Node 24 while local development may run Node 22.

---

## Delivery

ETBZ-9 was delivered via **gated direct-to-main**, authorised for this slice
only because the repository was empty and had no commit to base a PR on. The
gate ran before the commit and again against the exact committed SHA; no force
push, no history rewrite. See
[ADR 0004](docs/adr/0004-delivery-mode-gated-direct-to-main.md).

**From ETBZ-10 onward the normal flow applies: branch → pull request → review →
CI → merge.**
