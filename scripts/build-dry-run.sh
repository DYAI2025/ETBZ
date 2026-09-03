#!/usr/bin/env bash
# =============================================================================
# ETBZ-9 BUILD_DRY_RUN.
#
# This is a VERIFICATION step, not a deployment.
#
# Performed:            build, image inspect, short-lived `docker run --rm`,
#                       non-root assertion, image-content/secret assertions,
#                       in-container foundation runtime smoke (positive AND
#                       negative), artefact-hash reproducibility, cleanup.
#
# Deliberately NOT performed: docker compose, docker network create/connect,
#                       port publishing (-p), persistent volumes, any FuFirE
#                       contact, nginx changes, /opt/etbz runtime setup.
#
# Containers run with `--network none`: the smoke needs only loopback inside the
# container, and this makes it impossible for the dry run to touch any Docker
# network or reach any external service.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./lib-verify.sh
source "${REPO_ROOT}/scripts/lib-verify.sh"

cd "${REPO_ROOT}"

# --- revision resolution ------------------------------------------------------
# Never invented. Before the first commit exists, an explicit ETBZ_REVISION must
# be supplied (the pre-commit run uses the git TREE object id, which is a real
# content identifier for exactly what is being built).
REVISION="${ETBZ_REVISION:-}"
if [ -z "${REVISION}" ]; then
  REVISION="$(git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null || true)"
fi
if ! printf '%s' "${REVISION}" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "BUILD_DRY_RUN_FAILED: no valid 40-character revision available." >&2
  echo "Set ETBZ_REVISION explicitly, or run after a commit exists. Placeholders are refused." >&2
  exit 2
fi

BUILD_VERSION="${ETBZ_BUILD_VERSION:-$(node -p "require('${REPO_ROOT}/package.json').version")}"
SOURCE_REPOSITORY="${ETBZ_SOURCE_REPOSITORY:-https://github.com/DYAI2025/ETBZ}"
# Computed ONCE and reused for both builds: identical declared build args are a
# precondition of the reproducibility claim.
BUILD_TIMESTAMP="${ETBZ_BUILD_TIMESTAMP:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

SHORT_REVISION="${REVISION:0:12}"
IMAGE_PRIMARY="etbz-service:dryrun-${SHORT_REVISION}"
IMAGE_REPRO="etbz-service:dryrun-${SHORT_REVISION}-repro"

HASH_PRIMARY=""
HASH_REPRO=""
HASH_HOST=""

cleanup_images() {
  docker image rm -f "${IMAGE_PRIMARY}" "${IMAGE_REPRO}" >/dev/null 2>&1 || true
}
trap cleanup_images EXIT INT TERM

etbz_banner "ETBZ-9 BUILD_DRY_RUN"
printf 'revision        : %s\n' "${REVISION}"
printf 'revision source : %s\n' "${ETBZ_REVISION:+explicit ETBZ_REVISION}${ETBZ_REVISION:-git HEAD}"
printf 'build version   : %s\n' "${BUILD_VERSION}"
printf 'source repo     : %s\n' "${SOURCE_REPOSITORY}"
printf 'build timestamp : %s\n' "${BUILD_TIMESTAMP}"
printf 'primary image   : %s\n' "${IMAGE_PRIMARY}"
printf 'docker          : %s\n' "$(docker --version)"

# --- build --------------------------------------------------------------------
build_image() {
  local tag="$1"
  docker build \
    --tag "${tag}" \
    --build-arg "GIT_COMMIT=${REVISION}" \
    --build-arg "BUILD_VERSION=${BUILD_VERSION}" \
    --build-arg "SOURCE_REPOSITORY=${SOURCE_REPOSITORY}" \
    --build-arg "BUILD_TIMESTAMP=${BUILD_TIMESTAMP}" \
    --file "${REPO_ROOT}/Dockerfile" \
    "${REPO_ROOT}"
}

build_primary() { build_image "${IMAGE_PRIMARY}"; }

