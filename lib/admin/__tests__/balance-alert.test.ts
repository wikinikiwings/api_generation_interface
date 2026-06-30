import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const settings: Record<string, string | null> = {};
vi.mock("@/lib/history-db", () => ({
  getAppSetting: (k: string) => settings[k] ?? null,
  setAppSetting: (k: string, v: string) => { settings[k] = v; },
}));
const getFalBalance = vi.fn();
vi.mock("@/lib/providers/fal-billing", () => ({ getFalBalance: () => getFalBalance() }));
const sendSlackAlert = vi.fn();
vi.mock("@/lib/notify/slack", () => ({ sendSlackAlert: (t: string) => sendSlackAlert(t) }));

import { decideAlert, checkBalanceAndAlert } from "@/lib/admin/balance-alert";

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
  getFalBalance.mockReset();
  sendSlackAlert.mockReset().mockResolvedValue(true);
});
afterEach(() => vi.clearAllMocks());

describe("decideAlert", () => {
  it("sends when below threshold and not yet alerted", () => {
    expect(decideAlert({ balance: 5, threshold: 10, alreadyAlerted: false })).toEqual({ shouldSend: true, nextAlerted: true });
  });
  it("stays silent while below and already alerted", () => {
    expect(decideAlert({ balance: 5, threshold: 10, alreadyAlerted: true })).toEqual({ shouldSend: false, nextAlerted: true });
  });
  it("re-arms when recovered above and was alerted", () => {
    expect(decideAlert({ balance: 12, threshold: 10, alreadyAlerted: true })).toEqual({ shouldSend: false, nextAlerted: false });
  });
  it("noop when above and not alerted", () => {
    expect(decideAlert({ balance: 12, threshold: 10, alreadyAlerted: false })).toEqual({ shouldSend: false, nextAlerted: false });
  });
});

describe("checkBalanceAndAlert", () => {
  it("no_threshold when unset", async () => {
    expect(await checkBalanceAndAlert()).toEqual({ status: "no_threshold" });
    expect(getFalBalance).not.toHaveBeenCalled();
  });

  it("reports balance_<status> when balance not ok", async () => {
    settings.falBalanceThreshold = "10";
    getFalBalance.mockResolvedValue({ status: "forbidden" });
    expect(await checkBalanceAndAlert()).toEqual({ status: "balance_forbidden" });
    expect(sendSlackAlert).not.toHaveBeenCalled();
  });

  it("sends and sets alerted=true when below and not alerted", async () => {
    settings.falBalanceThreshold = "10";
    getFalBalance.mockResolvedValue({ status: "ok", balance: 4.5, currency: "USD", username: "t" });
    const r = await checkBalanceAndAlert();
    expect(r).toEqual({ status: "ok", sent: true });
    expect(sendSlackAlert).toHaveBeenCalledOnce();
    expect(settings.falBalanceAlerted).toBe("true");
  });

  it("suppresses while still low (already alerted)", async () => {
    settings.falBalanceThreshold = "10";
    settings.falBalanceAlerted = "true";
    getFalBalance.mockResolvedValue({ status: "ok", balance: 4.5, currency: "USD", username: "t" });
    const r = await checkBalanceAndAlert();
    expect(r).toEqual({ status: "ok", sent: false });
    expect(sendSlackAlert).not.toHaveBeenCalled();
    expect(settings.falBalanceAlerted).toBe("true");
  });

  it("re-arms (alerted=false) after recovery", async () => {
    settings.falBalanceThreshold = "10";
    settings.falBalanceAlerted = "true";
    getFalBalance.mockResolvedValue({ status: "ok", balance: 20, currency: "USD", username: "t" });
    await checkBalanceAndAlert();
    expect(sendSlackAlert).not.toHaveBeenCalled();
    expect(settings.falBalanceAlerted).toBe("false");
  });
});
