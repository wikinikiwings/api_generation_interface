import { describe, it, expect } from "vitest";
import { extractServerUuid } from "@/lib/history-urls";

describe("extractServerUuid", () => {
  it("extracts uuid from a canonical local history-image URL", () => {
    const url =
      "/api/history/image/alice%40x.com/2026/05/8f3b2c1a-1111-2222-3333-444455556666.png";
    expect(extractServerUuid(url)).toBe(
      "8f3b2c1a-1111-2222-3333-444455556666"
    );
  });

  it("handles uppercase hex and varied extensions", () => {
    expect(
      extractServerUuid("/api/history/image/u%40x.com/2026/05/ABC-DEF.jpeg")
    ).toBe("ABC-DEF");
    expect(
      extractServerUuid("/api/history/image/u%40x.com/2026/05/abc.webp")
    ).toBe("abc");
  });

  it("returns null for external URLs", () => {
    expect(
      extractServerUuid("https://fal.media/files/elephant/abc-def.png")
    ).toBeNull();
  });

  it("returns null for blob and data URIs", () => {
    expect(extractServerUuid("blob:http://localhost:3000/abc")).toBeNull();
    expect(extractServerUuid("data:image/png;base64,iVBOR...")).toBeNull();
  });

  it("returns null for the legacy flat layout (no email/yyyy/mm)", () => {
    expect(
      extractServerUuid("/api/history/image/abc-def.png")
    ).toBeNull();
  });

  it("returns null for URLs missing the file extension", () => {
    expect(
      extractServerUuid("/api/history/image/u%40x.com/2026/05/abc-def")
    ).toBeNull();
  });
});
