import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/history-db", () => ({
  getDb: () => ({}),
  getHistoryImagesDir: () => "/roots/images",
  getHistoryVariantsDir: () => "/roots/variants",
  getHistoryInputsDir: () => "/roots/inputs",
}));
vi.mock("@/lib/auth/current-user", () => ({
  getCurrentUser: () => ({ id: 1, email: "admin@x.com", role: "admin" }),
}));
const readFile = vi.fn(async (_path: string) => Buffer.from("BYTES"));
vi.mock("node:fs/promises", () => ({ default: { readFile: (p: string) => readFile(p) } }));

import { GET } from "@/app/api/history/image/[...path]/route";
const UUID = "0123abcd-4567-89ab-cdef-0123456789ab";
const req = () => ({ cookies: { get: () => ({ value: "sid" }) } } as never);

describe("image serve dispatch", () => {
  beforeEach(() => readFile.mockClear());

  it("routes full input_ to the inputs root", async () => {
    await GET(req(), { params: Promise.resolve({ path: ["alice@x.com", "2026", "06", `input_${UUID}_0.png`] }) });
    expect(String((readFile.mock.calls as [string][])[0][0]).replace(/\\/g, "/")).toContain("/roots/inputs");
  });
  it("routes input_thumb_ to the inputs root", async () => {
    await GET(req(), { params: Promise.resolve({ path: ["alice@x.com", "2026", "06", `input_thumb_${UUID}_0.jpg`] }) });
    expect(String((readFile.mock.calls as [string][])[0][0]).replace(/\\/g, "/")).toContain("/roots/inputs");
  });
  it("still routes thumb_ to variants", async () => {
    await GET(req(), { params: Promise.resolve({ path: ["alice@x.com", "2026", "06", `thumb_${UUID}.jpg`] }) });
    expect(String((readFile.mock.calls as [string][])[0][0]).replace(/\\/g, "/")).toContain("/roots/variants");
  });
});
