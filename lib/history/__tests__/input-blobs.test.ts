import { describe, it, expect } from "vitest";
import { buildInputUploadBlobs } from "@/lib/history/input-blobs";

/** Build a base64 data URL for the given ASCII payload. */
function dataUrl(payload: string, mime = "image/jpeg"): string {
  return `data:${mime};base64,${btoa(payload)}`;
}

describe("buildInputUploadBlobs", () => {
  it("builds full + thumb blobs from in-memory data URLs (never from a File)", () => {
    // Note: the image objects intentionally carry ONLY dataUrl — no `file`.
    // The helper must not depend on a disk-backed File reference, whose
    // snapshot Chromium re-validates at send time (net::ERR_UPLOAD_FILE_CHANGED).
    const { fulls, thumbs } = buildInputUploadBlobs(
      [{ dataUrl: dataUrl("FULLBYTES") }],
      [dataUrl("thumb")]
    );

    expect(fulls).toHaveLength(1);
    expect(thumbs).toHaveLength(1);
    expect(fulls[0].size).toBe("FULLBYTES".length);
    expect(fulls[0].type).toBe("image/jpeg");
    expect(thumbs[0].size).toBe("thumb".length);
  });

  it("drops a pair when the thumbnail is not a base64 data URL, keeping alignment", () => {
    const { fulls, thumbs } = buildInputUploadBlobs(
      [{ dataUrl: dataUrl("A") }, { dataUrl: dataUrl("B") }],
      ["blob:not-a-data-url", dataUrl("t")]
    );

    // First pair dropped (bad thumbnail); second pair kept and aligned.
    expect(fulls).toHaveLength(1);
    expect(thumbs).toHaveLength(1);
    expect(fulls[0].size).toBe("B".length);
    expect(thumbs[0].size).toBe("t".length);
  });

  it("drops a pair when the full data URL is not a base64 data URL", () => {
    const { fulls, thumbs } = buildInputUploadBlobs(
      [{ dataUrl: "blob:nope" }],
      [dataUrl("t")]
    );

    expect(fulls).toHaveLength(0);
    expect(thumbs).toHaveLength(0);
  });
});
