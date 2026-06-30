// Next.js instrumentation hook (runs once at server startup). Starts the
// in-process low-balance ticker in the nodejs runtime only. Each tick is cheap
// (reads app_settings + the clock); it hits fal.ai only when a configured slot
// is due. Errors are logged, never thrown.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const g = globalThis as typeof globalThis & { __falBalanceTick?: ReturnType<typeof setInterval> };
  if (g.__falBalanceTick) return; // guard against double-registration (dev/HMR)

  const { runScheduledCheck } = await import("@/lib/admin/balance-schedule");
  const seconds = Number(process.env.FAL_BALANCE_TICK_SECONDS) || 30;

  g.__falBalanceTick = setInterval(() => {
    runScheduledCheck().catch((e) => console.error("[balance-tick]", e));
  }, seconds * 1000);
}
