import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  deleteEntry,
  addPendingEntry,
  setUsernameForTest,
} from "@/lib/history/mutations";
import {
  useHistoryStore,
  applyServerRow,
  _resetForTest,
} from "@/lib/history/store";
import { setPendingControls, _resetPendingControls } from "@/lib/history/pending";
import type { ServerGeneration } from "@/lib/history/types";

const mkRow = (
  id: number,
  uuid = "550e8400-e29b-41d4-a716-446655440000"
): ServerGeneration => ({
  id,
  username: "alice",
  workflow_name: "test",
  prompt_data: '{"prompt":"hi"}',
  execution_time_seconds: 1,
  created_at: new Date().toISOString(),
  status: "completed",
  outputs: [
    {
      id: 1,
      generation_id: id,
      filename: "out.png",
      filepath: `${uuid}.png`,
      content_type: "image/png",
      size: 1024,
    },
  ],
});

beforeEach(() => {
  _resetForTest();
  _resetPendingControls();
  setUsernameForTest("alice");
  global.fetch = vi.fn();
  global.URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

describe("deleteEntry", () => {
  it("U9: PENDING entry → REMOVED, no fetch, abort called", async () => {
    const abort = vi.fn();
    addPendingEntry({
      uuid: "abc",
      prompt: "hi",
      provider: "wavespeed",
      createdAt: Date.now(),
      localBlobUrls: ["blob:foo"],
    });
    setPendingControls("abc", { abort });
    await deleteEntry("abc");
    expect(abort).toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    const entry = useHistoryStore
      .getState()
      .entries.find((e) => e.id === "abc")!;
    expect(entry.state).toBe("removed");
  });

  it("U10: LIVE happy path → DELETING → REMOVED, fetch DELETE called", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
    } as Response);
    applyServerRow(mkRow(100));
    const id = useHistoryStore.getState().entries[0].id;
    await deleteEntry(id);
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/history?id=100",
      { method: "DELETE" }
    );
    expect(useHistoryStore.getState().entries[0].state).toBe("removed");
  });

  it("U11: LIVE with HTTP 500 → rollback to LIVE, toast.error called", async () => {
    const toastModule = await import("sonner");
    const errSpy = vi.spyOn(toastModule.toast, "error");
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);
    applyServerRow(mkRow(100));
    const id = useHistoryStore.getState().entries[0].id;
    await deleteEntry(id);
    expect(useHistoryStore.getState().entries[0].state).toBe("live");
    expect(errSpy).toHaveBeenCalled();
  });

  it("U12: idempotent on DELETING", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
    } as Response);
    applyServerRow(mkRow(100));
    const id = useHistoryStore.getState().entries[0].id;
    const p1 = deleteEntry(id);
    const p2 = deleteEntry(id);
    await Promise.all([p1, p2]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("U13: idempotent on REMOVED", async () => {
    applyServerRow(mkRow(100));
    const id = useHistoryStore.getState().entries[0].id;
    useHistoryStore.setState((s) => ({
      entries: s.entries.map((e) =>
        e.id === id ? { ...e, state: "removed" } : e
      ),
    }));
    await deleteEntry(id);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("U14: deleteEntry(serverGenId: number) finds by serverGenId", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
    } as Response);
    applyServerRow(mkRow(100));
    await deleteEntry(100);
    expect(useHistoryStore.getState().entries[0].state).toBe("removed");
  });

  it("U15: skipServerDelete=true skips fetch", async () => {
    applyServerRow(mkRow(100));
    await deleteEntry(100, { skipServerDelete: true });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(useHistoryStore.getState().entries[0].state).toBe("removed");
  });
});
