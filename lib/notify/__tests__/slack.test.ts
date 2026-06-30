import { describe, it, expect, vi, afterEach } from "vitest";
import { sendSlackAlert } from "@/lib/notify/slack";

afterEach(() => {
  vi.restoreAllMocks();
});

const URL = "https://hooks.slack.com/services/X";

describe("sendSlackAlert", () => {
  it("returns false and does not fetch when url is empty", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await sendSlackAlert("hi", "")).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("posts {text} as JSON to the given url and returns true on 200", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    expect(await sendSlackAlert("привет ✅", URL)).toBe(true);
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe(URL);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ text: "привет ✅" });
  });

  it("returns false on non-ok", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad", { status: 500 }));
    expect(await sendSlackAlert("x", URL)).toBe(false);
  });

  it("returns false when fetch throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    expect(await sendSlackAlert("x", URL)).toBe(false);
  });
});
