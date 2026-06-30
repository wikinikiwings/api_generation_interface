// Next.js instrumentation hook (runs once at server startup).
//
// The node-only ticker lives in ./instrumentation-node and is imported ONLY
// inside the `NEXT_RUNTIME === "nodejs"` block. This positive-guard form lets
// the edge build dead-code-eliminate the branch, so the edge bundle never
// pulls in better-sqlite3 (via balance-schedule → history-db) — which would
// otherwise fail to resolve node builtins (`fs`/`path`) at build time.
// See https://nextjs.org/docs/app/guides/instrumentation

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
