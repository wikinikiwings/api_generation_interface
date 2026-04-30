import { describe, it, expect } from "vitest";
import { buildAuthorizeUrl, generatePkcePair } from "../google";

describe("buildAuthorizeUrl", () => {
  it("produces a Google OAuth URL with all required params", () => {
    const url = buildAuthorizeUrl({
      client_id: "cid",
      redirect_uri: "http://localhost:3000/api/auth/callback",
      state: "s1",
      nonce: "n1",
      code_challenge: "cc1",
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/callback");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("state")).toBe("s1");
    expect(u.searchParams.get("nonce")).toBe("n1");
    expect(u.searchParams.get("code_challenge")).toBe("cc1");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("prompt")).toBe("select_account");
    expect(u.searchParams.get("access_type")).toBe("online");
  });
});

describe("generatePkcePair", () => {
  it("produces verifier and challenge that match S256", async () => {
    const { code_verifier, code_challenge } = await generatePkcePair();
    // Verifier is 43+ chars b64url
    expect(code_verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    // Recompute the expected challenge ourselves
    const crypto = await import("node:crypto");
    const expected = crypto
      .createHash("sha256").update(code_verifier).digest()
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(code_challenge).toBe(expected);
  });
});
