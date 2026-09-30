import { describe, it, expect } from "vitest";
import type { IncomingHttpHeaders } from "node:http";
import { readTenantCredentials } from "../credentials.js";

function headers(input: Record<string, string | string[]>): IncomingHttpHeaders {
  return input;
}

describe("readTenantCredentials", () => {
  it("reads catalog X-S1 headers (already lowercased, as Node exposes them)", () => {
    expect(
      readTenantCredentials(
        headers({
          "x-s1-api-token": "tok-s1",
          "x-s1-console-url": "https://tenant.sentinelone.net",
        }),
      ),
    ).toEqual({ token: "tok-s1", baseUrl: "https://tenant.sentinelone.net" });
  });

  it("reads legacy x-purplemcp headers", () => {
    expect(
      readTenantCredentials(
        headers({
          "x-purplemcp-token": "tok-legacy",
          "x-purplemcp-base-url": "https://legacy.sentinelone.net",
        }),
      ),
    ).toEqual({ token: "tok-legacy", baseUrl: "https://legacy.sentinelone.net" });
  });

  it("prefers X-S1 over legacy when both are present, per field", () => {
    expect(
      readTenantCredentials(
        headers({
          "x-s1-api-token": "tok-s1",
          "x-purplemcp-token": "tok-legacy",
          "x-s1-console-url": "https://s1.example",
          "x-purplemcp-base-url": "https://legacy.example",
        }),
      ),
    ).toEqual({ token: "tok-s1", baseUrl: "https://s1.example" });
  });

  it("fills each field independently so a mixed pair still authenticates", () => {
    expect(
      readTenantCredentials(
        headers({
          "x-s1-api-token": "tok-s1",
          "x-purplemcp-base-url": "https://legacy.example",
        }),
      ),
    ).toEqual({ token: "tok-s1", baseUrl: "https://legacy.example" });
  });

  it("trims whitespace and treats blank values as missing", () => {
    expect(
      readTenantCredentials(
        headers({
          "x-s1-api-token": "  tok  ",
          "x-s1-console-url": "   ",
          "x-purplemcp-base-url": " https://legacy.example ",
        }),
      ),
    ).toEqual({ token: "tok", baseUrl: "https://legacy.example" });
  });

  it("returns null when either credential is missing", () => {
    expect(readTenantCredentials(headers({}))).toBeNull();
    expect(readTenantCredentials(headers({ "x-s1-api-token": "tok" }))).toBeNull();
    expect(
      readTenantCredentials(headers({ "x-s1-console-url": "https://tenant.sentinelone.net" })),
    ).toBeNull();
  });

  it("uses the first non-empty value when a header is repeated", () => {
    expect(
      readTenantCredentials(
        headers({
          "x-s1-api-token": ["", "tok-second"],
          "x-s1-console-url": ["https://tenant.sentinelone.net"],
        }),
      ),
    ).toEqual({ token: "tok-second", baseUrl: "https://tenant.sentinelone.net" });
  });
});
