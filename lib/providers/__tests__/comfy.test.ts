import { describe, it, expect, vi, afterEach } from "vitest";
import { buildImageParts } from "@/lib/providers/comfy";

const dataUri = (mime: string, payload: string) =>
  `data:${mime};base64,${payload}`;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("buildImageParts", () => {
  it("keeps small images inline — no network, no fileData", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const parts = await buildImageParts([
      dataUri("image/png", "AAAA"),
      dataUri("image/jpeg", "BBBB"),
    ]);
    expect(parts).toHaveLength(2);
    for (const p of parts) {
      expect(p.inlineData).toBeDefined();
      expect(p.fileData).toBeUndefined();
    }
    // The whole point of inline: Vertex never crawls anything → no
    // URL_TIMEOUT-TIMEOUT_FETCHPROXY. Lock that in.
    expect(spy).not.toHaveBeenCalled();
  });

  it("preserves mimeType and base64 payload for inline parts", async () => {
    const parts = await buildImageParts([dataUri("image/webp", "Zm9v")]);
    expect(parts[0].inlineData).toEqual({
      mimeType: "image/webp",
      data: "Zm9v",
    });
  });

  it("uploads images that overflow the inline budget and references them by URL", async () => {
    vi.stubEnv("COMFY_API_KEY", "comfyui-test-key");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        if (String(url).includes("/customers/storage")) {
          return new Response(
            JSON.stringify({
              download_url: "https://storage.example/dl",
              upload_url: "https://storage.example/up",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(null, { status: 200 }); // signed-URL PUT
      });

    // Tiny 3-byte budget: the first 3-byte image fits inline, the second
    // overflows and must go by URL.
    const parts = await buildImageParts(
      [dataUri("image/png", "AAAA"), dataUri("image/png", "BBBBCCCC")],
      3
    );

    expect(parts[0].inlineData).toBeDefined();
    expect(parts[0].fileData).toBeUndefined();
    expect(parts[1].fileData).toEqual({
      mimeType: "image/png",
      fileUri: "https://storage.example/dl",
    });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("throws when more images overflow than Vertex allows by URL", async () => {
    // 11 images, zero budget → all 11 want the URL path; the cap is 10.
    // Fails up front, before any upload round-trip.
    const imgs = Array.from({ length: 11 }, () => dataUri("image/png", "AAAA"));
    await expect(buildImageParts(imgs, 0)).rejects.toThrow(/too large/i);
  });

  it("throws a 1-indexed error on non-data-URI input", async () => {
    await expect(
      buildImageParts([
        dataUri("image/png", "AAAA"),
        "https://example.com/not-a-data-uri.png",
      ])
    ).rejects.toThrow(/Image 2/);
  });

  it("returns an empty array for no images", async () => {
    expect(await buildImageParts([])).toEqual([]);
  });
});
