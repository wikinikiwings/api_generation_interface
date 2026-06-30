// Node-only startup side effect: starts the in-process low-balance check
// ticker. Imported dynamically from instrumentation.ts ONLY in the nodejs
// runtime, so its better-sqlite3 dependency (via balance-schedule → history-db)
// never enters the edge bundle. Each tick is cheap (reads app_settings + the
// clock); it hits fal.ai only when a configured slot is due. Errors are logged,
// never thrown. The globalThis guard prevents a second interval under dev/HMR.

import { runScheduledCheck } from "@/lib/admin/balance-schedule";

const g = globalThis as typeof globalThis & { __falBalanceTick?: ReturnType<typeof setInterval> };

if (!g.__falBalanceTick) {
  const seconds = Number(process.env.FAL_BALANCE_TICK_SECONDS) || 30;
  g.__falBalanceTick = setInterval(() => {
    runScheduledCheck().catch((e) => console.error("[balance-tick]", e));
  }, seconds * 1000);
}
