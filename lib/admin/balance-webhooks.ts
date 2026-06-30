// Server-only. Stores the per-person Slack webhooks for the low-balance alert
// in app_settings (key falBalanceWebhooks). URLs are secrets: reads are masked,
// the full URL never leaves the server except as an outbound POST.

import { getAppSetting, setAppSetting } from "@/lib/history-db";
import { randomUUID } from "node:crypto";

export interface Webhook {
  id: string;
  label: string;
  url: string;
}
export interface MaskedWebhook {
  id: string;
  label: string;
  urlMask: string;
}

const KEY = "falBalanceWebhooks";
const SLACK_PREFIX = "https://hooks.slack.com/";
const LABEL_MAX = 80;

export function maskUrl(url: string): string {
  return `…${url.slice(-6)}`;
}

function parse(): Webhook[] {
  const raw = getAppSetting(KEY);
  if (!raw) return [];
  try {
    const a = JSON.parse(raw);
    if (!Array.isArray(a)) return [];
    return a.filter(
      (x): x is Webhook =>
        !!x &&
        typeof x === "object" &&
        typeof (x as Webhook).id === "string" &&
        typeof (x as Webhook).label === "string" &&
        typeof (x as Webhook).url === "string"
    );
  } catch {
    return [];
  }
}

function persist(list: Webhook[]): void {
  setAppSetting(KEY, JSON.stringify(list));
}

export function listWebhooksMasked(): MaskedWebhook[] {
  return parse().map((w) => ({ id: w.id, label: w.label, urlMask: maskUrl(w.url) }));
}

export function addWebhook(input: { label: string; url: string }): { id: string } {
  const label = (input.label ?? "").trim();
  const url = (input.url ?? "").trim();
  if (!label) throw new Error("label is required");
  if (label.length > LABEL_MAX) throw new Error(`label must be <= ${LABEL_MAX} chars`);
  if (!url.startsWith(SLACK_PREFIX)) {
    throw new Error("url must be a Slack incoming webhook (https://hooks.slack.com/...)");
  }
  const list = parse();
  const id = randomUUID();
  list.push({ id, label, url });
  persist(list);
  return { id };
}

export function removeWebhook(id: string): void {
  persist(parse().filter((w) => w.id !== id));
}

export function resolveTargets(): string[] {
  const list = parse();
  if (list.length > 0) return list.map((w) => w.url);
  const env = process.env.FAL_BALANCE_SLACK_WEBHOOK;
  return env ? [env] : [];
}
