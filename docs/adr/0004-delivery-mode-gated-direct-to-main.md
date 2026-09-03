# ADR 0004 — Delivery mode: gated direct-to-main

- **Status:** Accepted
- **Date:** 2026-09-03
- **Slice:** ETBZ-9

## Context

ETBZ-9 initialises a repository that was **empty**: no commits, no branches, no
history. A pull-request flow needs a base commit to target, so the very first
commit cannot itself be reviewed through a PR.

The available options were: create an artificial bootstrap commit purely to open
a PR against it, or publish the verified foundation directly as the root commit
under an explicit gate.

## Decision

For ETBZ-9, delivery is **gated direct-to-main**, authorised by the product
owner for this slice.

"Direct-to-main" describes the *destination*, never the *rigour*. The push is
permitted only after a deterministic gate passes twice:

1. implement the foundation;
2. run positive **and** negative tests;
3. run security / secret / architecture / contract gates, each with a mutation
   proof;
4. complete `BUILD_DRY_RUN` (build, provenance, non-root, runtime smoke,
   reproducibility, cleanup);
5. review the full file tree and diff;
6. commit;
7. **re-run the identical gate against the exact committed SHA**;
8. push only if every mandatory step is green;
9. read back the remote `main` SHA and assert equality with the local commit;
10. read back remote CI for exactly that head SHA.

Hard constraints: **no force push, no history rewrite.** Any red mandatory gate
means `STOP — LOCAL_GATE_FAILED — DO NOT PUSH`.

No artificial bootstrap commit is created: the first remote commit is the fully
verified foundation.

## Why the gate runs twice

The pre-commit run verifies the *working tree*; the pre-push run verifies the
*commit object*. They are not the same artefact — an untracked file, a
`.gitignore` mistake or a partially staged change can make them differ. Only the
second run describes what other people will actually receive.

## Scope — this is not the steady state

This mode applies to **ETBZ-9 only**, because a repository can be empty only
once. From ETBZ-10 onward the normal flow is: feature branch → pull request →
review → CI → merge. Direct-to-main then requires a fresh, explicit human
authorisation.

## Consequences

**Positive**

- No commit exists that was never verified; no throwaway bootstrap commit.
- The verification contract is written down and executable
  (`scripts/ci-verify.sh`), so local and CI enforcement can agree.

**Negative / accepted**

- The first commit receives no second pair of human eyes before it lands. This
  is why the gate is mechanical, mutation-proven and executed twice, and why the
  mode is explicitly limited to this one slice.
