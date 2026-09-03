# ADR 0005 — What "reproducible build" claims (and does not claim)

- **Status:** Accepted
- **Date:** 2026-09-03
- **Slice:** ETBZ-9

## Context

"Reproducible build" is routinely over-claimed. A container image contains
timestamps, layer identifiers and metadata that differ between two builds of
identical inputs, so **bit-identical images** are a strong claim that requires
dedicated tooling to earn.

Claiming it without proving it is worse than not claiming it: it invites people
to rely on a property that does not hold.

## Decision

ETBZ-9 claims **application-artefact reproducibility**, not bit-identical
images.

Given:

- the same git revision,
- the same `package-lock.json`,
- the same `Dockerfile`,
- the same declared build arguments,
- a clean build context,

two builds must produce the results below. The **second build runs with
`--no-cache`**: a build served from the layer cache merely re-reports the first
build's artefact, so an equality assertion over it would be vacuous.

- a successful build,
- the **same application artefact hash** — a SHA-256 over the compiled `dist/`
  tree (sorted paths and contents) computed inside the image,
- **identical source-revision metadata** in the image labels,
- the **same foundation runtime smoke behaviour**.

## Explicitly NOT claimed

- Bit-identical image digests. Volatile OCI metadata (`created`, layer ids,
  history entries) is expected to differ and is deliberately excluded from the
  comparison.
- Reproducibility across different base image digests.
- Reproducibility of the `node_modules` tree byte-for-byte on disk; the lockfile
  pins resolution, and the compiled artefact hash is what is compared.

## Base image pinning

The Node 24 base image is pinned by **immutable digest** in the `Dockerfile`, so
the same commit resolves to the same base layer regardless of when it is built.
The tag is retained alongside the digest for readability. Updating it is a
deliberate, reviewable change.

## Known limitation — recorded, not hidden

The local development host used for ETBZ-9 runs **Node 22**, while the container
and CI run **Node 24 LTS**. `package.json` therefore declares
`"engines": { "node": ">=22.12.0 <25" }`.

The authoritative runtime target is **Node 24**: it is what the image runs and
what the CI `verify` job uses. Node 22 is tolerated for local development only.
Because `tsc` output depends on the compiler and its configuration rather than
on the host Node version, the compiled artefact hash is expected to agree across
both — and `scripts/build-dry-run.sh` compares the host-built and image-built
artefact hashes rather than assuming it.

## Consequences

**Positive**

- The claim made is the claim proven, and the proof is a script anyone can run.
- Provenance is verifiable: image labels carry the exact revision, and a missing
  or placeholder revision fails the build rather than defaulting to `unknown`.

**Negative / accepted**

- Consumers who need bit-identical images need additional work (a fixed
  `SOURCE_DATE_EPOCH`, a reproducible builder). Out of scope for ETBZ-9.