# The reproducibility build runs with --no-cache ON PURPOSE. A second build that
# is served entirely from the layer cache re-reports the first build's artefact,
# so an equality assertion over it proves nothing. Rebuilding from scratch is
# what makes the comparison meaningful.
build_repro() {
  docker build \
    --no-cache \
    --tag "${IMAGE_REPRO}" \
    --build-arg "GIT_COMMIT=${REVISION}" \
    --build-arg "BUILD_VERSION=${BUILD_VERSION}" \
    --build-arg "SOURCE_REPOSITORY=${SOURCE_REPOSITORY}" \
    --build-arg "BUILD_TIMESTAMP=${BUILD_TIMESTAMP}" \
    --file "${REPO_ROOT}/Dockerfile" \
    "${REPO_ROOT}"
}

# --- provenance gate ----------------------------------------------------------
# Proves the build REFUSES to produce an image without a real revision, so
# GIT_COMMIT cannot silently become "unknown".
prove_provenance_gate_rejects_placeholder() {
  docker build \
    --tag "etbz-service:dryrun-provenance-negative" \
    --build-arg "GIT_COMMIT=unknown" \
    --build-arg "BUILD_VERSION=${BUILD_VERSION}" \
    --build-arg "SOURCE_REPOSITORY=${SOURCE_REPOSITORY}" \
    --build-arg "BUILD_TIMESTAMP=${BUILD_TIMESTAMP}" \
    --file "${REPO_ROOT}/Dockerfile" \
    "${REPO_ROOT}"
}

prove_provenance_gate_rejects_missing() {
  docker build \
    --tag "etbz-service:dryrun-provenance-negative" \
    --build-arg "BUILD_VERSION=${BUILD_VERSION}" \
    --build-arg "SOURCE_REPOSITORY=${SOURCE_REPOSITORY}" \
    --build-arg "BUILD_TIMESTAMP=${BUILD_TIMESTAMP}" \
    --file "${REPO_ROOT}/Dockerfile" \
    "${REPO_ROOT}"
}

assert_labels() {
  local labels
  labels="$(docker image inspect --format '{{json .Config.Labels}}' "${IMAGE_PRIMARY}")"
  printf 'labels: %s\n' "${labels}"
  REVISION="${REVISION}" SOURCE_REPOSITORY="${SOURCE_REPOSITORY}" BUILD_VERSION="${BUILD_VERSION}" \
  node -e '
    const labels = JSON.parse(process.argv[1] || "{}");
    const expected = {
      "org.opencontainers.image.revision": process.env.REVISION,
      "org.opencontainers.image.source": process.env.SOURCE_REPOSITORY,
      "org.opencontainers.image.version": process.env.BUILD_VERSION,
    };
    let failed = false;
    for (const [key, value] of Object.entries(expected)) {
      if (labels[key] !== value) {
        console.error(`PROVENANCE_LABEL_MISMATCH: ${key}=${labels[key]} expected ${value}`);
        failed = true;
      }
    }
    for (const forbidden of ["unknown", "none", "latest", ""]) {
      if (labels["org.opencontainers.image.revision"] === forbidden) {
        console.error("PROVENANCE_LABEL_PLACEHOLDER: revision is a placeholder");
        failed = true;
      }
    }
    if (failed) process.exit(1);
    console.log("provenance labels correct (revision, source, version)");
  ' "${labels}"
}

# --- non-root -----------------------------------------------------------------
assert_configured_user_non_root() {
  local user
  user="$(docker image inspect --format '{{.Config.User}}' "${IMAGE_PRIMARY}")"
  printf 'configured user : %s\n' "${user}"
  case "${user}" in
    ""|"root"|"0"|"0:0") echo "NON_ROOT_ASSERTION_FAILED: image runs as root" >&2; return 1 ;;
  esac
  return 0
}

assert_runtime_uid_non_root() {
  local uid gid
  uid="$(docker run --rm --network none "${IMAGE_PRIMARY}" id -u)"
  gid="$(docker run --rm --network none "${IMAGE_PRIMARY}" id -g)"
  printf 'runtime uid:gid : %s:%s\n' "${uid}" "${gid}"
  if [ "${uid}" = "0" ]; then
    echo "NON_ROOT_ASSERTION_FAILED: runtime uid is 0" >&2
    return 1
  fi
  if [ "${uid}" != "10002" ]; then
    echo "NON_ROOT_ASSERTION_FAILED: expected uid 10002, got ${uid}" >&2
    return 1
  fi
  return 0
}

