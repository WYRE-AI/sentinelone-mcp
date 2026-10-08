import { describe, it, expect } from "vitest";
import { hashCreds } from "./tenant-key.js";

describe("hashCreds", () => {
  it("is deterministic for the same (token, baseUrl) pair", () => {
    const a = hashCreds("token-a", "https://usea1-partners.sentinelone.net");
    const b = hashCreds("token-a", "https://usea1-partners.sentinelone.net");
    expect(a).toBe(b);
  });

  it("produces a 16-character lowercase hex digest", () => {
    const hash = hashCreds("token-a", "https://usea1-partners.sentinelone.net");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("differs when the token differs but baseUrl is the same", () => {
    const a = hashCreds("token-a", "https://usea1-partners.sentinelone.net");
    const b = hashCreds("token-b", "https://usea1-partners.sentinelone.net");
    expect(a).not.toBe(b);
  });

  it("differs when baseUrl differs but token is the same", () => {
    const a = hashCreds("token-a", "https://usea1-partners.sentinelone.net");
    const b = hashCreds("token-a", "https://eu-partners.sentinelone.net");
    expect(a).not.toBe(b);
  });

  /**
   * Tenant-isolation guard: without a delimiter between token and baseUrl,
   * two different tenants' credentials could concatenate to the same string
   * and collide onto the same cache key — meaning tenant A's request could
   * be served by tenant B's already-spawned purple-mcp child. The \0
   * separator in hashCreds exists specifically to prevent this.
   */
  it("does not collide when token+baseUrl concatenation would otherwise match across a boundary shift", () => {
    const a = hashCreds("ab", "c");
    const b = hashCreds("a", "bc");
    expect(a).not.toBe(b);
  });
});
