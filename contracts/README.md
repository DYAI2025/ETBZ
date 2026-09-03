# `contracts/`

## 1. Purpose of this boundary

`contracts/` is the versioned home of **cross-boundary data contracts** — the
schemas that describe payloads exchanged with anything outside this service, and
the payloads persisted beyond a single process lifetime.

Keeping them here, rather than inline next to the code that happens to use them
first, exists to make three things explicit:

- a contract change is a **visible, reviewable** change, not an incidental edit;
- a contract is **owned by the boundary**, not by whichever module first parsed
  it;
- runtime validation at the boundary is derived from the same declaration that
  documents it, so drift between "what we document" and "what we accept" is
  detectable.

## 2. No business schemas in ETBZ-9

**ETBZ-9 contains no business contracts, by design.**

ETBZ-9 delivers the service foundation only: liveness, configuration readiness,
architecture boundaries, build and CI. It has no order, no receipt, no job, no
render request and no delivery payload — so there is nothing to describe.

Adding a speculative schema now would assert a business capability the service
does not have. `tests/architecture/no-business-surface.test.ts` therefore fails
if a schema file appears in this directory during ETBZ-9.

The only permitted content in this slice is this README.

## 3. Versioned contracts arrive with their own slice

Each contract is introduced by the slice that actually needs it, together with:

- an explicit version identifier,
- runtime validation at the boundary that uses it,
- positive and negative tests, including a rejected-payload case,
- documentation of the compatibility expectation for consumers.

The HTTP surface contract is separate and already active: `/health` and `/ready`
are described in `openapi/etbz.openapi.yaml` and verified against the live
router by `tests/contract/`.