# --- image content / secret assertions ----------------------------------------
assert_no_secrets_in_image() {
  # Runs as root inside the throwaway container ON PURPOSE: a check performed as
  # an unprivileged user could report "absent" merely because it cannot stat the
  # path. Only /root/.env is asserted absent - not that /root is empty.
  docker run --rm --network none --user 0:0 "${IMAGE_PRIMARY}" sh -c '
    set -eu
    status=0
    for path in \
      /app/.env /app/.env.local /app/.env.example /app/.env.production \
      /root/.env /root/.npmrc /app/.npmrc \
      /app/.git /app/.claude /app/settings.local.json \
      /app/tests /app/scripts /app/docs /app/openapi /app/contracts \
      /app/.github /app/vitest.config.ts
    do
      if [ -e "$path" ]; then
        echo "IMAGE_CONTENT_ASSERTION_FAILED: $path is present in the image"
        status=1
      fi
    done
    if [ "$status" -eq 0 ]; then
      echo "image carries no environment file, host config, git metadata or verification tooling"
    fi
    exit "$status"
  '
}

assert_no_secret_in_build_history() {
  local history_file
  history_file="$(mktemp)"
  {
    docker history --no-trunc "${IMAGE_PRIMARY}"
    docker image inspect "${IMAGE_PRIMARY}"
  } > "${history_file}"
  local scanner status=0
  scanner="$(etbz_gitleaks_bin || true)"
  if [ -n "${scanner}" ]; then
    "${scanner}" detect --source "${history_file}" --no-git --redact --no-banner --exit-code 1 >/dev/null 2>&1 || status=$?
    if [ "${status}" -ne 0 ]; then
      echo "IMAGE_HISTORY_SECRET_FOUND: the scanner reported a finding in build history/config" >&2
      rm -f "${history_file}"
      return 1
    fi
    echo "build history and image config scanned by the secret scanner: no finding"
  else
    echo "secret scanner unavailable - falling back to pattern assertions"
  fi
  if grep -qiE '(api[_-]?key|password|secret|token)[[:space:]]*=[[:space:]]*[^ ]{8,}' "${history_file}"; then
    echo "IMAGE_HISTORY_SECRET_PATTERN: credential-shaped assignment found in build history" >&2
    rm -f "${history_file}"
    return 1
  fi
  echo "no credential-shaped build argument in image history"
  rm -f "${history_file}"
  return 0
}

etbz_banner "BUILD_DRY_RUN :: PHASE 1 - BUILD AND INSPECT"
etbz_step "docker build :: primary image" build_primary
etbz_expect_failure "provenance gate rejects GIT_COMMIT=unknown" prove_provenance_gate_rejects_placeholder
etbz_expect_failure "provenance gate rejects a missing GIT_COMMIT" prove_provenance_gate_rejects_missing
etbz_step "image inspect :: provenance labels" assert_labels
etbz_step "image inspect :: configured user is non-root" assert_configured_user_non_root
etbz_step "docker run :: runtime uid is 10002 (non-root)" assert_runtime_uid_non_root
etbz_step "image content :: no env file, host config or secret material" assert_no_secrets_in_image
etbz_step "image history :: no secret in build args or config" assert_no_secret_in_build_history

# --- application artefact hash ------------------------------------------------
# SHA-256 over the compiled dist/ tree (sorted relative paths + contents).
# Deliberately excludes volatile OCI metadata, which is why this - and not an
# image digest - is what the reproducibility claim is made about.
read -r -d '' ARTIFACT_HASH_JS <<'JS' || true
import { createHash } from "node:crypto";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
const root = process.argv[1] || "/app/dist";
const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(full);
  }
};
walk(root);
files.sort();
const hash = createHash("sha256");
for (const file of files) {
  hash.update(relative(root, file).split("\\").join("/"));
  hash.update("|");
  hash.update(readFileSync(file));
  hash.update("|");
}
process.stdout.write(hash.digest("hex") + " " + files.length + "\n");
JS

artifact_hash_of_image() {
  docker run --rm --network none "$1" node --input-type=module -e "${ARTIFACT_HASH_JS}" /app/dist
}

capture_primary_artifact_hash() {
  HASH_PRIMARY="$(artifact_hash_of_image "${IMAGE_PRIMARY}")"
  printf 'image artefact hash (primary) : %s\n' "${HASH_PRIMARY}"
  test -n "${HASH_PRIMARY}"
}

