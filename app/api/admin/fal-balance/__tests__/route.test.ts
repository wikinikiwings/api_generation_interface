import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

const fakeReq = () => ({ cookies: { get: () => ({ value: "sid" }) } } as never);

describe("GET /api/admin/fal-balance", () => {
  it("401 when not authenticated", async () => {
    vi.doMock("@/lib/history-db", () => ({ getDb: () => ({}) }));
    vi.doMock("@/lib/auth/current-user", () => ({ getCurrentUser: () => null }));
    const { GET } = await import("@/app/api/admin/fal-balance/route");
    const res = await GET(fakeReq());
    expect(res.status).toBe(401);
  });

  it("403 when authenticated but not admin", async () => {
    vi.doMock("@/lib/history-db", () => ({ getDb: () => ({}) }));
    vi.doMock("@/lib/auth/current-user", () => ({
      getCurrentUser: () => ({ id: 1, email: "u@x.com", role: "user" }),
    }));
    const { GET } = await import("@/app/api/admin/fal-balance/route");
    const res = await GET(fakeReq());
    expect(res.status).toBe(403);
  });

  it("200 + delegates to getFalBalance for an admin", async () => {
    vi.doMock("@/lib/history-db", () => ({ getDb: () => ({}) }));
    vi.doMock("@/lib/auth/current-user", () => ({
      getCurrentUser: () => ({ id: 1, email: "a@x.com", role: "admin" }),
    }));
    vi.doMock("@/lib/providers/fal-billing", () => ({
      getFalBalance: async () => ({ status: "ok", balance: 10, currency: "USD", username: "t" }),
    }));
    const { GET } = await import("@/app/api/admin/fal-balance/route");
    const res = await GET(fakeReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", balance: 10, currency: "USD", username: "t" });
  });
});
