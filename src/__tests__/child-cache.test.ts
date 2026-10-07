import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

// Env is read when a child is spawned or evicted, not at import, so this file
// can load alongside the other route tests.
process.env.MAX_CHILDREN = "1";
process.env.IDLE_EVICT_MS = "0";
process.env.SPAWN_READY_TIMEOUT_MS = "5000";
process.env.SPAWN_DELAY_MS = "150";

const root = mkdtempSync(join(tmpdir(), "s1-cache-"));
const python = join(root, "fake-python.mjs");
const spawnLog = join(root, "spawns.log");
process.env.PURPLE_MCP_PYTHON = python;
process.env.PURPLE_MCP_DIR = root;
process.env.SPAWN_LOG = spawnLog;
process.env.SPAWN_MODE = "serve";

writeFileSync(
  python,
  `#!/usr/bin/env node
import http from "node:http";
import { appendFileSync } from "node:fs";
const args = process.argv;
const port = Number(args[args.indexOf("--port") + 1]);
if (process.env.SPAWN_LOG) appendFileSync(process.env.SPAWN_LOG, process.pid + "\\n");
const delay = Number(process.env.SPAWN_DELAY_MS || 0);
setTimeout(() => {
  if (process.env.SPAWN_MODE === "fail") {
    process.exit(1);
    return;
  }
  http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, result: { ok: true } }));
  }).listen(port, "127.0.0.1");
}, delay);
`,
);
chmodSync(python, 0o755);
writeFileSync(spawnLog, "");

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "cache-test", version: "0" },
  },
};

function pids(): string[] {
  return readFileSync(spawnLog, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

describe("tenant child cache", () => {
  let app: FastifyInstance;
  let evictIdleChildren: (now?: number) => void;
  let shutdownChildren: (signal: string) => void;

  beforeAll(async () => {
    const mod = await import("../app.js");
    evictIdleChildren = mod.evictIdleChildren;
    shutdownChildren = mod.shutdownChildren;
    app = mod.buildApp({ logger: false, s2sSecret: "" });
    await app.ready();
  });

  beforeEach(() => {
    process.env.MAX_CHILDREN = "1";
    process.env.IDLE_EVICT_MS = "0";
    process.env.SPAWN_READY_TIMEOUT_MS = "5000";
    process.env.SPAWN_DELAY_MS = "150";
    process.env.PURPLE_MCP_PYTHON = python;
    process.env.PURPLE_MCP_DIR = root;
    process.env.SPAWN_LOG = spawnLog;
    process.env.SPAWN_MODE = "serve";
  });

  afterEach(async () => {
    process.env.IDLE_EVICT_MS = "0";
    await new Promise((r) => setTimeout(r, 10));
    evictIdleChildren();
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(spawnLog, "");
  });

  afterAll(async () => {
    shutdownChildren("test");
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function post(token: string, baseUrl: string) {
    return app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-s1-api-token": token,
        "x-s1-console-url": baseUrl,
      },
      payload: INITIALIZE,
    });
  }

  it("shares one in-flight spawn and waits until that child is listening", async () => {
    const [a, b] = await Promise.all([
      post("tok-shared", "https://shared.sentinelone.net"),
      post("tok-shared", "https://shared.sentinelone.net"),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(pids()).toHaveLength(1);

    const again = await post("tok-shared", "https://shared.sentinelone.net");
    expect(again.statusCode).toBe(200);
    expect(pids()).toHaveLength(1);

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.json().tenants).toBe(1);
  });

  it("counts an in-flight spawn toward MAX_CHILDREN", async () => {
    const [a, b] = await Promise.all([
      post("tok-a", "https://a.sentinelone.net"),
      post("tok-b", "https://b.sentinelone.net"),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 502]);
    const failed = a.statusCode === 502 ? a : b;
    expect(failed.json().error.code).toBe(-32002);
    expect(failed.json().error.message).toContain("capacity limit");
    expect(pids()).toHaveLength(1);
  });

  it("gives every waiter the spawn failure instead of a connection error", async () => {
    process.env.SPAWN_MODE = "fail";
    const [a, b] = await Promise.all([
      post("tok-fail", "https://fail.sentinelone.net"),
      post("tok-fail", "https://fail.sentinelone.net"),
    ]);
    expect(a.statusCode).toBe(502);
    expect(b.statusCode).toBe(502);
    expect(a.json().error.code).toBe(-32002);
    expect(b.json().error.code).toBe(-32002);
    expect(a.json().error.message).not.toContain("upstream unreachable");
    expect(b.json().error.message).not.toContain("upstream unreachable");
    expect(pids()).toHaveLength(1);
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.json().tenants).toBe(0);
  });

  it("does not evict a child that is still starting", async () => {
    process.env.SPAWN_DELAY_MS = "400";
    const pending = post("tok-boot", "https://boot.sentinelone.net");
    await new Promise((r) => setTimeout(r, 40));
    evictIdleChildren();
    const mid = await app.inject({ method: "GET", url: "/health" });
    expect(mid.json().tenants).toBe(1);
    const res = await pending;
    expect(res.statusCode).toBe(200);
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.json().tenants).toBe(1);
    expect(pids()).toHaveLength(1);
  });

  it("falls back to the default cap when MAX_CHILDREN is not a positive integer", async () => {
    process.env.MAX_CHILDREN = "nope";
    const [a, b] = await Promise.all([
      post("tok-cap-a", "https://a.sentinelone.net"),
      post("tok-cap-b", "https://b.sentinelone.net"),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(pids()).toHaveLength(2);
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.json().maxTenants).toBe(50);
    expect(health.json().tenants).toBe(2);
  });

  it("does not drop a replacement child when the evicted process exits", async () => {
    const first = await post("tok-replace", "https://replace.sentinelone.net");
    expect(first.statusCode).toBe(200);
    expect(pids()).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 15));
    evictIdleChildren();

    const second = await post("tok-replace", "https://replace.sentinelone.net");
    expect(second.statusCode).toBe(200);
    expect(pids()).toHaveLength(2);

    for (let i = 0; i < 8; i++) {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.json().tenants).toBe(1);
      await new Promise((r) => setTimeout(r, 25));
    }
  });
});