capture_host_artifact_hash() {
  if [ ! -d "${REPO_ROOT}/dist" ]; then
    echo "host dist/ absent - host/image artefact comparison skipped (run npm run build first)"
    HASH_HOST="skipped"
    return 0
  fi
  HASH_HOST="$(node --input-type=module -e "${ARTIFACT_HASH_JS}" "${REPO_ROOT}/dist")"
  printf 'host artefact hash            : %s\n' "${HASH_HOST}"
  return 0
}

compare_host_and_image_artifact() {
  if [ "${HASH_HOST}" = "skipped" ]; then
    echo "host/image comparison not performed (no host dist/)"
    return 0
  fi
  if [ "${HASH_HOST}" = "${HASH_PRIMARY}" ]; then
    echo "host-built and image-built application artefacts are IDENTICAL"
    return 0
  fi
  # Reported honestly, and NOT treated as a gate failure: the host runs Node 22
  # while the image runs Node 24 (see docs/adr/0005). The binding claim is
  # image-to-image reproducibility, asserted below.
  echo "NOTE: host and image artefact hashes differ."
  echo "  host  : ${HASH_HOST}"
  echo "  image : ${HASH_PRIMARY}"
  echo "  This is reported, not claimed as reproducible. The enforced claim is"
  echo "  image-to-image reproducibility from the same commit and build args."
  return 0
}

# --- runtime foundation smoke (in-container, loopback only) -------------------
read -r -d '' SMOKE_JS <<'JS' || true
const port = process.env.ETBZ_PORT || "8120";
const base = "http://127.0.0.1:" + port;
const expectedReady = Number(process.env.SMOKE_EXPECT_READY || "200");
await import("file:///app/dist/main.js");
let reachable = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const probe = await fetch(base + "/health");
    if (probe.ok) { reachable = true; break; }
  } catch { /* not listening yet */ }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!reachable) {
  console.error("SMOKE_FAILED: the foundation never became reachable on loopback");
  process.exit(1);
}
const health = await fetch(base + "/health");
const healthBody = await health.json();
const ready = await fetch(base + "/ready");
const readyBody = await ready.json();
console.log(JSON.stringify({
  health: { status: health.status, body: healthBody },
  ready: { status: ready.status, reportStatus: readyBody.status,
           capabilities: (readyBody.capabilities || []).map((c) => c.name + ":" + c.status) },
}));
if (health.status !== 200 || healthBody.status !== "alive") {
  console.error("SMOKE_FAILED: /health did not answer 200 {status:alive}");
  process.exit(1);
}
if (Object.keys(healthBody).length !== 1) {
  console.error("SMOKE_FAILED: /health returned more than the liveness field");
  process.exit(1);
}
if (ready.status !== expectedReady) {
  console.error("SMOKE_FAILED: /ready expected " + expectedReady + " but got " + ready.status);
  process.exit(1);
}
process.exit(0);
JS

smoke_positive() {
  docker run --rm --network none \
    -e ETBZ_ENV=staging \
    -e LOG_LEVEL=info \
    -e ETBZ_PORT=8120 \
    -e SMOKE_EXPECT_READY=200 \
    "${IMAGE_PRIMARY}" node --input-type=module -e "${SMOKE_JS}"
}

smoke_negative_missing_config() {
  # No ETBZ_ENV: liveness must stay 200 while readiness fails closed with 503.
  docker run --rm --network none \
    -e LOG_LEVEL=info \
    -e ETBZ_PORT=8120 \
    -e SMOKE_EXPECT_READY=503 \
    "${IMAGE_PRIMARY}" node --input-type=module -e "${SMOKE_JS}"
}

smoke_negative_malformed_config() {
  docker run --rm --network none \
    -e ETBZ_ENV=not-a-valid-environment \
    -e LOG_LEVEL=info \
    -e ETBZ_PORT=8120 \
    -e SMOKE_EXPECT_READY=503 \
    "${IMAGE_PRIMARY}" node --input-type=module -e "${SMOKE_JS}"
}

