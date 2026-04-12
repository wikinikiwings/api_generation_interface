/**
 * Dev-only timing diagnostics for the history-thumbnail-first flow.
 *
 * Measures: generation-complete → fetch → decode → encode → pending-added
 *           → card-painted, all keyed by uuid. On card paint, prints a
 *           single summary line per generation.
 *
 * Gated on `localStorage.getItem("HIST_DIAG") === "1"` so we can flip it
 * on in one tab without noise in production builds.
 */

export type Stage =
  | "gen-complete"
  | "fetch-start"
  | "fetch-done"
  | "decode-done"
  | "thumb-done"
  | "encode-done"
  | "pending-added"
  | "card-painted";

type Timeline = Partial<Record<Stage, number>>;
const timelines = new Map<string, Timeline>();

function enabled(): boolean {
  if (typeof window === "undefined") return false;
  // Always-on in dev. In production, require explicit opt-in via localStorage.
  if (process.env.NODE_ENV !== "production") return true;
  try {
    return window.localStorage.getItem("HIST_DIAG") === "1";
  } catch {
    return false;
  }
}

export function mark(uuid: string, stage: Stage): void {
  if (!enabled()) return;
  const existing = timelines.get(uuid) ?? {};
  const base = existing["gen-complete"];
  existing[stage] = performance.now();
  timelines.set(uuid, existing);
  const rel =
    base !== undefined ? ` (+${(existing[stage]! - base).toFixed(0)}ms)` : "";
  console.debug(`[hist ${uuid.slice(0, 8)}] ${stage}${rel}`);
  if (stage === "card-painted") {
    report(uuid);
    // Keep the timeline around briefly so late marks from the pending→
    // confirmed transition can still be observed. GC when the entry is
    // eventually confirmed + the server-row card paints over it.
    setTimeout(() => timelines.delete(uuid), 10_000);
  }
}

function report(uuid: string): void {
  const t = timelines.get(uuid);
  if (!t || t["gen-complete"] === undefined) return;
  const base = t["gen-complete"];
  const fmt = (stage: Stage) =>
    t[stage] !== undefined ? `${(t[stage]! - base).toFixed(0)}ms` : "—";
  // Single-line table so it's easy to eyeball across multiple generations.
  console.log(
    `[hist ${uuid.slice(0, 8)}] ` +
      `gen→fetchStart ${fmt("fetch-start")} · ` +
      `gen→fetchDone ${fmt("fetch-done")} · ` +
      `gen→decodeDone ${fmt("decode-done")} · ` +
      `gen→thumbDone ${fmt("thumb-done")} · ` +
      `gen→encodeDone ${fmt("encode-done")} · ` +
      `gen→pendingAdded ${fmt("pending-added")} · ` +
      `gen→cardPainted ${fmt("card-painted")}`
  );
}

/** For ad-hoc debugging. */
export function dumpAll(): void {
  for (const uuid of timelines.keys()) report(uuid);
}
