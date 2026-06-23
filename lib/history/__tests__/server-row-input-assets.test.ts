import { describe, it, expect } from "vitest";
import { serverGenToEntry } from "@/lib/history/store";
import type { ServerGeneration } from "@/lib/history/types";

function row(pd: object): ServerGeneration {
  return {
    id: 1, username: "alice@x.com", workflow_name: "wavespeed:wavespeed/nano-banana-pro/edit",
    prompt_data: JSON.stringify(pd), execution_time_seconds: 1, created_at: "2026-06-22T10:00:00.000Z",
    status: "completed",
    outputs: [{ id: 1, generation_id: 1, filename: "o.png",
      filepath: "alice@x.com/2026/06/0123abcd-4567-89ab-cdef-0123456789ab.png", content_type: "image/png", size: 3 }],
  };
}

describe("serverGenToEntry input assets", () => {
  it("reads URL thumbnails + full images", () => {
    const t = ["/api/history/image/alice%40x.com/2026/06/input_thumb_0123abcd-4567-89ab-cdef-0123456789ab_0.jpg"];
    const f = ["/api/history/image/alice%40x.com/2026/06/input_0123abcd-4567-89ab-cdef-0123456789ab_0.png"];
    const e = serverGenToEntry(row({ prompt: "p", inputThumbnails: t, inputImages: f }), "u");
    expect(e.inputThumbnails).toEqual(t);
    expect(e.inputImages).toEqual(f);
  });
  it("accepts legacy base64 thumbnails with no inputImages", () => {
    const b = ["data:image/jpeg;base64,/9j/4AAQ"];
    const e = serverGenToEntry(row({ prompt: "p", inputThumbnails: b }), "u");
    expect(e.inputThumbnails).toEqual(b);
    expect(e.inputImages).toBeUndefined();
  });
  it("undefined on absent/malformed", () => {
    expect(serverGenToEntry(row({ prompt: "p" }), "u").inputThumbnails).toBeUndefined();
    expect(serverGenToEntry(row({ prompt: "p", inputImages: [1] }), "u").inputImages).toBeUndefined();
  });
});
