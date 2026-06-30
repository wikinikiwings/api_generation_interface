// Server-only. Decides + sends the low-balance Slack alert.
// decideAlert is a pure edge-trigger+re-arm core; checkBalanceAndAlert wires
// it to fal balance, app_settings state, and the Slack sender.

import { getFalBalance } from "@/lib/providers/fal-billing";
import { getAppSetting, setAppSetting } from "@/lib/history-db";
import { sendSlackAlert } from "@/lib/notify/slack";
import { resolveTargets } from "@/lib/admin/balance-webhooks";

export function decideAlert(args: {
  balance: number;
  threshold: number;
  alreadyAlerted: boolean;
}): { shouldSend: boolean; nextAlerted: boolean } {
  const { balance, threshold, alreadyAlerted } = args;
  if (balance < threshold && !alreadyAlerted) return { shouldSend: true, nextAlerted: true };
  if (balance >= threshold && alreadyAlerted) return { shouldSend: false, nextAlerted: false };
  return { shouldSend: false, nextAlerted: alreadyAlerted };
}

export async function checkBalanceAndAlert(): Promise<{ status: string; sent?: number }> {
  const raw = getAppSetting("falBalanceThreshold");
  const threshold = raw == null || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(threshold)) return { status: "no_threshold" };

  const bal = await getFalBalance();
  if (bal.status !== "ok") return { status: `balance_${bal.status}` };

  const alreadyAlerted = getAppSetting("falBalanceAlerted") === "true";
  const { shouldSend, nextAlerted } = decideAlert({ balance: bal.balance, threshold, alreadyAlerted });

  let sent = 0;
  if (shouldSend) {
    const text = `⚠️ fal.ai: баланс низкий — ${bal.balance.toFixed(2)} ${bal.currency} (порог ${threshold}). Пополнить: https://fal.ai/dashboard`;
    const urls = resolveTargets();
    const results = await Promise.all(urls.map((u) => sendSlackAlert(text, u)));
    sent = results.filter(Boolean).length;
  }
  setAppSetting("falBalanceAlerted", nextAlerted ? "true" : "false");
  return { status: "ok", sent };
}
