#!/usr/bin/env bash
# =============================================================================
# ETBZ-9 guard mutation proofs.
#
# A guard that has never been observed failing is not evidence. This script
# injects REAL violations and requires each guard to turn red, then reverts
# every mutation and re-proves the baseline.
#
#   A  forbidden framework import in src/domain      -> architecture guard red
#   B  layer-escaping import in src/application      -> architecture guard red
#   C  undocumented route mounted on the app         -> contract guard red
#   D  business schema in contracts/                 -> architecture guard red
#   E  package.json / package-lock.json drift        -> install gate red
#
# Every mutation is removed by an EXIT trap, so an interrupted run cannot leave
# the working tree dirty.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib-verify.sh
source "${REPO_ROOT}/scripts/lib-verify.sh"

cd "${REPO_ROOT}"

MUTATION_DOMAIN_FILE="${REPO_ROOT}/src/domain/__mutation_forbidden_import__.ts"
MUTATION_APPLICATION_FILE="${REPO_ROOT}/src/application/__mutation_layer_escape__.ts"
MUTATION_CONTRACT_FILE="${REPO_ROOT}/contracts/__mutation_order_schema__.json"
APP_FILE="${REPO_ROOT}/src/http/app.ts"
BACKUP_DIR="$(mktemp -d)"

revert_all() {
  rm -f "${MUTATION_DOMAIN_FILE}" "${MUTATION_APPLICATION_FILE}" "${MUTATION_CONTRACT_FILE}"
  if [ -f "${BACKUP_DIR}/app.ts" ]; then
    cp "${BACKUP_DIR}/app.ts" "${APP_FILE}"
  fi
  rm -rf "${BACKUP_DIR}"
}
trap revert_all EXIT INT TERM

cp "${APP_FILE}" "${BACKUP_DIR}/app.ts"

run_architecture_tests() { npm run --silent test:architecture; }
run_contract_tests()     { npm run --silent test:contract; }

# --- mutation A ---------------------------------------------------------------
# Written in the MULTI-LINE named-import form on purpose. A guard that matches
# import statements as text sees nothing here, so this shape is what proves the
# guard parses rather than pattern-matches.
mutate_domain_forbidden_import() {
  cat > "${MUTATION_DOMAIN_FILE}" <<'TS'
// TEMPORARY MUTATION - created by scripts/verify-guards.sh, never committed.
import {
  readFileSync,
} from 'node:fs';
export const mutation = readFileSync;
TS
}

# --- mutation B ---------------------------------------------------------------
# Also multi-line, and additionally a layer escape rather than a bare package.
mutate_application_layer_escape() {
  cat > "${MUTATION_APPLICATION_FILE}" <<'TS'
// TEMPORARY MUTATION - created by scripts/verify-guards.sh, never committed.
import {
  createEtbzApp,
} from '../http/app.js';
export const mutation = createEtbzApp;
TS
}

# Single-line form, so both the wrapped and the unwrapped shape are proven.
mutate_domain_single_line_import() {
  cat > "${MUTATION_DOMAIN_FILE}" <<'TS'
// TEMPORARY MUTATION - created by scripts/verify-guards.sh, never committed.
import express from 'express';
export const mutation = express;
TS
}

# --- mutation C ---------------------------------------------------------------
mutate_undocumented_route() {
  python3 - "${APP_FILE}" <<'PY'
import sys, pathlib
path = pathlib.Path(sys.argv[1])
source = path.read_text()
anchor = "  app.use(createNotFoundHandler());"
assert anchor in source, "anchor for route mutation not found"
injected = (
    "  // TEMPORARY MUTATION - scripts/verify-guards.sh, never committed.\n"
    "  app.get('/orders', (_req, res) => {\n"
    "    res.status(200).json({ mutation: true });\n"
    "  });\n"
)
path.write_text(source.replace(anchor, injected + anchor))
PY
}

revert_undocumented_route() { cp "${BACKUP_DIR}/app.ts" "${APP_FILE}"; }

# --- mutation C2 --------------------------------------------------------------
# The `app.use(path, handler)` shape: a real served surface that carries no
# `.route` in the Express stack and is therefore the easiest one to add
# invisibly. Proven separately from mutation C.
mutate_use_mounted_route() {
  python3 - "${APP_FILE}" <<'PY'
import sys, pathlib
path = pathlib.Path(sys.argv[1])
source = path.read_text()
anchor = "  app.use(createNotFoundHandler());"
assert anchor in source, "anchor for use-mount mutation not found"
injected = (
    "  // TEMPORARY MUTATION - scripts/verify-guards.sh, never committed.\n"
    "  app.use('/orders', (_req, res) => {\n"
    "    res.status(200).json({ mutation: true });\n"
    "  });\n"
)
path.write_text(source.replace(anchor, injected + anchor))
PY
}

