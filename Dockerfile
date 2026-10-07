# syntax=docker/dockerfile:1.10
#
# Multitenant Streamable HTTP wrapper for sentinel-one/purple-mcp.
#
# purple-mcp natively supports streamable-http transport but reads its
# SentinelOne credentials (PURPLEMCP_CONSOLE_TOKEN / PURPLEMCP_CONSOLE_BASE_URL)
# from environment variables at process startup. The wyre-technology MCP
# gateway forwards per-tenant credentials as HTTP headers on every request,
# so this image runs a small Node proxy on port 8080 that:
#
#   1. Reads X-S1-API-Token / X-S1-Console-URL (legacy x-purplemcp-* still
#      accepted). Missing credentials answer 401 so vendor-monitor counts
#      the sidecar reachable.
#   2. Lazily spawns one purple-mcp child per (token, base_url) tenant on a
#      private loopback port with the right env vars
#   3. Proxies the request to that child and streams the response back
#   4. Evicts idle children after a timeout
#
# Result: a single container that the gateway can talk to like any other
# vendor MCP server (POST http://gwp-sentinelone:8080/mcp).

# ---- Stage 1: install purple-mcp into a virtualenv via uv ----
# The uv image and the runtime stage must BOTH be built on the same python
# minor version, so the system interpreter lives at the same path in both. We
# pin uv to that system python (UV_PYTHON_PREFERENCE=only-system +
# UV_PYTHON_DOWNLOADS=never) so the venv's bin/python symlinks to a path that
# ALSO exists in the runtime image.
#
# Without this, uv defaults to downloading its own managed CPython into
# ~/.local/share/uv/python/... and points the venv there. That directory is NOT
# under /opt/purple-mcp, so copying only /opt/purple-mcp into the runtime stage
# leaves /opt/purple-mcp/.venv/bin/python as a DANGLING symlink — and the proxy
# crashes with `spawn /opt/purple-mcp/.venv/bin/python ENOENT` on the first tool
# call, which the gateway surfaces to clients as "HTTP 502 for sentinelone".
#
# 2026-08-20 incident: this stage was left pinned to python3.12 when an
# unreviewed dependabot docker-group bump (#27, 2026-07-16) moved the runtime
# stage below from python:3.12-slim to python:3.14-slim, silently breaking the
# invariant above. It went undetected for over a month because a real Docker
# build only runs when semantic-release actually cuts a version (most pushes
# in between were skipped, not passing) -- the build-time smoke test below did
# its job the moment a real build finally ran, failing loudly (exit 127,
# `/opt/purple-mcp/.venv/bin/python: not found`) instead of shipping a broken
# image. Keep this stage's python tag and the runtime stage's FROM tag in
# lockstep on every future base-image bump.
FROM ghcr.io/astral-sh/uv:python3.14-bookworm-slim AS upstream

ENV PURPLE_MCP_REF=main \
    UV_PYTHON_PREFERENCE=only-system \
    UV_PYTHON_DOWNLOADS=never
WORKDIR /opt
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth=1 --branch "${PURPLE_MCP_REF}" \
      https://github.com/Sentinel-One/purple-mcp.git /opt/purple-mcp \
 && cd /opt/purple-mcp \
 && git submodule update --init --recursive --depth=1 \
 && uv sync --locked --no-dev --python /usr/local/bin/python3.14

# ---- Stage 2: build the Node proxy ----
FROM node:26-bookworm-slim AS proxy-build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

# ---- Stage 3: runtime image ----
FROM python:3.14-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    NODE_ENV=production \
    PORT=8080

# Install Node.js 22 (no apt repo - use the official tarball)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && curl -fsSL https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz -o /tmp/node.tar.xz \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
 && rm /tmp/node.tar.xz \
 && rm -rf /var/lib/apt/lists/*

# Bring in purple-mcp + its venv
COPY --from=upstream /opt/purple-mcp /opt/purple-mcp
ENV PURPLE_MCP_DIR=/opt/purple-mcp \
    PURPLE_MCP_PYTHON=/opt/purple-mcp/.venv/bin/python

# Build-time smoke test: run the venv interpreter through the EXACT module the
# proxy spawns at runtime. If the cross-stage copy ever leaves the venv's python
# as a dangling symlink again, this fails the build here instead of shipping an
# image that crashes with `spawn ... ENOENT` (→ gateway 502) on the first call.
RUN "${PURPLE_MCP_PYTHON}" -m purple_mcp.cli --help > /dev/null

# Bring in the compiled proxy
WORKDIR /app
COPY --from=proxy-build /app/node_modules ./node_modules
COPY --from=proxy-build /app/dist ./dist
COPY --from=proxy-build /app/package.json ./package.json

LABEL io.modelcontextprotocol.server.name="io.github.WYRE-AI/sentinelone-mcp"

EXPOSE 8080
CMD ["node", "dist/index.js"]
