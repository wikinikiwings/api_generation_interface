// Server-only. Decides which configured time-slots are due now (pure dueSlots)
// and runs the balance check once per due tick (runScheduledCheck). Times are
// UTC "HH:MM"; the per-slot UTC-day guard in falBalanceLastRun prevents
// double-firing and survives restarts.

import { getAppSetting, setAppSetting } from "@/lib/history-db";
import { checkBalanceAndAlert } from "./balance-alert";

function slotMinutes(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function dueSlots(args: {
  now: Date;
  checkTimes: string[];
  lastRun: Record<string, string>;
}): string[] {
  const { now, checkTimes, lastRun } = args;
  const today = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  return checkTimes.filter((slot) => {
    const sm = slotMinutes(slot);
    if (sm == null) return false;
    if (nowMin < sm) return false;          // not reached yet today
    if (lastRun[slot] === today) return false; // already ran today
    return true;
  });
}

function parseArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseMap(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export async function runScheduledCheck(now: Date = new Date()): Promise<void> {
  const checkTimes = parseArray(getAppSetting("falBalanceCheckTimes"));
  if (checkTimes.length === 0) return;
  const lastRun = parseMap(getAppSetting("falBalanceLastRun"));
  const due = dueSlots({ now, checkTimes, lastRun });
  if (due.length === 0) return;

  await checkBalanceAndAlert();

  const today = now.toISOString().slice(0, 10);
  for (const slot of due) lastRun[slot] = today;
  setAppSetting("falBalanceLastRun", JSON.stringify(lastRun));
}
