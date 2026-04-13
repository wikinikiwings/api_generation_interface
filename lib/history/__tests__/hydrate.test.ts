import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { hydrateFromServer, _resetHydrateForTest } from "@/lib/history/hydrate";
import { useHistoryStore, _resetForTest } from "@/lib/history/store";

beforeEach(() => {
  _resetForTest();
  _resetHydrateForTest();
  vi.useFakeTimers();
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const mockOk = (rows: unknown[]) =>
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    json: async () => rows,
  } as Response);

describe("hydrateFromServer", () => {
  it("U16: concurrent calls share one fetch", async () => {
    mockOk([]);
    const p1 = hydrateFromServer({ username: "alice" });
    const p2 = hydrateFromServer({ username: "alice" });
    expect(p1).toBe(p2);
    await vi.runAllTimersAsync();
    await p1;
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("U17: stale response is discarded if newer request fired", async () => {
    let resolveFirst!: (v: unknown) => void;
    let resolveSecond!: (v: unknown) => void;
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveFirst = r;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveSecond = r;
          })
      );

    const p1 = hydrateFromServer({ username: "alice" });
    await vi.advanceTimersByTimeAsync(60);
    // Reset internal pending so a second hydrate can start a new request.
    // keepReqId=true preserves activeReqId so the stale-discard invariant
    // is exercised: the second request bumps reqId past the first.
    _resetHydrateForTest({ keepReqId: true });
    const p2 = hydrateFromServer({ username: "alice" });
    await vi.advanceTimersByTimeAsync(60);

    // Resolve the SECOND first (newer reqId), then first (stale).
    resolveSecond({
      ok: true,
      json: async () => [
        {
          id: 999,
          username: "alice",
          workflow_name: "t",
          prompt_data: "{}",
          execution_time_seconds: 1,
          created_at: new Date().toISOString(),
          status: "completed",
          outputs: [
            {
              id: 1,
              generation_id: 999,
              filename: "x.png",
              filepath: "99999999-9999-9999-9999-999999999999.png",
              content_type: "image/png",
              size: 1,
            },
          ],
        },
      ],
    });
    await p2;
    resolveFirst({
      ok: true,
      json: async () => [
        {
          id: 1,
          username: "alice",
          workflow_name: "t",
          prompt_data: "{}",
          execution_time_seconds: 1,
          created_at: new Date().toISOString(),
          status: "completed",
          outputs: [
            {
              id: 2,
              generation_id: 1,
              filename: "y.png",
              filepath: "11111111-1111-1111-1111-111111111111.png",
              content_type: "image/png",
              size: 1,
            },
          ],
        },
      ],
    });
    await p1;

    const ids = useHistoryStore.getState().entries.map((e) => e.serverGenId);
    expect(ids).not.toContain(1);
  });

  it("U18: 5 rapid calls collapse to one fetch via 50ms debounce", async () => {
    mockOk([]);
    for (let i = 0; i < 5; i++) hydrateFromServer({ username: "alice" });
    await vi.runAllTimersAsync();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
