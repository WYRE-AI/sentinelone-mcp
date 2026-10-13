/**
 * HTTP transport fail-closed auth (CWE-306).
 *
 * Startup requires a real CONDUIT_S2S_SECRET. Empty and known placeholders
 * refuse to listen. MCP_ALLOW_INSECURE_DEV=1 is the empty-secret bypass: it
 * binds 127.0.0.1 and refuses a non-loopback MCP_HTTP_HOST.
 * /mcp rejects a missing or invalid X-Gateway-S2S header.
 * Gateway mode rejects requests that omit SentinelOne credential headers
 * and must not fall back to PURPLEMCP_CONSOLE_* in process.env.
 */

import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, startHttpServer } from "../app.js";

const S2S_SECRET = "s2s-do-not-log-7f3a";
const ENV_TOKEN = "env-token-must-not-be-used";
const ENV_BASE_URL = "https://env-must-not-be-used.sentinelone.net";

const ENV_KEYS = [
  "CONDUIT_S2S_SECRET",
  "MCP_ALLOW_INSECURE_DEV",
  "MCP_HTTP_HOST",
  "PORT",
  "LOG_LEVEL",
  "PURPLEMCP_CONSOLE_TOKEN",
  "PURPLEMCP_CONSOLE_BASE_URL",
  "PURPLE_MCP_PYTHON",
  "SPAWN_READY_TIMEOUT_MS",
] as const;

const savedEnv = new Map<string, string | undefined>();
const servers: FastifyInstance[] = [];
let logged: string[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac("sha256", secret).update(message).digest("hex");
  return `${message},v1=${hex}`;
}

function exitSpy(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

function boundAddress(app: FastifyInstance): AddressInfo {
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP server did not bind a TCP port");
  }
  return address;
}

async function listen(): Promise<FastifyInstance> {
  const app = await startHttpServer({ logger: false });
  servers.push(app);
  return app;
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "s2s-auth-test", version: "0" },
  },
};

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  });
  process.env.PORT = "0";
  process.env.MCP_HTTP_HOST = "127.0.0.1";
  process.env.LOG_LEVEL = "info";
  process.env.PURPLE_MCP_PYTHON = "/nonexistent/purple-mcp-python";
  process.env.SPAWN_READY_TIMEOUT_MS = "2000";
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.PURPLEMCP_CONSOLE_TOKEN;
  delete process.env.PURPLEMCP_CONSOLE_BASE_URL;
});

afterEach(async () => {
  try {
    while (servers.length > 0) {
      const app = servers.pop();
      if (app) await app.close();
    }
  } finally {
    vi.restoreAllMocks();
  }
});

