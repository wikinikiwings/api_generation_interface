import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const store: Record<string, string | null> = {};
vi.mock("@/lib/history-db", () => ({
  getAppSetting: (k: string) => store[k] ?? null,
  setAppSetting: (k: string, v: string) => { store[k] = v; },
}));

import {
  maskUrl, listWebhooksMasked, addWebhook, removeWebhook, resolveTargets,
} from "@/lib/admin/balance-webhooks";

beforeEach(() => { for (const k of Object.keys(store)) delete store[k]; });
afterEach(() => { vi.unstubAllEnvs(); });

describe("maskUrl", () => {
  it("shows only the last 6 chars", () => {
    expect(maskUrl("https://hooks.slack.com/services/A/B/abcdef123456")).toBe("…123456");
  });
});

describe("addWebhook / listWebhooksMasked / removeWebhook", () => {
  it("adds a valid webhook and lists it masked (never the full url)", () => {
    const { id } = addWebhook({ label: "Маша", url: "https://hooks.slack.com/services/A/B/secret99" });
    expect(typeof id).toBe("string");
    const list = listWebhooksMasked();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, label: "Маша", urlMask: maskUrl("https://hooks.slack.com/services/A/B/secret99") });
    expect(JSON.stringify(list)).not.toContain("hooks.slack.com");
  });

  it("rejects a non-Slack url", () => {
    expect(() => addWebhook({ label: "x", url: "https://evil.example/abc" })).toThrow();
    expect(listWebhooksMasked()).toHaveLength(0);
  });

  it("rejects an empty label", () => {
    expect(() => addWebhook({ label: "  ", url: "https://hooks.slack.com/services/A/B/c" })).toThrow();
  });

  it("removes by id", () => {
    const { id } = addWebhook({ label: "a", url: "https://hooks.slack.com/services/A/B/c" });
    addWebhook({ label: "b", url: "https://hooks.slack.com/services/A/B/d" });
    removeWebhook(id);
    const list = listWebhooksMasked();
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe("b");
  });

  it("tolerates malformed stored JSON (treats as empty)", () => {
    store.falBalanceWebhooks = "not-json";
    expect(listWebhooksMasked()).toEqual([]);
  });
});

describe("resolveTargets", () => {
  it("returns configured urls when the list is non-empty", () => {
    addWebhook({ label: "a", url: "https://hooks.slack.com/services/A/B/c" });
    addWebhook({ label: "b", url: "https://hooks.slack.com/services/A/B/d" });
    expect(resolveTargets()).toEqual([
      "https://hooks.slack.com/services/A/B/c",
      "https://hooks.slack.com/services/A/B/d",
    ]);
  });

  it("falls back to the env webhook when the list is empty", () => {
    vi.stubEnv("FAL_BALANCE_SLACK_WEBHOOK", "https://hooks.slack.com/services/ENV");
    expect(resolveTargets()).toEqual(["https://hooks.slack.com/services/ENV"]);
  });

  it("returns [] when list empty and env unset", () => {
    vi.stubEnv("FAL_BALANCE_SLACK_WEBHOOK", "");
    expect(resolveTargets()).toEqual([]);
  });
});
