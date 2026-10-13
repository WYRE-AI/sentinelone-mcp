/**
 * Fail-closed HTTP startup for service-to-service auth (CWE-306).
 *
 * An empty CONDUIT_S2S_SECRET used to skip the X-Gateway-S2S check. Startup
 * now refuses to listen unless the secret is set and is not a known
 * placeholder. MCP_ALLOW_INSECURE_DEV=1 is the only bypass: it logs a
 * warning, does not enforce S2S, and binds 127.0.0.1. A non-loopback
 * MCP_HTTP_HOST is refused in that mode. A known placeholder is refused
 * even when the dev flag is set.
 *
 * A real secret honors MCP_HTTP_HOST, including 0.0.0.0. When that variable
 * is unset the process keeps the historical 0.0.0.0 bind so container
 * deploys stay reachable. The secret value is never logged.
 */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
]);

const LOOPBACK_HOST = "127.0.0.1";

const MISSING_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. " +
  "Set CONDUIT_S2S_SECRET to the gateway-provisioned secret (openssl rand -hex 32), " +
  "or set MCP_ALLOW_INSECURE_DEV=1 for local development only.";

const PLACEHOLDER_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. " +
  "Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.";

export const INSECURE_DEV_WARNING =
  "SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. " +
  "HTTP /mcp is starting with service-to-service authentication DISABLED, bound to 127.0.0.1 only. " +
  "Local development only; do not expose this port.";

export interface S2sStartup {
  /** Empty only when MCP_ALLOW_INSECURE_DEV=1. Never a known placeholder. */
  secret: string;
  insecureDev: boolean;
}

function refuseStart(message: string): never {
  // console.error, not the Fastify logger: LOG_LEVEL must not hide a refused start.
  console.error(message);
  process.exit(1);
}

/** 127.0.0.1, the rest of 127.0.0.0/8, localhost, and ::1. */
function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, "$1");
  if (normalized === "localhost" || normalized === "::1") return true;
  const bare = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  return parts[0] === "127";
}

/**
 * Fail closed. A known placeholder is never a configured secret, including
 * when MCP_ALLOW_INSECURE_DEV=1 is also set. Empty is the only case the dev
 * flag may bypass, and that bypass does not check X-Gateway-S2S.
 * The secret value is never written to the log.
 */
export function resolveS2sSecret(env: NodeJS.ProcessEnv = process.env): S2sStartup {
  const raw = (env.CONDUIT_S2S_SECRET ?? "").trim();
  if (raw && KNOWN_PLACEHOLDER_SECRETS.has(raw.toLowerCase())) {
    refuseStart(PLACEHOLDER_S2S_SECRET_ERROR);
  }
  if (raw) return { secret: raw, insecureDev: false };
  if (env.MCP_ALLOW_INSECURE_DEV === "1") {
    return { secret: "", insecureDev: true };
  }
  refuseStart(MISSING_S2S_SECRET_ERROR);
}

/**
 * Reject a known placeholder passed in explicitly (tests or a caller that
 * already read the env). Empty is allowed: it is the insecure-dev value.
 * Does not log the secret.
 */
export function rejectPlaceholderSecret(secret: string): void {
  const raw = secret.trim();
  if (raw && KNOWN_PLACEHOLDER_SECRETS.has(raw.toLowerCase())) {
    refuseStart(PLACEHOLDER_S2S_SECRET_ERROR);
  }
}

/**
 * No real secret: force 127.0.0.1. A non-loopback MCP_HTTP_HOST refuses to
 * start and is logged. A real secret honors MCP_HTTP_HOST; unset stays
 * 0.0.0.0 so existing container deploys keep their bind.
 */
export function resolveBindHost(insecureDev: boolean, env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.MCP_HTTP_HOST ?? "").trim();
  if (!insecureDev) {
    return configured || "0.0.0.0";
  }
  if (configured === "" || isLoopbackBindHost(configured)) {
    return LOOPBACK_HOST;
  }
  refuseStart(
    `Refusing to start HTTP transport: MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET ` +
      `only listens on ${LOOPBACK_HOST}. MCP_HTTP_HOST=${configured} is not loopback. ` +
      `Unset MCP_HTTP_HOST or set it to ${LOOPBACK_HOST}.`,
  );
}
