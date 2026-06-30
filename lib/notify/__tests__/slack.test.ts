import { describe, it, expect, vi, afterEach } from "vitest";
import { sendSlackAlert } from "@/lib/notify/slack";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sendSlackAlert", () => {
  it("returns false and does not fetch when webhook unset", async () => {
    vi.stubEnv("FAL_BALANCE_SLACK_WEBHOOK", "");
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await sendSlackAlert("hi")).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("posts {text} as JSON and returns true on 200", async () => {
    vi.stubEnv("FAL_BALANCE_SLACK_WEBHOOK", "https://hooks.slack.com/services/X");
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    expect(await sendSlackAlert("привет ✅")).toBe(true);
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain("hooks.slack.com");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ text: "привет ✅" });
  });

  it("returns false on non-ok", async () => {
    vi.stubEnv("FAL_BALANCE_SLACK_WEBHOOK", "https://hooks.slack.com/services/X");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad", { status: 500 }));
    expect(await sendSlackAlert("x")).toBe(false);
  });

  it("returns false when fetch throws", async () => {
    vi.stubEnv("FAL_BALANCE_SLACK_WEBHOOK", "https://hooks.slack.com/services/X");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    expect(await sendSlackAlert("x")).toBe(false);
  });
});
