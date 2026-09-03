#!/usr/bin/env bash
# Shared helpers for the ETBZ verification scripts.
# Sourced, never executed directly.

set -euo pipefail

ETBZ_STEP_INDEX=0
ETBZ_FAILED_STEPS=()

etbz_hr() { printf '%s\n' "-------------------------------------------------------------------------------"; }

etbz_banner() {
  etbz_hr
  printf '  %s\n' "$1"
  etbz_hr
}

# etbz_step <name> <command...>
# Runs a verification step, records its exit status, never aborts the script so
# that a full gate report can be produced.
etbz_step() {
  local name="$1"; shift
  ETBZ_STEP_INDEX=$((ETBZ_STEP_INDEX + 1))
  printf '\n>>> [%02d] %s\n' "$ETBZ_STEP_INDEX" "$name"
  local status=0
  "$@" || status=$?
  if [ "$status" -eq 0 ]; then
    printf '<<< [%02d] %s :: PASS (exit 0)\n' "$ETBZ_STEP_INDEX" "$name"
  else
    printf '<<< [%02d] %s :: FAIL (exit %d)\n' "$ETBZ_STEP_INDEX" "$name" "$status"
    ETBZ_FAILED_STEPS+=("$name (exit $status)")
  fi
  return 0
}

# etbz_expect_failure <name> <command...>
# Inverted step: the command MUST fail. Used by every mutation proof, where a
# passing command means the guard is broken.
etbz_expect_failure() {
  local name="$1"; shift
  ETBZ_STEP_INDEX=$((ETBZ_STEP_INDEX + 1))
  printf '\n>>> [%02d] MUTATION PROOF: %s (expecting NON-ZERO)\n' "$ETBZ_STEP_INDEX" "$name"
  local status=0
  "$@" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 0 ]; then
    printf '<<< [%02d] %s :: PASS (guard turned red, exit %d)\n' "$ETBZ_STEP_INDEX" "$name" "$status"
  else
    printf '<<< [%02d] %s :: FAIL (guard stayed GREEN under mutation - the guard itself is broken)\n' \
      "$ETBZ_STEP_INDEX" "$name"
    ETBZ_FAILED_STEPS+=("$name (guard did not detect the mutation)")
  fi
  return 0
}

etbz_summary() {
  local title="$1"
  printf '\n'
  etbz_banner "$title :: SUMMARY"
  if [ "${#ETBZ_FAILED_STEPS[@]}" -eq 0 ]; then
    printf 'steps executed : %d\n' "$ETBZ_STEP_INDEX"
    printf 'result         : ALL GREEN\n'
    return 0
  fi
  printf 'steps executed : %d\n' "$ETBZ_STEP_INDEX"
  printf 'failed steps   : %d\n' "${#ETBZ_FAILED_STEPS[@]}"
  local failure
  for failure in "${ETBZ_FAILED_STEPS[@]}"; do
    printf '  - %s\n' "$failure"
  done
  printf 'result         : FAILED\n'
  return 1
}

# Resolves the secret scanner. Order: $GITLEAKS_BIN, then PATH.
etbz_gitleaks_bin() {
  if [ -n "${GITLEAKS_BIN:-}" ] && [ -x "${GITLEAKS_BIN}" ]; then
    printf '%s' "${GITLEAKS_BIN}"
    return 0
  fi
  if command -v gitleaks >/dev/null 2>&1; then
    command -v gitleaks
    return 0
  fi
  return 1
}
