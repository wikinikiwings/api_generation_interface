/**
 * Dev-time logger for history-deletion / sync events.
 *
 * Call `debugHistory("event-name", { ...payload })` from any delete
 * or sync-adjacent code-site. Logs are gated by a localStorage flag
 * so they stay silent in normal use:
 *
 *   localStorage.setItem("DEBUG_HISTORY_DELETE", "1");  // enable
 *   localStorage.removeItem("DEBUG_HISTORY_DELETE");    // disable
 *
 * Why a flag instead of NODE_ENV: dev server still ships clean
 * console for everyday work, and the logs turn on on-demand when a
 * user hits a bug and needs to share a trace.
 *
 * Payload note: keep payloads JSON-stringifiable. The formatter
 * deliberately calls JSON.stringify so log copy-paste is trivial,
 * and mutation-after-log can't skew what you see in the console.
 */

"use client";

function isEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("DEBUG_HISTORY_DELETE") === "1";
  } catch {
    return false;
  }
}

export function debugHistory(event: string, payload?: unknown): void {
  if (!isEnabled()) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.sss
  if (payload === undefined) {
    console.log(`[history:${ts}] ${event}`);
    return;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    serialized = String(payload);
  }
  console.log(`[history:${ts}] ${event}  ${serialized}`);
}