# --- reproducibility ----------------------------------------------------------
capture_repro_artifact_hash() {
  HASH_REPRO="$(artifact_hash_of_image "${IMAGE_REPRO}")"
  printf 'image artefact hash (repro)   : %s\n' "${HASH_REPRO}"
  test -n "${HASH_REPRO}"
}

assert_artifact_hashes_match() {
  if [ "${HASH_PRIMARY}" != "${HASH_REPRO}" ]; then
    echo "REPRODUCIBILITY_FAILED: artefact hashes differ between two builds of the same inputs" >&2
    echo "  build 1: ${HASH_PRIMARY}" >&2
    echo "  build 2: ${HASH_REPRO}" >&2
    return 1
  fi
  echo "application artefact hash identical across both builds: ${HASH_PRIMARY}"
  return 0
}

assert_revision_labels_match() {
  local primary repro
  primary="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${IMAGE_PRIMARY}")"
  repro="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${IMAGE_REPRO}")"
  if [ "${primary}" != "${repro}" ] || [ "${primary}" != "${REVISION}" ]; then
    echo "REPRODUCIBILITY_FAILED: revision metadata differs (${primary} vs ${repro})" >&2
    return 1
  fi
  echo "both builds carry identical, correct source revision metadata: ${primary}"
  return 0
}

smoke_repro_image() {
  docker run --rm --network none \
    -e ETBZ_ENV=staging -e LOG_LEVEL=info -e ETBZ_PORT=8120 -e SMOKE_EXPECT_READY=200 \
    "${IMAGE_REPRO}" node --input-type=module -e "${SMOKE_JS}"
}

# --- cleanup ------------------------------------------------------------------
remove_dry_run_images() {
  docker image rm -f "${IMAGE_PRIMARY}" "${IMAGE_REPRO}" >/dev/null 2>&1 || true
  docker image rm -f "etbz-service:dryrun-provenance-negative" >/dev/null 2>&1 || true
  echo "dry-run images removed"
}

assert_no_dry_run_residue() {
  local images containers status=0
  images="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^etbz-service:dryrun' || true)"
  containers="$(docker ps -a --format '{{.Names}} {{.Image}}' | grep -E 'etbz-service:dryrun' || true)"
  if [ -n "${images}" ]; then
    echo "DRY_RUN_RESIDUE: dry-run images remain:" >&2
    printf '%s\n' "${images}" >&2
    status=1
  else
    echo "no etbz-service:dryrun* image remains"
  fi
  if [ -n "${containers}" ]; then
    echo "DRY_RUN_RESIDUE: dry-run containers remain:" >&2
    printf '%s\n' "${containers}" >&2
    status=1
  else
    echo "no etbz-service dry-run container remains"
  fi
  return "${status}"
}

etbz_banner "BUILD_DRY_RUN :: PHASE 2 - ARTEFACT AND RUNTIME SMOKE"
etbz_step "artefact :: hash compiled dist/ inside the image" capture_primary_artifact_hash
etbz_step "artefact :: hash host-built dist/" capture_host_artifact_hash
etbz_step "artefact :: compare host and image artefacts" compare_host_and_image_artifact
etbz_step "smoke :: valid configuration -> /health 200 alive, /ready 200" smoke_positive
etbz_step "smoke :: missing ETBZ_ENV -> /health 200 alive, /ready 503" smoke_negative_missing_config
etbz_step "smoke :: malformed ETBZ_ENV -> /health 200 alive, /ready 503" smoke_negative_malformed_config

etbz_banner "BUILD_DRY_RUN :: PHASE 3 - REPRODUCIBILITY"
etbz_step "docker build :: second build, identical inputs, --no-cache" build_repro
etbz_step "artefact :: hash compiled dist/ in the second image" capture_repro_artifact_hash
etbz_step "reproducibility :: artefact hashes identical" assert_artifact_hashes_match
etbz_step "reproducibility :: revision metadata identical and correct" assert_revision_labels_match
etbz_step "reproducibility :: second image passes the same runtime smoke" smoke_repro_image

etbz_banner "BUILD_DRY_RUN :: PHASE 4 - CLEANUP"
etbz_step "cleanup :: remove dry-run images" remove_dry_run_images
etbz_step "cleanup :: prove no dry-run image or container remains" assert_no_dry_run_residue

etbz_summary "ETBZ-9 BUILD_DRY_RUN"
