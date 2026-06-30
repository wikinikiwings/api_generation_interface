import { describe, it, expect, vi, beforeEach } from "vitest";

const settings: Record<string, string | null> = {};
vi.mock("@/lib/history-db", () => ({
  getAppSetting: (k: string) => settings[k] ?? null,
  setAppSetting: (k: string, v: string) => { settings[k] = v; },
}));
const checkBalanceAndAlert = vi.fn();
vi.mock("@/lib/admin/balance-alert", () => ({ checkBalanceAndAlert: () => checkBalanceAndAlert() }));

import { dueSlots, runScheduledCheck } from "@/lib/admin/balance-schedule";

// 2026-06-30T10:05:00Z
const NOW = new Date("2026-06-30T10:05:00.000Z");

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
  checkBalanceAndAlert.mockReset().mockResolvedValue({ status: "ok" });
});

describe("dueSlots", () => {
  it("returns slots whose UTC time has passed and not run today", () => {
    expect(dueSlots({ now: NOW, checkTimes: ["09:00", "10:00"], lastRun: {} })).toEqual(["09:00", "10:00"]);
  });
  it("excludes slots already run today", () => {
    expect(dueSlots({ now: NOW, checkTimes: ["09:00"], lastRun: { "09:00": "2026-06-30" } })).toEqual([]);
  });
  it("excludes future slots", () => {
    expect(dueSlots({ now: NOW, checkTimes: ["11:00"], lastRun: {} })).toEqual([]);
  });
  it("ignores malformed slot strings", () => {
    expect(dueSlots({ now: NOW, checkTimes: ["bad", "25:99"], lastRun: {} })).toEqual([]);
  });
  it("re-fires a slot that ran yesterday", () => {
    expect(dueSlots({ now: NOW, checkTimes: ["09:00"], lastRun: { "09:00": "2026-06-29" } })).toEqual(["09:00"]);
  });
});

describe("runScheduledCheck", () => {
  it("does nothing when no check times configured", async () => {
    await runScheduledCheck(NOW);
    expect(checkBalanceAndAlert).not.toHaveBeenCalled();
  });
  it("runs the check once and marks due slots done for today", async () => {
    settings.falBalanceCheckTimes = JSON.stringify(["09:00", "10:00", "11:00"]);
    await runScheduledCheck(NOW);
    expect(checkBalanceAndAlert).toHaveBeenCalledOnce();
    const lastRun = JSON.parse(settings.falBalanceLastRun as string);
    expect(lastRun).toEqual({ "09:00": "2026-06-30", "10:00": "2026-06-30" });
  });
  it("does not run when all due slots already ran today", async () => {
    settings.falBalanceCheckTimes = JSON.stringify(["09:00"]);
    settings.falBalanceLastRun = JSON.stringify({ "09:00": "2026-06-30" });
    await runScheduledCheck(NOW);
    expect(checkBalanceAndAlert).not.toHaveBeenCalled();
  });
});
