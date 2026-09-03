#!/usr/bin/env bash
# =============================================================================
# ETBZ-9 secret gate.
#
#   1. clean scan of the working tree
#   2. clean scan of the full git history (when a commit exists)
#   3. MUTATION PROOF: a detectable fixture is created at runtime; the scanner
#      MUST report a finding. A "clean" result here means the scanner is not
#      working and the mutation test itself has FAILED.
#   4. fixture deleted, absence proven, git state proven clean
#
# The fixture is generated at runtime, is never committed, never pushed, and
# its value is NEVER printed - not to stdout, not into the evidence packet.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib-verify.sh
source "${REPO_ROOT}/scripts/lib-verify.sh"

cd "${REPO_ROOT}"

GITLEAKS="$(etbz_gitleaks_bin || true)"
if [ -z "${GITLEAKS}" ]; then
  echo "SECRET_GATE_FAILED: no secret scanner found. Install gitleaks or set GITLEAKS_BIN." >&2
  exit 2
fi

echo "secret scanner : $(${GITLEAKS} version 2>&1 | head -1)"

FIXTURE_PATH="${REPO_ROOT}/.etbz-secret-mutation-fixture.txt"

cleanup_fixture() {
  rm -f "${FIXTURE_PATH}"
}
trap cleanup_fixture EXIT INT TERM

scan_working_tree() {
  "${GITLEAKS}" detect --source "${REPO_ROOT}" --no-git --redact --no-banner --exit-code 1
}

scan_history() {
  if git -C "${REPO_ROOT}" rev-parse --verify HEAD >/dev/null 2>&1; then
    "${GITLEAKS}" detect --source "${REPO_ROOT}" --redact --no-banner --exit-code 1
  else
    echo "no commit yet - history scan skipped (working-tree scan covers all content)"
  fi
}

create_fixture() {
  # Assembled at runtime from fragments so that no committed file ever contains
  # a scanner-detectable literal. THREE independent detectable shapes are used
  # (private key block, generic high-entropy secret assignment, PAT shape) so
  # the proof does not hinge on one upstream rule surviving a scanner upgrade.
  #
  # NOTE: the AWS documented example key (AKIA...EXAMPLE) is deliberately NOT
  # used - gitleaks allowlists it, which would make this proof report a broken
  # scanner when the scanner is in fact working correctly.
  # The PEM banner is split so the marker never appears CONTIGUOUSLY in this
  # file: the scanner must flag the generated fixture, not the generator.
  local pem_open='-----BEGIN'
  local pem_close='-----END'
  local pem_kind='RSA'
  local pem_tag='PRIVATE KEY-----'
  local pem_head="${pem_open} ${pem_kind} ${pem_tag}"
  local pem_tail="${pem_close} ${pem_kind} ${pem_tag}"
  local pem_body='MIIEowIBAAKCAQEA1234567890abcdefghijklmnopqrstuv'
  local generic_name='api_secret_key'
  local generic_value='q7Zx4Kd2Lm9Pv1Rb8Tn3Wy6Ac5Ef0Hj'
  local pat_prefix='ghp'
  local pat_body='A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
  {
    printf '%s\n%s\n%s\n' "${pem_head}" "${pem_body}" "${pem_tail}"
    printf '%s = "%s"\n' "${generic_name}" "${generic_value}"
    printf 'token=%s_%s\n' "${pat_prefix}" "${pat_body}"
  } > "${FIXTURE_PATH}"
  chmod 600 "${FIXTURE_PATH}"
  # Value is never echoed; only its existence and size are reported.
  printf 'fixture created: %s (%s bytes) - value intentionally not printed\n' \
    "$(basename "${FIXTURE_PATH}")" "$(wc -c < "${FIXTURE_PATH}" | tr -d ' ')"
}

prove_fixture_absent() {
  if [ -e "${FIXTURE_PATH}" ]; then
    echo "FIXTURE_CLEANUP_FAILED: ${FIXTURE_PATH} still exists" >&2
    return 1
  fi
  echo "fixture absent : $(basename "${FIXTURE_PATH}") not present on disk"
  if git -C "${REPO_ROOT}" ls-files --error-unmatch "$(basename "${FIXTURE_PATH}")" >/dev/null 2>&1; then
    echo "FIXTURE_TRACKED: the mutation fixture is tracked by git" >&2
    return 1
  fi
  echo "fixture untracked : confirmed not in the git index"
  if git -C "${REPO_ROOT}" rev-parse --verify HEAD >/dev/null 2>&1; then
    if git -C "${REPO_ROOT}" log --all --oneline -- "$(basename "${FIXTURE_PATH}")" | grep -q .; then
      echo "FIXTURE_IN_HISTORY: the mutation fixture appears in git history" >&2
      return 1
    fi
    echo "fixture absent from history : confirmed"
  fi
  return 0
}

prove_worktree_clean_of_fixture() {
  if git -C "${REPO_ROOT}" status --porcelain | grep -q 'etbz-secret-mutation-fixture'; then
    echo "FIXTURE_IN_STATUS: git status still reports the fixture" >&2
    return 1
  fi
  echo "git status carries no fixture artefact"
  return 0
}

etbz_banner "ETBZ-9 SECRET GATE"

etbz_step "secret scan :: working tree clean" scan_working_tree
etbz_step "secret scan :: git history clean" scan_history
etbz_step "mutation :: create ephemeral detectable fixture" create_fixture
etbz_expect_failure "secret scanner detects the ephemeral fixture" scan_working_tree
etbz_step "mutation :: delete fixture" cleanup_fixture
etbz_step "proof :: fixture absent from disk, index and history" prove_fixture_absent
etbz_step "proof :: git status free of fixture" prove_worktree_clean_of_fixture
etbz_step "secret scan :: working tree clean after mutation" scan_working_tree

etbz_summary "ETBZ-9 SECRET GATE"
