# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Initial release: multitenant Streamable HTTP wrapper around `sentinel-one/purple-mcp`.
- Fastify proxy on `:8080` exposing `POST /mcp` and `GET /health`.
- Per-tenant lazy spawning of `purple-mcp --mode streamable-http` children, keyed by `(token, base-url)` hash, with idle eviction.
- Header-based credential injection (`x-purplemcp-token`, `x-purplemcp-base-url`).
- Multi-stage Dockerfile bundling `uv`-installed `purple-mcp` plus the Node proxy.
- GitHub Actions workflow that builds and publishes the image to `ghcr.io/wyre-technology/sentinelone-mcp`.

### Changed
- Default `IDLE_EVICT_MS` raised from 15 min to 60 min so a spawned purple-mcp child stays warm longer between requests, reducing how often a request pays purple-mcp's ~10s cold start (which can exceed the gateway's per-vendor tool-fetch timeout and briefly hide SentinelOne tools).

### Added
- `MAX_CHILDREN` env-overridable cap (default 50) on the number of distinct concurrent purple-mcp tenant children. Without a cap, a burst of distinct tenants could spawn unbounded child processes, each with a real memory/CPU footprint, risking resource exhaustion for the whole gateway. When at capacity, a new-tenant spawn is rejected with a clear `502`/`-32002` error (same shape as existing spawn-failure errors) rather than evicting an existing child — there's no in-flight/"busy" tracking on `TenantChild` yet, so an LRU-style evict-to-make-room could kill a child mid-flight on a concurrent request from that same tenant. `GET /health` now also reports `maxTenants` alongside `tenants`.

### Fixed
- **Credless vendor-monitor `initialize` returned HTTP 400, so public status marked `sentinelone` DOWN while the container was healthy.** Missing tenant credentials now return **401** (JSON-RPC `-32001`), which the monitor treats as reachable but auth-gated. `POST /mcp` also accepts the catalog headers `X-S1-API-Token` and `X-S1-Console-URL` (case-insensitive), and still accepts legacy `x-purplemcp-token` / `x-purplemcp-base-url`. S2S verification and `GET /health` are unchanged.
- **purple-mcp child failed to spawn (`spawn … ENOENT`), so the gateway returned `HTTP 502 for sentinelone` on tool discovery and clients saw no SentinelOne tools.** The `uv`-built virtualenv pointed `.venv/bin/python` at a uv-managed CPython living outside `/opt/purple-mcp`, leaving a dangling symlink once only `/opt/purple-mcp` was copied into the runtime stage. Pin `uv` to the system interpreter (`UV_PYTHON_PREFERENCE=only-system`, `UV_PYTHON_DOWNLOADS=never`, `uv sync --python /usr/local/bin/python3.12`) so the venv interpreter exists in the runtime image, and add a build-time smoke test (`purple_mcp.cli --help`) that fails the build if it ever regresses.
- Spawn failures no longer crash the whole wrapper. The child `ChildProcess` `'error'` event is now handled: the failure is scoped to the offending request (clean `502` / `-32002`), other tenants keep serving, and the next request retries a fresh spawn. Previously an unhandled `'error'` event threw, killing the process for all tenants and triggering a container restart loop.
