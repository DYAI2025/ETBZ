# ADR 0003 — Selective reuse from Sizhu

- **Status:** Accepted (policy); reuse inventory **deferred**
- **Date:** 2026-09-03
- **Slice:** ETBZ-9

## Context

An existing system, **Sizhu**, covers subject matter adjacent to ETBZ. Reusing
proven work is attractive; wholesale reuse is not, because the two systems have
different delivery obligations, different trust boundaries and different
lifecycles.

The two failure modes to avoid are equally expensive:

- **copy everything** — ETBZ inherits assumptions, coupling and defects it
  cannot see, and the boundary between the systems disappears;
- **reuse nothing** — knowledge that was already paid for is re-derived, and
  the two systems drift apart in behaviour where they should agree.

## Decision

Reuse from Sizhu is **selective, explicit and unit-by-unit**.

A candidate may be adopted only when all of the following hold:

1. it is identified as a **named unit** (a specific algorithm, table, schema or
   rule set) — never "the Sizhu module";
2. its **origin is recorded** in the slice that adopts it, including what it was
   taken from and at which version;
3. it is **re-verified inside ETBZ** by ETBZ's own tests. An inherited test
   suite is not sufficient evidence;
4. it enters at the **correct layer** — reusable rules belong in `src/domain`
   and must therefore be free of frameworks and drivers. Anything that arrives
   entangled with infrastructure is re-expressed, not copied;
5. **no credential, endpoint or environment-specific value** is carried across.

Anything failing one of these is re-implemented rather than imported.

## Scope in ETBZ-9

**No Sizhu code, data, schema or asset is reused in ETBZ-9.** This slice is the
service foundation and contains no business logic that could reuse anything.

This ADR fixes the *policy* before the first candidate appears, so the decision
is made when it is cheap rather than under delivery pressure.

## Explicitly deferred — and explicitly unverified

A concrete reuse inventory (which Sizhu units are candidates, at which version,
with which licence and ownership) has **not** been produced, and nothing about
Sizhu's contents is asserted here. It is the first task of the slice that
proposes a reuse, and must be recorded in a follow-up ADR.

## Consequences

**Positive**

- Every reused unit has a traceable origin and independent ETBZ verification.
- The architecture guard mechanically prevents reuse from dragging
  infrastructure coupling into the domain layer.

**Negative / accepted**

- Adoption is slower than copying a directory.
- Some duplication between the systems is accepted where re-expression is
  cheaper than a shared dependency.
