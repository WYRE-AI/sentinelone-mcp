import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";

const S2S_SECRET = "test-master-secret-do-not-use-in-prod";

function mintS2s(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac("sha256", secret).update(message).digest("hex");
  return `${message},v1=${hex}`;
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "vendor-monitor", version: "0" },
  },
};

async function postMcp(
  app: FastifyInstance,
  headers: Record<string, string> = {},
  payload: unknown = INITIALIZE,
) {
  return app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    payload: payload as object,
  });
}

describe("POST /mcp credential gate", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Creds are accepted, but no purple-mcp binary exists here. Spawn must
    // fail fast with 502 so the test proves we got past the auth gate.
    process.env.PURPLE_MCP_PYTHON = "/nonexistent/purple-mcp-python";
    process.env.SPAWN_READY_TIMEOUT_MS = "3000";
    app = buildApp({ logger: false, s2sSecret: "" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("keeps GET /health as an unauthenticated liveness probe", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", tenants: 0 });
  });

  it("answers a credless initialize with 401, not 400", async () => {
    const res = await postMcp(app);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001 },
    });
    expect(res.json().error.message).toContain("X-S1-API-Token");
  });

  it("401s a credless initialize even when Content-Type carries a charset", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json; charset=utf-8",
        accept: "application/json, text/event-stream",
      },
      payload: INITIALIZE,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe(-32001);
  });

  it("still 401s when only one of the two credential headers is present", async () => {
    const res = await postMcp(app, { "X-S1-API-Token": "tok-only" });
    expect(res.statusCode).toBe(401);
  });

  it("accepts catalog X-S1 headers (any case) and attempts the upstream", async () => {
    const res = await postMcp(app, {
      "X-S1-API-Token": "tok-s1",
      "X-S1-Console-URL": "https://tenant.sentinelone.net",
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe(-32002);
    expect(res.json().error.message).toContain("Failed to start SentinelOne MCP server");
  });

  it("accepts legacy x-purplemcp headers", async () => {
    const res = await postMcp(app, {
      "x-purplemcp-token": "tok-legacy",
      "x-purplemcp-base-url": "https://legacy.sentinelone.net",
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe(-32002);
  });

  it("does not leave a tenant child behind after a failed spawn", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json().tenants).toBe(0);
  });
});

describe("POST /mcp S2S gate", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.PURPLE_MCP_PYTHON = "/nonexistent/purple-mcp-python";
    process.env.SPAWN_READY_TIMEOUT_MS = "3000";
    app = buildApp({ logger: false, s2sSecret: S2S_SECRET });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects a missing X-Gateway-S2S header before looking at tenant credentials", async () => {
    const res = await postMcp(app, {
      "X-S1-API-Token": "tok-s1",
      "X-S1-Console-URL": "https://tenant.sentinelone.net",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error:
        "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
    });
  });

  it("rejects a bad S2S signature even when tenant credentials are present", async () => {
    const res = await postMcp(app, {
      "X-Gateway-S2S": mintS2s("someone-elses-secret"),
      "X-S1-API-Token": "tok-s1",
      "X-S1-Console-URL": "https://tenant.sentinelone.net",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toContain("X-Gateway-S2S");
  });

  it("still returns the credential 401 when S2S is valid but tenant creds are absent", async () => {
    const res = await postMcp(app, { "X-Gateway-S2S": mintS2s(S2S_SECRET) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe(-32001);
    expect(res.json().error.message).toContain("X-S1-API-Token");
  });

  it("reaches the upstream when S2S and X-S1 credentials are both valid", async () => {
    const res = await postMcp(app, {
      "X-Gateway-S2S": mintS2s(S2S_SECRET),
      "X-S1-API-Token": "tok-s1",
      "X-S1-Console-URL": "https://tenant.sentinelone.net",
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe(-32002);
  });

  it("does not spawn a child when S2S rejects the request", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json().tenants).toBe(0);
  });
});
