# `docs/evidence/`

Where verification evidence for a slice is recorded.

Evidence here is a **record of executed gates**, not a narrative. Each entry
names the command, its exit status and the artefact it examined, so a reader can
re-run it rather than take it on trust.

Transient output written by `scripts/ci-verify.sh` goes to `.etbz-verify/`,
which is git-ignored: a report generated on one machine is not evidence about
another. The durable record is the CI run for a specific commit SHA plus the
gate definitions in `scripts/`.

## ETBZ-9

The ETBZ-9 verification contract is `scripts/ci-verify.sh`. It is the same
script the GitHub Actions `verify` job runs, so a green CI run for a commit is
the authoritative evidence for that commit.
