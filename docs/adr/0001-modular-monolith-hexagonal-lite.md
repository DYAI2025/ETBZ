# ADR 0001 — Modular monolith with a hexagonal-lite layering

- **Status:** Accepted
- **Date:** 2026-09-03
- **Slice:** ETBZ-9
- **Deciders:** ETBZ engineering

## Context

ETBZ starts as a single deployable service with a small, well-understood set of
future integrations (order intake, an external computation service, document
rendering, delivery). The number of moving parts is small; the number of
*boundaries that will be crossed* is not.

Two failure modes are realistic here:

1. **No structure.** Everything lands in route handlers, the HTTP framework
   leaks into business rules, and the first integration change requires touching
   unrelated code.
2. **Too much structure.** A full hexagonal/DDD layout with interfaces, mappers
   and a bounded-context split, built before a single business rule exists —
   ceremony that must be maintained and refactored before it has ever paid off.

## Decision

A **modular monolith** with **hexagonal-lite** layering:

```
http / adapters  ->  application  ->  domain
```

- `src/domain` — business rules. No framework, no driver, no I/O.
- `src/application` — use cases, depending on **ports** (interfaces) it declares
  in `src/application/ports`.
- `src/adapters` — concrete implementations of those ports (driven side).
- `src/http` — the inbound HTTP adapter: a thin Express 5 translation layer.
- `src/app` — the composition root: configuration, logging, readiness, wiring.

"Lite" means: the *direction* rule is enforced from day one, while the
*artefacts* (entities, ports, adapters) appear only when a slice needs them.
ETBZ-9 therefore ships the boundaries with README files and **no placeholder
types** — a fake abstraction is a liability, an enforced empty boundary is not.

Note on naming: `src/app` (composition root) is deliberately distinct from
`src/application` (the layer). The guard matches whole path segments, so the
shared prefix cannot cause a boundary to be checked as the wrong layer.

## Enforcement

The direction rule is a test, not a convention:
`tests/architecture/dependency-direction.test.ts` analyses every import in the
inner layers and enforces both a relative-import direction rule and a bare
specifier **allowlist** (rather than a denylist, which any new package name
would defeat).

`scripts/verify-guards.sh` proves the guard actually fails by injecting a real
violation and requiring a red result before reverting it.

## Consequences

**Positive**

- Business rules stay testable without HTTP, containers or network.
- The cost of extracting a service later is paid only if it is ever needed.
- Boundary erosion is caught by CI, at the moment it is introduced.

**Negative / accepted**

- Indirection when an adapter is finally introduced (a port must be declared).
- The empty `domain`/`application` directories look like ceremony until the
  first business slice arrives. Accepted: the guard is what protects the
  direction, and it must exist before there is code to misplace.

## Alternatives considered

- **Flat structure, refactor later.** Rejected: the refactor never has a
  natural trigger, and by then the framework has leaked into the rules.
- **Full hexagonal + DDD tactical patterns now.** Rejected: it would require
  inventing a domain model before any business requirement is verified.
- **Microservices from the start.** Rejected: no independent scaling or
  deployment driver exists, and it would multiply the operational surface for a
  service that has not yet rendered its first artefact.
