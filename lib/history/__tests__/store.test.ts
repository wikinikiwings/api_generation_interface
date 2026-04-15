import { describe, it, expect, beforeEach } from "vitest";
import {
  useHistoryStore,
  applyServerRow,
  applyServerList,
  serverGenToEntry,
  _resetForTest,
} from "@/lib/history/store";
import type { ServerGeneration } from "@/lib/history/types";

const mkRow = (overrides: Partial<ServerGeneration> = {}): ServerGeneration => ({
  id: 100,
  username: "alice",
  workflow_name: "test",
  prompt_data: '{"prompt":"hi"}',
  execution_time_seconds: 1,
  created_at: new Date().toISOString(),
  status: "completed",
  outputs: [
    {
      id: 1,
      generation_id: 100,
      filename: "out.png",
      filepath: "550e8400-e29b-41d4-a716-446655440000.png",
      content_type: "image/png",
      size: 1024,
    },
  ],
  ...overrides,
});

beforeEach(() => _resetForTest());

describe("applyServerRow", () => {
  it("U1: inserts new row as state=live", () => {
    applyServerRow(mkRow({ id: 100 }));
    const entries = useHistoryStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].state).toBe("live");
    expect(entries[0].serverGenId).toBe(100);
    expect(entries[0].confirmed).toBe(true);
  });

  it("U2: merges metadata for existing LIVE, keeps blob URLs", () => {
    applyServerRow(mkRow({ id: 100 }));
    useHistoryStore.setState((s) => ({
      entries: s.entries.map((e) =>
        e.serverGenId === 100 ? { ...e, outputUrl: "blob:x" } : e
      ),
    }));
    applyServerRow(mkRow({ id: 100, prompt_data: '{"prompt":"updated"}' }));
    const entry = useHistoryStore.getState().entries.find((e) => e.serverGenId === 100)!;
    expect(entry.outputUrl).toBe("blob:x");
    expect(entry.prompt).toBe("updated");
  });

  it("U3: ignores existing DELETING entry", () => {
    applyServerRow(mkRow({ id: 100 }));
    const id = useHistoryStore.getState().entries[0].id;
    useHistoryStore.setState((s) => ({
      entries: s.entries.map((e) => (e.id === id ? { ...e, state: "deleting" } : e)),
    }));
    applyServerRow(mkRow({ id: 100 }));
    expect(useHistoryStore.getState().entries[0].state).toBe("deleting");
  });

  it("U4: ignores existing REMOVED entry", () => {
    applyServerRow(mkRow({ id: 100 }));
    const id = useHistoryStore.getState().entries[0].id;
    useHistoryStore.setState((s) => ({
      entries: s.entries.map((e) => (e.id === id ? { ...e, state: "removed" } : e)),
    }));
    applyServerRow(mkRow({ id: 100 }));
    expect(useHistoryStore.getState().entries[0].state).toBe("removed");
  });

  it("U5: PENDING + matching server row → LIVE with serverGenId, blob URLs preserved", () => {
    useHistoryStore.setState({
      entries: [
        {
          id: "550e8400-e29b-41d4-a716-446655440000",
          state: "pending",
          confirmed: false,
          prompt: "hi",
          provider: "wavespeed",
          createdAt: Date.now(),
          status: "completed",
          error: null,
          outputUrl: "blob:y",
        },
      ],
      error: null,
    });
    applyServerRow(mkRow({ id: 200 }));
    const entry = useHistoryStore.getState().entries[0];
    expect(entry.state).toBe("live");
    expect(entry.confirmed).toBe(true);
    expect(entry.serverGenId).toBe(200);
    expect(entry.outputUrl).toBe("blob:y");
  });

  it("hydrates userPrompt and styleId from prompt_data when present", () => {
    const row = mkRow({
      prompt_data: JSON.stringify({
        prompt: "cinematic. a cat. 35mm",
        userPrompt: "a cat",
        styleId: "kino-a3f",
      }),
    });
    const entry = serverGenToEntry(row, "uuid-1");
    expect(entry.prompt).toBe("cinematic. a cat. 35mm");
    expect(entry.userPrompt).toBe("a cat");
    expect(entry.styleId).toBe("kino-a3f");
  });

  it("leaves userPrompt and styleId undefined for pre-feature entries", () => {
    const row = mkRow({
      prompt_data: JSON.stringify({ prompt: "a cat" }),
    });
    const entry = serverGenToEntry(row, "uuid-2");
    expect(entry.prompt).toBe("a cat");
    expect(entry.userPrompt).toBeUndefined();
    expect(entry.styleId).toBeUndefined();
  });
});

