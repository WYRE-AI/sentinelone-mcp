/**
 * Tenant cache-key derivation for the purple-mcp child-process pool.
 *
 * Extracted from index.ts so it can be unit tested in isolation — index.ts
 * has import-time side effects (spawns a Fastify server, installs signal
 * handlers, starts an idle-eviction interval) that make it unsafe to import
 * directly in a test.
 */

import { createHash } from "node:crypto";

/**
 * Derive the child-process cache key for a tenant's SentinelOne credentials.
 *
 * The null-byte separator between token and baseUrl is load-bearing: without
 * it, two different (token, baseUrl) pairs whose concatenation collides —
 * e.g. token="ab"+baseUrl="c" vs token="a"+baseUrl="bc" — would hash to the
 * same cache key and one tenant's request could be served by another
 * tenant's already-spawned purple-mcp child.
 */
export function hashCreds(token: string, baseUrl: string): string {
  return createHash("sha256").update(`${token}\0${baseUrl}`).digest("hex").slice(0, 16);
}
