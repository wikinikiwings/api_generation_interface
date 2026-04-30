import { describe, it, expect } from "vitest";
import { encodeOAuthTx, decodeOAuthTx, type OAuthTxPayload } from "../oauth-tx";

const SECRET = "0".repeat(64); // 32 bytes hex
const PAYLOAD: OAuthTxPayload = {
  state: "s1",
  nonce: "n1",
  code_verifier: "cv1",
  next: "/admin",
  ts: 1700000000000,
};

describe("oauth-tx encode/decode", () => {
  it("roundtrips a payload", () => {
    const encoded = encodeOAuthTx(PAYLOAD, SECRET);
    const decoded = decodeOAuthTx(encoded, SECRET, { now: PAYLOAD.ts + 1000 });
    expect(decoded).toEqual(PAYLOAD);
  });

  it("rejects tampered payload", () => {
    const encoded = encodeOAuthTx(PAYLOAD, SECRET);
    // flip one char in the payload portion (before the dot)
    const [b64, sig] = encoded.split(".");
    const tampered = b64.slice(0, -1) + (b64.slice(-1) === "A" ? "B" : "A") + "." + sig;
    expect(() => decodeOAuthTx(tampered, SECRET, { now: PAYLOAD.ts + 1000 })).toThrow(/signature/i);
  });

  it("rejects expired payload (>10 min old)", () => {
    const encoded = encodeOAuthTx(PAYLOAD, SECRET);
    const tooLate = PAYLOAD.ts + 11 * 60 * 1000;
    expect(() => decodeOAuthTx(encoded, SECRET, { now: tooLate })).toThrow(/expired/i);
  });

  it("rejects payload signed with a different secret", () => {
    const encoded = encodeOAuthTx(PAYLOAD, SECRET);
    expect(() =>
      decodeOAuthTx(encoded, "1".repeat(64), { now: PAYLOAD.ts + 1000 })
    ).toThrow(/signature/i);
  });

  it("rejects malformed input", () => {
    expect(() => decodeOAuthTx("not-a-valid-token", SECRET)).toThrow();
    expect(() => decodeOAuthTx("", SECRET)).toThrow();
    expect(() => decodeOAuthTx("only-one-part", SECRET)).toThrow();
  });
});
