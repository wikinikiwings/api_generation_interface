import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _openForTest, _closeForTest } from "@/lib/history/sse";
import { useHistoryStore, _resetForTest } from "@/lib/history/store";
import { _resetHydrateForTest } from "@/lib/history/hydrate";

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  readyState = 1;
  listeners = new Map<string, (ev: unknown) => void>();
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    this.listeners.set(type, cb);
  }
  fire(type: string, payload: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
  fireRaw(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data } as MessageEvent);
  }
  close(): void {
    this.readyState = 2;
  }
}

beforeEach(() => {
  _resetForTest();
  _resetHydrateForTest();
  MockEventSource.instances = [];
  (global as unknown as { EventSource: typeof MockEventSource }).EventSource =
    MockEventSource;
  global.fetch = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => [] } as Response);
});

afterEach(() => {
  _closeForTest();
  vi.restoreAllMocks();
});

describe("sse handler", () => {
  it("U19: generation.created → applyServerRow, no fetch", () => {
    _openForTest("alice");
    const es = MockEventSource.instances[0];
    es.fire("generation.created", {
      id: 100,
      username: "alice",
      workflow_name: "t",
      prompt_data: "{}",
      execution_time_seconds: 1,
      created_at: new Date().toISOString(),
      status: "completed",
      outputs: [
        {
          id: 1,
          generation_id: 100,
          filename: "a.png",
          filepath: "550e8400-e29b-41d4-a716-446655440000.png",
          content_type: "image/png",
          size: 100,
        },
      ],
    });
    expect(
      useHistoryStore.getState().entries.find((e) => e.serverGenId === 100)
    ).toBeDefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("U20: generation.deleted → deleteEntry with skipServerDelete=true", async () => {
    useHistoryStore.setState({
      entries: [
        {
          id: "abc",
          serverGenId: 100,
          state: "live",
          confirmed: true,
          prompt: "",
          provider: "wavespeed",
          createdAt: Date.now(),
          status: "completed",
          error: null,
        },
      ],
      error: null,
    });
    _openForTest("alice");
    const es = MockEventSource.instances[0];
    es.fire("generation.deleted", { id: 100 });
    await new Promise((r) => setTimeout(r, 0));
    expect(useHistoryStore.getState().entries[0].state).toBe("removed");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("U21: open event triggers hydrateFromServer", async () => {
    vi.useFakeTimers();
    _openForTest("alice");
    const es = MockEventSource.instances[0];
    es.fire("open", {});
    await vi.advanceTimersByTimeAsync(60);
    expect(global.fetch).toHaveBeenCalled();
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("username=alice");
    vi.useRealTimers();
  });

  it("U22: malformed payload doesn't crash", () => {
    _openForTest("alice");
    const es = MockEventSource.instances[0];
    expect(() => es.fireRaw("generation.created", "not json")).not.toThrow();
    expect(() => es.fireRaw("generation.deleted", "not json")).not.toThrow();
  });
});
