/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach } from "vitest";
import { generateKeyPair, SignJWT, exportJWK, type JWK } from "jose";
import { verifyIdToken } from "../google";

const ISSUER = "https://accounts.google.com";
const AUD = "test-client-id.apps.googleusercontent.com";

let signedToken: string;
let publicJwk: JWK;
let kid: string;

beforeEach(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  publicJwk = await exportJWK(publicKey);
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  publicJwk.kid = "test-kid-1";
  kid = "test-kid-1";

  signedToken = await new SignJWT({
    email: "alice@x.com",
    email_verified: true,
    sub: "google-sub-123",
    name: "Alice",
    picture: "https://lh.example/p.jpg",
    nonce: "n1",
    hd: "tapclap.com",
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(ISSUER)
    .setAudience(AUD)
    .setExpirationTime("1h")
    .setIssuedAt()
    .sign(privateKey);
});

function fakeJwks() {
  return { keys: [publicJwk] };
}

describe("verifyIdToken", () => {
  it("accepts a valid token", async () => {
    const payload = await verifyIdToken(signedToken, {
      audience: AUD,
      jwks: fakeJwks(),
    });
    expect(payload.email).toBe("alice@x.com");
    expect(payload.sub).toBe("google-sub-123");
    expect(payload.email_verified).toBe(true);
    expect(payload.nonce).toBe("n1");
  });

  it("rejects token signed with another key", async () => {
    const { privateKey: other } = await generateKeyPair("RS256");
    const tampered = await new SignJWT({ email: "a@b.c", sub: "x", email_verified: true })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(ISSUER).setAudience(AUD).setExpirationTime("1h").sign(other);
    await expect(verifyIdToken(tampered, { audience: AUD, jwks: fakeJwks() })).rejects.toThrow();
  });

  it("rejects token with wrong issuer", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const pub = await exportJWK((await generateKeyPair("RS256")).publicKey);
    void pub;
    const t = await new SignJWT({ email: "a@b.c", sub: "x", email_verified: true })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer("https://evil.com").setAudience(AUD).setExpirationTime("1h").sign(privateKey);
    await expect(verifyIdToken(t, { audience: AUD, jwks: fakeJwks() })).rejects.toThrow();
  });

  it("rejects token with wrong audience", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const t = await new SignJWT({ email: "a@b.c", sub: "x", email_verified: true })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(ISSUER).setAudience("OTHER").setExpirationTime("1h").sign(privateKey);
    await expect(verifyIdToken(t, { audience: AUD, jwks: fakeJwks() })).rejects.toThrow();
  });
});
