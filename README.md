# sentinelone-mcp

Multitenant Streamable HTTP wrapper for [sentinel-one/purple-mcp](https://github.com/Sentinel-One/purple-mcp), built so the [wyre-technology MCP gateway](https://github.com/wyre-technology/mcp-gateway) can forward per-tenant SentinelOne credentials as HTTP headers.

## Why

`purple-mcp` is a great first-party MCP server, but it reads its SentinelOne console token + URL from environment variables at process startup, which makes it single-tenant per container. Our gateway is multi-tenant: every request carries the calling org's credentials as HTTP headers, and the vendor container has to translate those headers into something the upstream understands.

This image bundles `purple-mcp` plus a small Node/Fastify proxy. The proxy:

1. Listens on `:8080` with `POST /mcp` and `GET /health`.
2. Requires a valid `X-Gateway-S2S` proof, then reads `X-S1-API-Token` and `X-S1-Console-URL` from that request (legacy `x-purplemcp-token` / `x-purplemcp-base-url` still accepted). A request missing either the token or the console URL, after per-field fallback, gets **401**, which Conduit's vendor-monitor treats as reachable but auth-gated. There is no fallback to `PURPLEMCP_CONSOLE_*` in the environment.
3. Lazily spawns one `purple-mcp --mode streamable-http` child per `(token, base-url)` tenant on a private loopback port, with the right env vars set.
4. Proxies the request body to that child and streams the response back.
5. Evicts idle children after 60 minutes (`IDLE_EVICT_MS`).

The result is a single container that the gateway can talk to like any other vendor MCP server.

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | Public listen port. |
| `MCP_HTTP_HOST` | `0.0.0.0` when a real secret is set | Bind address. A configured `CONDUIT_S2S_SECRET` honors this value, including `0.0.0.0`. Unset keeps that historical bind. The image and Compose set `0.0.0.0` inside the container and publish `127.0.0.1:8080:8080` on the host. |
| `CONDUIT_S2S_SECRET` | — | Required. Service-to-service secret. The process logs an error and exits non-zero when this is empty or a known placeholder (`changeme`, `secret`, `replace-me`, `replace-with-a-real-secret`, and the other example values). Generate one with `openssl rand -hex 32`. Compose will not start without it. The value is never logged. |
| `MCP_ALLOW_INSECURE_DEV` | unset | Set to exactly `1` only for local development to start without `CONDUIT_S2S_SECRET`. The process logs a warning, does not enforce `X-Gateway-S2S`, and binds `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` refuses to start. A known placeholder secret still refuses to start. |
| `PURPLE_MCP_DIR` | `/opt/purple-mcp` | Where purple-mcp source + venv live. |
| `PURPLE_MCP_PYTHON` | `/opt/purple-mcp/.venv/bin/python` | Python interpreter from the upstream venv. |
| `IDLE_EVICT_MS` | `3600000` | Idle tenant timeout (60 min). Longer keeps children warm and avoids repeated cold starts. |
| `SPAWN_READY_TIMEOUT_MS` | `30000` | How long to wait for a child to start serving HTTP. |
| `MAX_CHILDREN` | `50` | Cap on distinct concurrent tenant children. A new-tenant spawn beyond the cap is rejected (`502`) rather than evicting an existing child. |
| `LOG_LEVEL` | `info` | Fastify log level. Startup refusals and the insecure-dev warning go to stderr and are not filtered by this level. |

Copy [`.env.example`](.env.example). Leave `CONDUIT_S2S_SECRET` empty in that file; put a real value only in an uncommitted `.env` or the process environment.

## Request headers

This server is gateway mode. It does not read `PURPLEMCP_CONSOLE_TOKEN` or `PURPLEMCP_CONSOLE_BASE_URL` from the environment for an incoming request. The gateway must forward these headers on every `/mcp` request. Names are case-insensitive. When both pairs are present, the `X-S1-*` value wins per field.

| Header | SentinelOne credential |
|---|---|
| `X-Gateway-S2S` | Service-to-service proof. Required on `/mcp` when `CONDUIT_S2S_SECRET` is set. Not a SentinelOne credential. |
| `X-S1-API-Token` | `PURPLEMCP_CONSOLE_TOKEN` passed to that request's child (Account- or Site-level service user token). Catalog `headerMapping` name. |
| `X-S1-Console-URL` | `PURPLEMCP_CONSOLE_BASE_URL` passed to that request's child (e.g. `https://yourtenant.sentinelone.net`). Catalog `headerMapping` name. |
| `x-purplemcp-token` | Legacy alias for the API token. |
| `x-purplemcp-base-url` | Legacy alias for the console URL. |

### X-Gateway-S2S

With `CONDUIT_S2S_SECRET` set, every `POST /mcp` must include `X-Gateway-S2S`. The check is `verifyS2sHeader` in [`src/s2s-verify.ts`](src/s2s-verify.ts): the header value is `t=<unix seconds>,v1=<hex>`, where the hex is HMAC-SHA256 of the literal string `t=<unix seconds>` keyed with `CONDUIT_S2S_SECRET` (64 lowercase hex characters). The timestamp must be within 300 seconds of the server clock. A missing or invalid header is HTTP 401, before tenant credentials are read, and the secret is not logged.

```
X-Gateway-S2S: t=1710000000,v1=<hmac-sha256 hex of "t=1710000000">
```

In gateway mode, `/mcp` also requires `X-S1-API-Token` and `X-S1-Console-URL` (or the legacy `x-purplemcp-*` pair, including a mixed pair). A request missing either credential is HTTP 401 (JSON-RPC `-32001`) and does not fall back to `PURPLEMCP_CONSOLE_*` in the process environment. Vendor-monitor's credless `initialize` probe relies on that: 401/403 means the sidecar is up but auth-gated, while 400 marks the slug DOWN.

`GET /health` stays unauthenticated and does not read credentials.

## Build

```bash
docker build -t ghcr.io/wyre-ai/sentinelone-mcp:latest .
```

The image listens on `0.0.0.0` inside the container (`MCP_HTTP_HOST`) and refuses to start until `CONDUIT_S2S_SECRET` is set. Publish the port on loopback. SentinelOne credentials arrive on each request as headers; they are not read from the environment.

```bash
docker run --rm \
  -e CONDUIT_S2S_SECRET="$(openssl rand -hex 32)" \
  -p 127.0.0.1:8080:8080 \
  ghcr.io/wyre-ai/sentinelone-mcp:latest
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset, publishes `127.0.0.1:8080:8080`, and does not inject `PURPLEMCP_CONSOLE_TOKEN` or `PURPLEMCP_CONSOLE_BASE_URL`:

```bash
CONDUIT_S2S_SECRET="$(openssl rand -hex 32)" docker compose up --build
```

Local HTTP without a secret is development-only. It binds `127.0.0.1` and logs a warning. A non-loopback `MCP_HTTP_HOST` (including `0.0.0.0`) makes startup exit:

```bash
npm run build
MCP_ALLOW_INSECURE_DEV=1 npm start
```

## License

Apache-2.0. The bundled `purple-mcp` is MIT-licensed by SentinelOne.
