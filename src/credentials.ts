/**
 * Per-request SentinelOne console credentials.
 *
 * Conduit's catalog headerMapping sends `X-S1-API-Token` and
 * `X-S1-Console-URL` (an intentional revert to the X-S1 names). Older
 * callers still send `x-purplemcp-token` and `x-purplemcp-base-url`.
 * Node lowercases incoming header names before the handler sees them.
 * When both pairs are present, the X-S1 value wins per field.
 */
import type { IncomingHttpHeaders } from "node:http";

/** Catalog names (lowercased, as Node exposes them). */
export const HEADER_S1_TOKEN = "x-s1-api-token";
export const HEADER_S1_BASE_URL = "x-s1-console-url";

/** Legacy names kept so older gateways keep working. */
export const HEADER_PURPLE_TOKEN = "x-purplemcp-token";
export const HEADER_PURPLE_BASE_URL = "x-purplemcp-base-url";

export interface TenantCredentials {
  token: string;
  baseUrl: string;
}

function firstHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name];
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function readTenantCredentials(headers: IncomingHttpHeaders): TenantCredentials | null {
  const token = firstHeader(headers, HEADER_S1_TOKEN) ?? firstHeader(headers, HEADER_PURPLE_TOKEN);
  const baseUrl =
    firstHeader(headers, HEADER_S1_BASE_URL) ?? firstHeader(headers, HEADER_PURPLE_BASE_URL);
  if (!token || !baseUrl) return null;
  return { token, baseUrl };
}