describe("applyServerList cross-device delete", () => {
  it("U6: LIVE entry with serverGenId absent from response → REMOVED", () => {
    // Both entries within response window (oldest=10:00, both >= 10:00).
    // Server response will contain only 200; 100 should be removed.
    applyServerRow(
      mkRow({
        id: 100,
        created_at: "2026-04-13T11:00:00Z",
        outputs: [
          {
            id: 1,
            generation_id: 100,
            filename: "a.png",
            filepath: "11111111-1111-1111-1111-111111111111.png",
            content_type: "image/png",
            size: 100,
          },
        ],
      })
    );
    applyServerRow(
      mkRow({
        id: 200,
        created_at: "2026-04-13T10:00:00Z",
        outputs: [
          {
            id: 2,
            generation_id: 200,
            filename: "b.png",
            filepath: "22222222-2222-2222-2222-222222222222.png",
            content_type: "image/png",
            size: 100,
          },
        ],
      })
    );
    expect(
      useHistoryStore.getState().entries.filter((e) => e.state === "live")
    ).toHaveLength(2);

    applyServerList(
      [
        mkRow({
          id: 200,
          created_at: "2026-04-13T10:00:00Z",
          outputs: [
            {
              id: 2,
              generation_id: 200,
              filename: "b.png",
              filepath: "22222222-2222-2222-2222-222222222222.png",
              content_type: "image/png",
              size: 100,
            },
          ],
        }),
      ],
      { offset: 0 }
    );

    const states = useHistoryStore.getState().entries.map((e) => ({
      serverGenId: e.serverGenId,
      state: e.state,
    }));
    expect(states).toContainEqual({ serverGenId: 100, state: "removed" });
    expect(states).toContainEqual({ serverGenId: 200, state: "live" });
  });

  it("U7: with offset > 0, cross-device-delete is skipped (pagination case)", () => {
    applyServerRow(
      mkRow({
        id: 100,
        created_at: "2026-04-13T11:00:00Z",
        outputs: [
          {
            id: 1,
            generation_id: 100,
            filename: "a.png",
            filepath: "11111111-1111-1111-1111-111111111111.png",
            content_type: "image/png",
            size: 100,
          },
        ],
      })
    );
    applyServerList(
      [
        mkRow({
          id: 200,
          created_at: "2026-04-13T10:00:00Z",
          outputs: [
            {
              id: 2,
              generation_id: 200,
              filename: "b.png",
              filepath: "22222222-2222-2222-2222-222222222222.png",
              content_type: "image/png",
              size: 100,
            },
          ],
        }),
      ],
      { offset: 20 }
    );
    const entry = useHistoryStore.getState().entries.find((e) => e.serverGenId === 100)!;
    expect(entry.state).toBe("live");
  });

  it("U8: entry with createdAt older than oldest in response is preserved", () => {
    applyServerRow(
      mkRow({
        id: 100,
        created_at: "2026-04-12T10:00:00Z",
        outputs: [
          {
            id: 1,
            generation_id: 100,
            filename: "a.png",
            filepath: "11111111-1111-1111-1111-111111111111.png",
            content_type: "image/png",
            size: 100,
          },
        ],
      })
    );
    applyServerList(
      [
        mkRow({
          id: 200,
          created_at: "2026-04-13T11:00:00Z",
          outputs: [
            {
              id: 2,
              generation_id: 200,
              filename: "b.png",
              filepath: "22222222-2222-2222-2222-222222222222.png",
              content_type: "image/png",
              size: 100,
            },
          ],
        }),
      ],
      { offset: 0 }
    );
    const entry = useHistoryStore.getState().entries.find((e) => e.serverGenId === 100)!;
    expect(entry.state).toBe("live");
  });
});