describe("HTTP startup", () => {
  it("refuses to start when CONDUIT_S2S_SECRET is unset", async () => {
    const exit = exitSpy();
    await expect(startHttpServer({ logger: false })).rejects.toThrow("process.exit:1");
    expect(exit).toHaveBeenCalledWith(1);
    const text = logged.join("\n");
    expect(text).toContain("Refusing to start HTTP transport");
    expect(text).toContain("CONDUIT_S2S_SECRET is empty");
    expect(text).not.toContain(S2S_SECRET);
  });

  it("refuses to start when CONDUIT_S2S_SECRET is empty or whitespace", async () => {
    process.env.CONDUIT_S2S_SECRET = "   ";
    exitSpy();
    await expect(startHttpServer({ logger: false })).rejects.toThrow("process.exit:1");
    expect(logged.join("\n")).toContain("CONDUIT_S2S_SECRET is empty");
  });

  it("still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "true";
    exitSpy();
    await expect(startHttpServer({ logger: false })).rejects.toThrow("process.exit:1");
    expect(logged.join("\n")).toContain("Refusing to start HTTP transport");
  });

  it.each(["changeme", "Change-Me", "  replace-with-a-real-secret  ", "your-s2s-secret"])(
    "refuses known placeholder %j and does not log it",
    async (placeholder) => {
      process.env.CONDUIT_S2S_SECRET = placeholder;
      process.env.MCP_ALLOW_INSECURE_DEV = "1";
      const exit = exitSpy();
      await expect(startHttpServer({ logger: false })).rejects.toThrow("process.exit:1");
      expect(exit).toHaveBeenCalledWith(1);
      const text = logged.join("\n");
      expect(text).toContain("known placeholder");
      expect(text).toContain("openssl rand -hex 32");
      expect(text).not.toContain(placeholder.trim());
      expect(text).not.toContain("SECURITY WARNING");
    },
  );

  it("refuses a placeholder passed straight to buildApp", () => {
    exitSpy();
    expect(() => buildApp({ logger: false, s2sSecret: "  changeme  " })).toThrow("process.exit:1");
    expect(logged.join("\n")).toContain("known placeholder");
    expect(logged.join("\n")).not.toContain("changeme");
  });

  it("refuses buildApp() when the env secret is empty", () => {
    exitSpy();
    expect(() => buildApp({ logger: false })).toThrow("process.exit:1");
    expect(logged.join("\n")).toContain("CONDUIT_S2S_SECRET is empty");
  });

  it("allows startup with a warning when MCP_ALLOW_INSECURE_DEV=1 and binds 127.0.0.1", async () => {
    delete process.env.MCP_HTTP_HOST;
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    const exit = exitSpy();
    const app = await listen();
    expect(exit).not.toHaveBeenCalled();
    expect(boundAddress(app).address).toBe("127.0.0.1");
    const text = logged.join("\n");
    expect(text).toContain("SECURITY WARNING");
    expect(text).toContain("CONDUIT_S2S_SECRET");
    expect(text).toContain("MCP_ALLOW_INSECURE_DEV=1");
    expect(text).toContain("127.0.0.1");
    expect(text).not.toContain(S2S_SECRET);
  });

  it.each(["0.0.0.0", "10.1.2.3"])(
    "refuses the dev bypass when MCP_HTTP_HOST is %s",
    async (host) => {
      process.env.MCP_ALLOW_INSECURE_DEV = "1";
      process.env.MCP_HTTP_HOST = host;
      const exit = exitSpy();
      await expect(startHttpServer({ logger: false })).rejects.toThrow("process.exit:1");
      expect(exit).toHaveBeenCalledWith(1);
      const text = logged.join("\n");
      expect(text).toContain("Refusing to start HTTP transport");
      expect(text).toContain("MCP_ALLOW_INSECURE_DEV");
      expect(text).toContain("loopback");
      expect(text).toContain(`MCP_HTTP_HOST=${host}`);
      expect(text).not.toContain("SECURITY WARNING");
      expect(text).not.toContain(S2S_SECRET);
    },
  );

  it("forces 127.0.0.1 when the dev bypass host is localhost", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.MCP_HTTP_HOST = "localhost";
    const app = await listen();
    expect(boundAddress(app).address).toBe("127.0.0.1");
    expect(logged.join("\n")).toContain("SECURITY WARNING");
  });

  it("honors a non-loopback MCP_HTTP_HOST when CONDUIT_S2S_SECRET is set", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    const app = await listen();
    expect(boundAddress(app).address).toBe("0.0.0.0");
    expect(logged.join("\n")).not.toContain("SECURITY WARNING");
    expect(logged.join("\n")).not.toContain(S2S_SECRET);
  });

  it("keeps the historical 0.0.0.0 bind when a secret is set and MCP_HTTP_HOST is unset", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    delete process.env.MCP_HTTP_HOST;
    const app = await listen();
    expect(boundAddress(app).address).toBe("0.0.0.0");
  });

  it("honors MCP_HTTP_HOST=127.0.0.1 when a secret is set", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    const app = await listen();
    expect(boundAddress(app).address).toBe("127.0.0.1");
  });
});

