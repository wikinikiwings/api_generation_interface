import { describe, it, expect, vi, beforeEach } from "vitest";
import { uploadHistoryEntry } from "@/lib/history-upload";

const captured: { fd?: FormData } = {};
beforeEach(() => {
  captured.fd = undefined;
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
    captured.fd = init.body as FormData;
    return new Response(JSON.stringify({ id: 1, fullUrl: "/f", thumbUrl: "/t", midUrl: "/m" }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});
function base() {
  return {
    uuid: "0123abcd-4567-89ab-cdef-0123456789ab", workflowName: "wf",
    promptData: { prompt: "p" }, executionTimeSeconds: 1,
    original: new Blob(["o"], { type: "image/png" }), originalFilename: "o.png", originalContentType: "image/png",
    thumb: new Blob(["t"], { type: "image/jpeg" }), mid: new Blob(["m"], { type: "image/jpeg" }),
  };
}

describe("uploadHistoryEntry input assets", () => {
  it("appends inputCount + inputfull_/inputthumb_ parts", async () => {
    await uploadHistoryEntry({
      ...base(),
      inputImages: [new Blob(["F0"], { type: "image/png" }), new Blob(["F1"], { type: "image/webp" })],
      inputThumbs: [new Blob(["T0"], { type: "image/jpeg" }), new Blob(["T1"], { type: "image/jpeg" })],
    });
    const fd = captured.fd!;
    expect(fd.get("inputCount")).toBe("2");
    expect(fd.get("inputfull_0")).toBeInstanceOf(File);
    expect((fd.get("inputfull_1") as File).type).toBe("image/webp");
    expect(fd.get("inputthumb_0")).toBeInstanceOf(File);
    expect(fd.get("inputfull_2")).toBeNull();
  });
  it("sets inputCount=0 when no inputs", async () => {
    await uploadHistoryEntry(base());
    expect(captured.fd!.get("inputCount")).toBe("0");
    expect(captured.fd!.get("inputfull_0")).toBeNull();
  });
});
