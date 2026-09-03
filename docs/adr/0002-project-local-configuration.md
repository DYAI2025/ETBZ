# ADR 0002 — Project-local, explicitly injected configuration

- **Status:** Accepted
- **Date:** 2026-09-03
- **Slice:** ETBZ-9

## Context

The host that will run ETBZ carries configuration for other services, including
files such as `/root/.env`. A service that reads ambient host configuration is
dangerous in three distinct ways:

1. it can silently pick up another system's credentials;
2. its behaviour depends on host state that is invisible to its own tests;
3. a misconfiguration surfaces as unexplained runtime behaviour rather than as
   a failed readiness check.

## Decision

**Configuration is project-local, explicit and injected.**

- `loadEtbzConfig(environment)` is a **pure function** over an explicitly
  supplied environment record. It reads no file, no `process.env`, and performs
  no discovery.
- `process.env` is read **exactly once**, in `src/main.ts`, and passed down.
- ETBZ **never** reads `/root/.env` or any other host configuration file. Any
  `.env` loading is the operator's or the container runtime's job.
- Only variables declared in `CONFIG_VARIABLES` are read. Unknown variables
  cannot change `EtbzConfig` — asserted by a byte-equality test.
- Validation is fail-closed: missing or malformed mandatory configuration makes
  `/ready` answer 503.
- `ETBZ_ENV` has **no default of any kind**, and in particular no implicit
  `production`.

## Value confidentiality

Configuration **values never leave the configuration boundary.** Issues carry a
variable name, a machine-readable code and a *static* expectation string.

This is why Zod validates but its error messages are discarded: Zod embeds the
received value in its messages, so passing them through would leak the value of
a mis-set variable into a 503 body or a log line. Issues are re-derived from a
static declaration table instead, and negative tests assert that neither valid
nor invalid values ever appear in a response, an error or a log record.

## Consequences

**Positive**

- Every configuration scenario, including invalid ones, is expressible as data
  in a test; no test mutates `process.env`.
- No host coupling: the same image behaves identically anywhere.
- A leaked secret cannot be produced by a validation error.

**Negative / accepted**

- Slightly more plumbing: the environment record must be threaded from the
  entrypoint instead of being read where it is needed.
- The static expectation strings must be maintained alongside the schema. This
  is deliberate: it is the price of never echoing a received value.

## Alternatives considered

- **`dotenv` auto-loading.** Rejected: reintroduces implicit filesystem
  configuration and makes test isolation depend on the working directory.
- **Reading `process.env` directly where needed.** Rejected: untestable without
  global mutation, and it hides the true configuration surface.
- **Passing Zod messages through to the client.** Rejected: value leak.