describe("HTTP /mcp authentication", () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.PURPLEMCP_CONSOLE_TOKEN = ENV_TOKEN;
    process.env.PURPLEMCP_CONSOLE_BASE_URL = ENV_BASE_URL;
  });

  async function post(app: FastifyInstance, headers: Record<string, string> = {}) {
    return app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      payload: INITIALIZE,
    });
  }

  it("returns 401 when the S2S header is missing or invalid and does not log the secret", async () => {
    const app = await listen();
    const missing = await post(app, {
      "X-S1-API-Token": "header-token",
      "X-S1-Console-URL": "https://tenant.sentinelone.net",
    });
    const invalid = await post(app, {
      "X-Gateway-S2S": mintS2sHeader("wrong-secret"),
      "X-S1-API-Token": "header-token",
      "X-S1-Console-URL": "https://tenant.sentinelone.net",
    });

    expect(missing.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(401);
    expect(missing.json().error).toContain("X-Gateway-S2S");
    expect(invalid.json().error).toContain("X-Gateway-S2S");
    expect(missing.body).not.toContain(S2S_SECRET);
    expect(invalid.body).not.toContain(S2S_SECRET);
    expect(missing.body).not.toContain(ENV_TOKEN);
    expect(invalid.body).not.toContain(ENV_BASE_URL);
    expect(logged.join("\n")).not.toContain(S2S_SECRET);
    expect(logged.join("\n")).not.toContain(ENV_TOKEN);

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.json().tenants).toBe(0);
  });

  it("returns 401 in gateway mode without credential headers and does not use env credentials", async () => {
    const app = await listen();
    const response = await post(app, { "X-Gateway-S2S": mintS2sHeader(S2S_SECRET) });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe(-32001);
    expect(response.json().error.message).toContain("X-S1-API-Token");
    expect(response.body).not.toContain(ENV_TOKEN);
    expect(response.body).not.toContain(ENV_BASE_URL);
    expect(response.body).not.toContain(S2S_SECRET);

    const partial = await post(app, {
      "X-Gateway-S2S": mintS2sHeader(S2S_SECRET),
      "X-S1-API-Token": "header-token",
    });
    expect(partial.statusCode).toBe(401);
    expect(partial.body).not.toContain(ENV_TOKEN);
    expect(partial.body).not.toContain("env-must-not-be-used");

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.json().tenants).toBe(0);
  });

  it("accepts a valid S2S header plus credential headers and does not use env credentials", async () => {
    const app = await listen();
    const response = await post(app, {
      "X-Gateway-S2S": mintS2sHeader(S2S_SECRET),
      "X-S1-API-Token": "header-token",
      "X-S1-Console-URL": "https://tenant.sentinelone.net",
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe(-32002);
    expect(response.body).not.toContain(S2S_SECRET);
    expect(response.body).not.toContain(ENV_TOKEN);
    expect(response.body).not.toContain(ENV_BASE_URL);
    expect(logged.join("\n")).not.toContain(S2S_SECRET);
    expect(logged.join("\n")).not.toContain(ENV_TOKEN);
  });

  it("serves /health without authentication and without reading credentials", async () => {
    const app = await listen();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
    expect(response.body).not.toContain(S2S_SECRET);
    expect(response.body).not.toContain(ENV_TOKEN);
    expect(response.body).not.toContain(ENV_BASE_URL);
  });
});

describe("insecure dev bypass", () => {
  beforeEach(() => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    delete process.env.MCP_HTTP_HOST;
    process.env.PURPLEMCP_CONSOLE_TOKEN = ENV_TOKEN;
    process.env.PURPLEMCP_CONSOLE_BASE_URL = ENV_BASE_URL;
  });

  it("does not enforce X-Gateway-S2S and still rejects missing credential headers", async () => {
    const app = await listen();
    expect(boundAddress(app).address).toBe("127.0.0.1");

    const missingCreds = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: INITIALIZE,
    });
    expect(missingCreds.statusCode).toBe(401);
    expect(missingCreds.json().error.code).toBe(-32001);
    expect(missingCreds.body).not.toContain(ENV_TOKEN);
    expect(missingCreds.body).not.toContain(ENV_BASE_URL);

    const withCreds = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "X-S1-API-Token": "header-token",
        "X-S1-Console-URL": "https://tenant.sentinelone.net",
      },
      payload: INITIALIZE,
    });
    expect(withCreds.statusCode).toBe(502);
    expect(withCreds.body).not.toContain(ENV_TOKEN);
    expect(logged.join("\n")).not.toContain(ENV_TOKEN);
  });
});
