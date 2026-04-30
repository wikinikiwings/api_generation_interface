// lib/auth/cookie-name.ts
// Single source of truth for cookie names shared across route handlers,
// middleware, and any future server utilities.
// Edge-runtime-safe — no Node.js imports.

export const SESSION_COOKIE_NAME =
  process.env.NODE_ENV === "production" ? "__Host-session" : "session";

export const TX_COOKIE_NAME =
  process.env.NODE_ENV === "production" ? "__Host-oauth_tx" : "oauth_tx";
