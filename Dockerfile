# syntax=docker/dockerfile:1.7
# =============================================================================
# ETBZ service foundation - multi-stage image (ETBZ-9)
#
# Contract:
#   - Node.js 24 LTS, pinned by immutable digest so the same commit resolves to
#     the same base layer regardless of when it is built;
#   - runtime runs as a non-root user (uid/gid 10002);
#   - provenance labels carry the exact source revision;
#   - the build FAILS CLOSED when GIT_COMMIT is absent or is a placeholder:
#     the revision never silently degrades to "unknown";
#   - no environment file, host configuration or secret enters the image.
#     `.dockerignore` keeps `.env*` out of the build context entirely, and only
#     explicitly named paths are copied.
# =============================================================================

# node:24-bookworm-slim, resolved 2026-09-03. Update deliberately, never
# implicitly - see docs/adr/0005-reproducibility-scope.md.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

# -----------------------------------------------------------------------------
# Stage: dependencies (full tree, needed to compile)
# -----------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` is the install gate: it refuses to run when package.json and the
# lockfile disagree, so lockfile drift fails the image build too.
RUN npm ci --no-audit --no-fund

# -----------------------------------------------------------------------------
# Stage: provenance gate + compile
# -----------------------------------------------------------------------------
FROM deps AS build
ARG GIT_COMMIT
ARG BUILD_VERSION
ARG SOURCE_REPOSITORY
ARG BUILD_TIMESTAMP

# Fail-closed provenance gate. A missing, short, uppercase or placeholder
# revision aborts the build. The received value is never echoed.
RUN set -eu; \
    if ! printf '%s' "${GIT_COMMIT:-}" | grep -Eq '^[0-9a-f]{40}$'; then \
      echo 'PROVENANCE_GATE_FAILED: build-arg GIT_COMMIT must be a 40-character lowercase git commit sha; placeholders such as "unknown" are rejected.' >&2; \
      exit 1; \
    fi; \
    if [ -z "${BUILD_VERSION:-}" ]; then \
      echo 'PROVENANCE_GATE_FAILED: build-arg BUILD_VERSION must be a non-empty build version identifier.' >&2; \
      exit 1; \
    fi; \
    if [ -z "${SOURCE_REPOSITORY:-}" ]; then \
      echo 'PROVENANCE_GATE_FAILED: build-arg SOURCE_REPOSITORY must name the source repository.' >&2; \
      exit 1; \
    fi

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# -----------------------------------------------------------------------------
# Stage: production dependency tree only
# -----------------------------------------------------------------------------
FROM deps AS prod-deps
RUN npm prune --omit=dev

# -----------------------------------------------------------------------------
# Stage: runtime
# -----------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

ARG GIT_COMMIT
ARG BUILD_VERSION
ARG SOURCE_REPOSITORY
ARG BUILD_TIMESTAMP

LABEL org.opencontainers.image.title="etbz-service" \
      org.opencontainers.image.description="ETBZ service foundation (ETBZ-9): liveness and configuration readiness." \
      org.opencontainers.image.source="${SOURCE_REPOSITORY}" \
      org.opencontainers.image.url="${SOURCE_REPOSITORY}" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.created="${BUILD_TIMESTAMP}" \
      org.opencontainers.image.licenses="UNLICENSED" \
      org.opencontainers.image.base.name="node:24-bookworm-slim" \
      de.etbz.slice="ETBZ-9" \
      de.etbz.surface="health,ready"

# Non-root runtime identity. Fixed uid/gid so volume and policy expectations are
# stable across rebuilds.
RUN set -eu; \
    groupadd --gid 10002 etbz; \
    useradd --uid 10002 --gid 10002 --no-create-home --shell /usr/sbin/nologin etbz

WORKDIR /app

COPY --from=prod-deps --chown=10002:10002 /app/node_modules ./node_modules
COPY --from=build     --chown=10002:10002 /app/dist         ./dist
COPY --chown=10002:10002 package.json ./package.json

# Build metadata is baked in as ENV so the running process can report its own
# provenance. `src/app/buildInfo.ts` rejects placeholders rather than accepting
# a default.
ENV NODE_ENV=production \
    ETBZ_GIT_COMMIT=${GIT_COMMIT} \
    ETBZ_BUILD_VERSION=${BUILD_VERSION} \
    ETBZ_SOURCE_REPOSITORY=${SOURCE_REPOSITORY} \
    ETBZ_BUILD_TIMESTAMP=${BUILD_TIMESTAMP} \
    ETBZ_PORT=8120

USER 10002:10002

EXPOSE 8120

# Liveness only, consistent with GET /health. Uses the bundled Node runtime so
# no extra package (curl/wget) has to enter the image.
#
# The port is resolved with the SAME fail-open rule as the application
# (src/app/configuration/config.ts: resolveBootstrapPort). A naive
# `process.env.ETBZ_PORT || 8120` would probe a malformed value while the
# application had already fallen back to 8120, so a merely misconfigured
# container would be reported unhealthy by its own probe.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "const raw=(process.env.ETBZ_PORT||'').trim();const port=(/^[0-9]{1,5}$/.test(raw)&&+raw>=1&&+raw<=65535)?raw:'8120';fetch('http://127.0.0.1:'+port+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/main.js"]