# --- mutation D ---------------------------------------------------------------
mutate_contract_business_schema() {
  cat > "${MUTATION_CONTRACT_FILE}" <<'JSON'
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "TEMPORARY MUTATION - business schema that must not exist in ETBZ-9",
  "type": "object",
  "properties": { "orderId": { "type": "string" } }
}
JSON
}

# --- mutation E ---------------------------------------------------------------
# Runs in an isolated copy: the real node_modules is never touched.
prove_lockfile_drift_fails_install() {
  local drift_dir
  drift_dir="$(mktemp -d)"
  cp "${REPO_ROOT}/package.json" "${REPO_ROOT}/package-lock.json" "${drift_dir}/"
  python3 - "${drift_dir}/package.json" <<'PY'
import json, sys, pathlib
path = pathlib.Path(sys.argv[1])
manifest = json.loads(path.read_text())
# A dependency present in package.json but absent from the lockfile.
manifest.setdefault("dependencies", {})["left-pad"] = "^1.3.0"
path.write_text(json.dumps(manifest, indent=2))
PY
  local status=0
  ( cd "${drift_dir}" && npm ci --ignore-scripts --no-audit --no-fund --dry-run ) >/dev/null 2>&1 || status=$?
  rm -rf "${drift_dir}"
  return "${status}"
}

prove_clean_worktree() {
  local dirty
  dirty="$(git -C "${REPO_ROOT}" status --porcelain)"
  if printf '%s' "${dirty}" | grep -qE '__mutation|left-pad'; then
    echo "MUTATION_RESIDUE: mutation artefacts remain in the working tree" >&2
    printf '%s\n' "${dirty}" >&2
    return 1
  fi
  echo "no mutation residue in git status"
  return 0
}

prove_mutation_files_absent() {
  local file
  for file in "${MUTATION_DOMAIN_FILE}" "${MUTATION_APPLICATION_FILE}" "${MUTATION_CONTRACT_FILE}"; do
    if [ -e "${file}" ]; then
      echo "MUTATION_RESIDUE: ${file} still exists" >&2
      return 1
    fi
  done
  if grep -q "TEMPORARY MUTATION" "${APP_FILE}"; then
    echo "MUTATION_RESIDUE: ${APP_FILE} still contains the injected route" >&2
    return 1
  fi
  echo "all mutation files absent; src/http/app.ts restored"
  return 0
}

etbz_banner "ETBZ-9 GUARD MUTATION PROOFS"

etbz_step "baseline :: architecture guards green" run_architecture_tests
etbz_step "baseline :: contract guard green" run_contract_tests

etbz_step "mutation A :: forbidden framework import in src/domain" mutate_domain_forbidden_import
etbz_expect_failure "architecture guard rejects a framework import in src/domain" run_architecture_tests
etbz_step "revert A" rm -f "${MUTATION_DOMAIN_FILE}"

etbz_step "mutation B :: layer-escaping import in src/application" mutate_application_layer_escape
etbz_expect_failure "architecture guard rejects an application -> http import" run_architecture_tests
etbz_step "revert B" rm -f "${MUTATION_APPLICATION_FILE}"

etbz_step "mutation B2 :: single-line framework import in src/domain" mutate_domain_single_line_import
etbz_expect_failure "architecture guard rejects a single-line framework import" run_architecture_tests
etbz_step "revert B2" rm -f "${MUTATION_DOMAIN_FILE}"

etbz_step "mutation C :: undocumented business route on the app" mutate_undocumented_route
etbz_expect_failure "contract guard rejects an undocumented served route" run_contract_tests
etbz_expect_failure "architecture guard rejects a business route" run_architecture_tests
etbz_step "revert C" revert_undocumented_route

etbz_step "mutation C2 :: business surface mounted via app.use(path, handler)" mutate_use_mounted_route
etbz_expect_failure "contract guard rejects a use-mounted surface" run_contract_tests
etbz_expect_failure "architecture guard rejects a use-mounted business surface" run_architecture_tests
etbz_step "revert C2" revert_undocumented_route

etbz_step "mutation D :: business schema in contracts/" mutate_contract_business_schema
etbz_expect_failure "architecture guard rejects a business schema in contracts/" run_architecture_tests
etbz_step "revert D" rm -f "${MUTATION_CONTRACT_FILE}"

etbz_expect_failure "install gate rejects package.json / lockfile drift" prove_lockfile_drift_fails_install

etbz_step "proof :: all mutation artefacts removed" prove_mutation_files_absent
etbz_step "proof :: working tree free of mutation residue" prove_clean_worktree
etbz_step "re-baseline :: architecture guards green" run_architecture_tests
etbz_step "re-baseline :: contract guard green" run_contract_tests

etbz_summary "ETBZ-9 GUARD MUTATION PROOFS"
