import { describe, it, expect, vi, afterEach } from "vitest";
import { getFalBalance } from "@/lib/providers/fal-billing";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("getFalBalance", () => {
  it("not_configured when FAL_ADMIN_KEY is unset — performs no network call", async () => {
    vi.stubEnv("FAL_ADMIN_KEY", "");
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await getFalBalance()).toEqual({ status: "not_configured" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("ok: maps credits and sends Key auth + expand=credits", async () => {
    vi.stubEnv("FAL_ADMIN_KEY", "admin-tok");
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ username: "team", credits: { current_balance: 24.5, currency: "USD" } }),
        { status: 200 }
      )
    );
    const r = await getFalBalance();
    expect(r).toEqual({ status: "ok", balance: 24.5, currency: "USD", username: "team" });
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain("expand=credits");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Key admin-tok" });
  });

  it("forbidden on 403", async () => {
    vi.stubEnv("FAL_ADMIN_KEY", "admin-tok");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 403 }));
    expect(await getFalBalance()).toEqual({ status: "forbidden" });
  });

  it("error on non-ok status", async () => {
    vi.stubEnv("FAL_ADMIN_KEY", "admin-tok");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));
    const r = await getFalBalance();
    expect(r.status).toBe("error");
  });

  it("error when fetch throws", async () => {
    vi.stubEnv("FAL_ADMIN_KEY", "admin-tok");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    expect(await getFalBalance()).toMatchObject({ status: "error" });
  });

  it("error when the response shape is unexpected (missing credits)", async () => {
    vi.stubEnv("FAL_ADMIN_KEY", "admin-tok");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ username: "team" }), { status: 200 })
    );
    expect(await getFalBalance()).toMatchObject({ status: "error" });
  });
});
