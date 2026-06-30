import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

const fakeReq = (body?: unknown) =>
  ({ cookies: { get: () => ({ value: "sid" }) }, json: async () => body ?? {} } as never);

function mockDb() {
  const store: Record<string, string> = {};
  vi.doMock("@/lib/history-db", () => ({
    getDb: () => ({}),
    getAppSetting: (k: string) => store[k] ?? null,
    setAppSetting: (k: string, v: string) => { store[k] = v; },
  }));
  return store;
}

describe("GET /api/admin/balance-config", () => {
  it("401 when not authenticated", async () => {
    mockDb();
    vi.doMock("@/lib/auth/current-user", () => ({ getCurrentUser: () => null }));
    const { GET } = await import("@/app/api/admin/balance-config/route");
    expect((await GET(fakeReq())).status).toBe(401);
  });

  it("403 when not admin", async () => {
    mockDb();
    vi.doMock("@/lib/auth/current-user", () => ({ getCurrentUser: () => ({ role: "user" }) }));
    const { GET } = await import("@/app/api/admin/balance-config/route");
    expect((await GET(fakeReq())).status).toBe(403);
  });

  it("returns stored threshold + times for admin", async () => {
    const store = mockDb();
    store.falBalanceThreshold = "10";
    store.falBalanceCheckTimes = JSON.stringify(["09:00"]);
    vi.doMock("@/lib/auth/current-user", () => ({ getCurrentUser: () => ({ role: "admin" }) }));
    const { GET } = await import("@/app/api/admin/balance-config/route");
    const res = await GET(fakeReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threshold: 10, checkTimesUtc: ["09:00"] });
  });
});

describe("PUT /api/admin/balance-config", () => {
  it("403 for non-admin", async () => {
    mockDb();
    vi.doMock("@/lib/auth/current-user", () => ({ getCurrentUser: () => ({ role: "user" }) }));
    const { PUT } = await import("@/app/api/admin/balance-config/route");
    expect((await PUT(fakeReq({ threshold: 10, checkTimesUtc: [] }))).status).toBe(403);
  });

  it("400 on bad time string", async () => {
    mockDb();
    vi.doMock("@/lib/auth/current-user", () => ({ getCurrentUser: () => ({ role: "admin" }) }));
    const { PUT } = await import("@/app/api/admin/balance-config/route");
    expect((await PUT(fakeReq({ threshold: 10, checkTimesUtc: ["9am"] }))).status).toBe(400);
  });

  it("400 on negative threshold", async () => {
    mockDb();
    vi.doMock("@/lib/auth/current-user", () => ({ getCurrentUser: () => ({ role: "admin" }) }));
    const { PUT } = await import("@/app/api/admin/balance-config/route");
    expect((await PUT(fakeReq({ threshold: -1, checkTimesUtc: [] }))).status).toBe(400);
  });

  it("persists valid config and returns 200", async () => {
    const store = mockDb();
    vi.doMock("@/lib/auth/current-user", () => ({ getCurrentUser: () => ({ role: "admin" }) }));
    const { PUT } = await import("@/app/api/admin/balance-config/route");
    const res = await PUT(fakeReq({ threshold: 15, checkTimesUtc: ["05:00", "17:30"] }));
    expect(res.status).toBe(200);
    expect(store.falBalanceThreshold).toBe("15");
    expect(JSON.parse(store.falBalanceCheckTimes)).toEqual(["05:00", "17:30"]);
  });
});
