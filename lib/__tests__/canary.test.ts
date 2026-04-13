import { describe, it, expect } from "vitest";

describe("vitest infra", () => {
  it("runs and finds path alias", async () => {
    const mod = await import("@/lib/history-debug");
    expect(typeof mod.debugHistory).toBe("function");
  });
});
