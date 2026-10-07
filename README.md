# sentinelone-mcp

Multitenant Streamable HTTP wrapper for [sentinel-one/purple-mcp](https://github.com/Sentinel-One/purple-mcp), built so the [wyre-technology MCP gateway](https://github.com/wyre-technology/mcp-gateway) can forward per-tenant SentinelOne credentials as HTTP headers.

## Why

`purple-mcp` is a great first-party MCP server, but it reads its SentinelOne console token + URL from environment variables at process startup, which makes it single-tenant per container. Our gateway is multi-tenant: every request carries the calling org's credentials as HTTP headers, and the vendor container has to translate those headers into something the upstream understands.

This image bundles `purple-mcp` plus a small Node/Fastify proxy. The proxy:

1. Listens on `:8080` with `POST /mcp` and `GET /health`.
2. Reads `X-S1-API-Token` and `X-S1-Console-URL` from each incoming request (legacy `x-purplemcp-token` / `x-purplemcp-base-url` still accepted). A request missing either the token or the console URL, after per-field fallback, gets **401**, which Conduit's vendor-monitor treats as reachable but auth-gated.
3. Lazily spawns one `purple-mcp --mode streamable-http` child per `(token, base-url)` tenant on a private loopback port, with the right env vars set.
4. Proxies the request body to that child and streams the response back.
5. Evicts idle children after 60 minutes (`IDLE_EVICT_MS`).

The result is a single container that the gateway can talk to like any other vendor MCP server.

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | Public listen port. |
| `PURPLE_MCP_DIR` | `/opt/purple-mcp` | Where purple-mcp source + venv live. |
| `PURPLE_MCP_PYTHON` | `/opt/purple-mcp/.venv/bin/python` | Python interpreter from the upstream venv. |
| `IDLE_EVICT_MS` | `3600000` | Idle tenant timeout (60 min). Longer keeps children warm and avoids repeated cold starts. |
| `SPAWN_READY_TIMEOUT_MS` | `30000` | How long to wait for a child to start serving HTTP. |
| `MAX_CHILDREN` | `50` | Cap on distinct concurrent tenant children. A new-tenant spawn beyond the cap is rejected (`502`) rather than evicting an existing child. |
| `LOG_LEVEL` | `info` | Fastify log level. |

## Request headers

The gateway must forward these headers on every authenticated `/mcp` request. Names are case-insensitive. When both pairs are present, the `X-S1-*` value wins per field.

| Header | SentinelOne credential |
|---|---|
| `X-S1-API-Token` | `PURPLEMCP_CONSOLE_TOKEN` (Account- or Site-level service user token). Catalog `headerMapping` name. |
| `X-S1-Console-URL` | `PURPLEMCP_CONSOLE_BASE_URL` (e.g. `https://yourtenant.sentinelone.net`). Catalog `headerMapping` name. |
| `x-purplemcp-token` | Legacy alias for the API token. |
| `x-purplemcp-base-url` | Legacy alias for the console URL. |

`POST /mcp` without a token and console URL returns **401** (JSON-RPC `-32001`). Vendor-monitor's credless `initialize` probe relies on that: 401/403 means the sidecar is up but auth-gated, while 400 marks the slug DOWN. `GET /health` stays unauthenticated.

## Build

```bash
docker build -t ghcr.io/wyre-ai/sentinelone-mcp:latest .
```

## License

Apache-2.0. The bundled `purple-mcp` is MIT-licensed by SentinelOne.
