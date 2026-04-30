import { jwtVerify, createLocalJWKSet, type JSONWebKeySet } from "jose";

const GOOGLE_ISSUER = "https://accounts.google.com";

export interface GoogleIdTokenPayload {
  email: string;
  email_verified: boolean;
  sub: string;
  name?: string;
  picture?: string;
  nonce?: string;
  hd?: string;
  iss: string;
  aud: string | string[];
  exp: number;
}

/**
 * Verify a Google id_token. Throws on any failure (signature, iss, aud, exp).
 * Caller is responsible for checking nonce/email_verified/hd/allowlist after this.
 *
 * `jwks` is the parsed JSON Web Key Set. In production this comes from
 * fetching https://www.googleapis.com/oauth2/v3/certs (with caching). In tests
 * we pass it directly.
 */
export async function verifyIdToken(
  token: string,
  opts: { audience: string; jwks: JSONWebKeySet }
): Promise<GoogleIdTokenPayload> {
  const localJwks = createLocalJWKSet(opts.jwks);
  const { payload } = await jwtVerify(token, localJwks, {
    issuer: GOOGLE_ISSUER,
    audience: opts.audience,
  });
  return payload as unknown as GoogleIdTokenPayload;
}
