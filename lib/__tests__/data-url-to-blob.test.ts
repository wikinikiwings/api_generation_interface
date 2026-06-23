import { describe, it, expect } from "vitest";
import { dataUrlToBlob } from "@/lib/utils";

describe("dataUrlToBlob", () => {
  it("decodes a base64 jpeg data URL to a typed Blob", async () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
    const b64 = Buffer.from(bytes).toString("base64");
    const blob = dataUrlToBlob(`data:image/jpeg;base64,${b64}`);
    expect(blob.type).toBe("image/jpeg");
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([0xff, 0xd8, 0xff, 0xe0]);
  });
  it("throws on a non-data URL", () => {
    expect(() => dataUrlToBlob("https://example.com/x.jpg")).toThrow();
  });
});
