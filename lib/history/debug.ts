"use client";

/**
 * Dev-time logger for history state-machine transitions.
 *
 * Enable: localStorage.setItem("DEBUG_HISTORY_DELETE", "1");
 * Disable: localStorage.removeItem("DEBUG_HISTORY_DELETE");
 *
 * Event names follow the convention: <area>.<event>[.<outcome>]
 * Examples:
 *   deleteEntry.start, deleteEntry.commit, deleteEntry.error, deleteEntry.noop
 *   applyServerRow.insert, applyServerRow.confirm, applyServerRow.ignored
 *   hydrate.ok, hydrate.error, hydrate.cross-device-delete
 *   sse.open, sse.created, sse.deleted, sse.error
 *   broadcast.send, broadcast.recv
 */

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
  const ts = new Date().toISOString().slice(11, 23);
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
