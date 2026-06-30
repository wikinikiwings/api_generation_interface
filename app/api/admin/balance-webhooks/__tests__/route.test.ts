import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

const fakeReq = (body?: unknown) =>
  ({ cookies: { get: () => ({ value: "sid" }) }, json: async () => body ?? {} } as never);

function mocks(opts: { role?: string | null } = {}) {
  vi.doMock("@/lib/history-db", () => ({ getDb: () => ({}) }));
  vi.doMock("@/lib/auth/current-user", () => ({
    getCurrentUser: () => (opts.role === undefined ? { role: "admin" } : opts.role === null ? null : { role: opts.role }),
  }));
  const addWebhook = vi.fn(() => ({ id: "id-1" }));
  const removeWebhook = vi.fn();
  const listWebhooksMasked = vi.fn(() => [{ id: "id-1", label: "Маша", urlMask: "…123456" }]);
  vi.doMock("@/lib/admin/balance-webhooks", () => ({ addWebhook, removeWebhook, listWebhooksMasked }));
  return { addWebhook, removeWebhook, listWebhooksMasked };
}

describe("/api/admin/balance-webhooks", () => {
  it("GET 401 when unauthenticated", async () => {
    mocks({ role: null });
    const { GET } = await import("@/app/api/admin/balance-webhooks/route");
    expect((await GET(fakeReq())).status).toBe(401);
  });

  it("GET 403 for non-admin", async () => {
    mocks({ role: "user" });
    const { GET } = await import("@/app/api/admin/balance-webhooks/route");
    expect((await GET(fakeReq())).status).toBe(403);
  });

  it("GET returns masked webhooks (no full url) for admin", async () => {
    mocks();
    const { GET } = await import("@/app/api/admin/balance-webhooks/route");
    const res = await GET(fakeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ webhooks: [{ id: "id-1", label: "Маша", urlMask: "…123456" }] });
    expect(JSON.stringify(body)).not.toContain("hooks.slack.com");
  });

  it("POST adds a valid webhook → ok + id", async () => {
    const m = mocks();
    const { POST } = await import("@/app/api/admin/balance-webhooks/route");
    const res = await POST(fakeReq({ label: "Маша", url: "https://hooks.slack.com/services/A/B/c" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "id-1" });
    expect(m.addWebhook).toHaveBeenCalledWith({ label: "Маша", url: "https://hooks.slack.com/services/A/B/c" });
  });

  it("POST 400 when addWebhook rejects (bad url)", async () => {
    const m = mocks();
    m.addWebhook.mockImplementation(() => { throw new Error("url must be a Slack incoming webhook"); });
    const { POST } = await import("@/app/api/admin/balance-webhooks/route");
    const res = await POST(fakeReq({ label: "x", url: "https://evil/abc" }));
    expect(res.status).toBe(400);
  });

  it("DELETE removes by id → ok", async () => {
    const m = mocks();
    const { DELETE } = await import("@/app/api/admin/balance-webhooks/route");
    const res = await DELETE(fakeReq({ id: "id-1" }));
    expect(res.status).toBe(200);
    expect(m.removeWebhook).toHaveBeenCalledWith("id-1");
  });

  it("DELETE 400 when id missing", async () => {
    mocks();
    const { DELETE } = await import("@/app/api/admin/balance-webhooks/route");
    expect((await DELETE(fakeReq({}))).status).toBe(400);
  });
});
