#!/usr/bin/env bash
# =============================================================================
# ETBZ-9 verification contract.
#
# THE single definition of "verified" for this repository. The GitHub Actions
# `verify` job runs this same script, so local and remote enforcement cannot
# drift apart.
#
# Usage:
#   scripts/ci-verify.sh              # full gate (Docker included when present)
#   scripts/ci-verify.sh --skip-docker
#   scripts/ci-verify.sh --skip-mutations
#
# Environment:
#   GITLEAKS_BIN   path to the secret scanner when it is not on PATH
#   ETBZ_REVISION  revision for the image build (defaults to git HEAD)
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib-verify.sh
source "${REPO_ROOT}/scripts/lib-verify.sh"

cd "${REPO_ROOT}"

RUN_DOCKER=1
RUN_MUTATIONS=1
for argument in "$@"; do
  case "${argument}" in
    --skip-docker)    RUN_DOCKER=0 ;;
    --skip-mutations) RUN_MUTATIONS=0 ;;
    *) echo "unknown option: ${argument}" >&2; exit 2 ;;
  esac
done

# Minimum number of executed tests. Guards against a "green" run that in fact
# executed nothing - the classic CI false green.
#
# The floor may be RAISED from the environment but never lowered: an assertion
# that a passing environment variable can switch off is not an assertion.
ETBZ_MINIMUM_TEST_COUNT_FLOOR=160
MINIMUM_TEST_COUNT="${ETBZ_MINIMUM_TEST_COUNT:-${ETBZ_MINIMUM_TEST_COUNT_FLOOR}}"
if [ "${MINIMUM_TEST_COUNT}" -lt "${ETBZ_MINIMUM_TEST_COUNT_FLOOR}" ]; then
  MINIMUM_TEST_COUNT="${ETBZ_MINIMUM_TEST_COUNT_FLOOR}"
fi
TEST_REPORT="${REPO_ROOT}/.etbz-verify/vitest-report.json"

etbz_banner "ETBZ-9 VERIFICATION CONTRACT"
printf 'node            : %s\n' "$(node --version)"
printf 'npm             : %s\n' "$(npm --version)"
printf 'repository root : %s\n' "${REPO_ROOT}"
printf 'docker step     : %s\n' "$([ "${RUN_DOCKER}" -eq 1 ] && echo enabled || echo skipped)"
printf 'mutation proofs : %s\n' "$([ "${RUN_MUTATIONS}" -eq 1 ] && echo enabled || echo skipped)"

# --- 1. install gate ----------------------------------------------------------
# `npm ci` fails when package.json and package-lock.json disagree, so lockfile
# drift is caught here rather than at runtime.
install_dependencies() { npm ci --no-audit --no-fund; }

verify_lockfile_present() {
  test -f "${REPO_ROOT}/package-lock.json" || {
    echo "package-lock.json is missing - the install gate cannot be deterministic" >&2
    return 1
  }
  echo "package-lock.json present and committed"
}

# --- 2. typecheck -------------------------------------------------------------
run_typecheck() { npm run --silent typecheck; }

# --- 3. tests -----------------------------------------------------------------
run_tests() {
  mkdir -p "$(dirname "${TEST_REPORT}")"
  npx vitest run --reporter=default --reporter=json --outputFile="${TEST_REPORT}"
}

assert_test_count() {
  node -e '
    const fs = require("node:fs");
    const minimum = Number(process.argv[1]);
    const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const total = Number(report.numTotalTests ?? 0);
    const passed = Number(report.numPassedTests ?? 0);
    const failed = Number(report.numFailedTests ?? 0);
    console.log(`executed=${total} passed=${passed} failed=${failed} minimum=${minimum}`);
    if (failed > 0) { console.error("TEST_GATE_FAILED: failing tests reported"); process.exit(1); }
    if (total < minimum) {
      console.error(`TEST_GATE_FAILED: only ${total} tests executed, expected at least ${minimum}. An empty or truncated run is not a green run.`);
      process.exit(1);
    }
    const suites = new Set((report.testResults ?? []).map((r) => String(r.name).replace(/\\\\/g, "/").split("/tests/")[1]?.split("/")[0]).filter(Boolean));
    for (const required of ["unit", "integration", "negative", "contract", "architecture"]) {
      if (!suites.has(required)) {
        console.error(`TEST_GATE_FAILED: suite "tests/${required}" contributed no executed test file`);
        process.exit(1);
      }
    }
    console.log(`suites executed: ${[...suites].sort().join(", ")}`);
  ' "${MINIMUM_TEST_COUNT}" "${TEST_REPORT}"
}

# --- 4. build -----------------------------------------------------------------
run_build() { npm run --silent build; }

assert_build_output() {
  test -f "${REPO_ROOT}/dist/main.js" || { echo "BUILD_GATE_FAILED: dist/main.js missing" >&2; return 1; }
  test -f "${REPO_ROOT}/dist/http/app.js" || { echo "BUILD_GATE_FAILED: dist/http/app.js missing" >&2; return 1; }
  echo "build output present: $(find "${REPO_ROOT}/dist" -name '*.js' | wc -l | tr -d ' ') javascript files"
}

# --- 5. guards ----------------------------------------------------------------
run_guard_mutations() { bash "${REPO_ROOT}/scripts/verify-guards.sh"; }

# --- 6. secret gate -----------------------------------------------------------
run_secret_gate() { bash "${REPO_ROOT}/scripts/secret-scan.sh"; }

# --- 7. dependency risk -------------------------------------------------------
run_dependency_scan() {
  # Runtime dependencies are blocking at `high`; the full tree is reported for
  # visibility without blocking on dev-only advisories.
  npm audit --audit-level=high --omit=dev
}

report_full_dependency_audit() {
  npm audit --audit-level=critical || echo "note: dev-tree advisories reported above are informational in this gate"
  return 0
}

# --- 8. docker ----------------------------------------------------------------
run_build_dry_run() { bash "${REPO_ROOT}/scripts/build-dry-run.sh"; }

# --- execution ----------------------------------------------------------------
etbz_step "install gate :: lockfile committed" verify_lockfile_present
etbz_step "install gate :: npm ci (deterministic install)" install_dependencies
etbz_step "typecheck :: tsc --noEmit (strict)" run_typecheck
etbz_step "tests :: vitest run (all suites)" run_tests
etbz_step "tests :: executed-count and suite-coverage assertion" assert_test_count
etbz_step "build :: tsc -p tsconfig.build.json" run_build
etbz_step "build :: output assertion" assert_build_output
if [ "${RUN_MUTATIONS}" -eq 1 ]; then
  etbz_step "guards :: architecture + contract mutation proofs" run_guard_mutations
fi
etbz_step "security :: secret scan + scanner mutation proof" run_secret_gate
etbz_step "security :: dependency risk scan (runtime tree, high+)" run_dependency_scan
etbz_step "security :: full dependency audit (informational)" report_full_dependency_audit
if [ "${RUN_DOCKER}" -eq 1 ]; then
  etbz_step "container :: BUILD_DRY_RUN (build, provenance, non-root, smoke, cleanup)" run_build_dry_run
fi

etbz_summary "ETBZ-9 VERIFICATION CONTRACT"
