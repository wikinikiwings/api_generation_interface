import { describe, it, expect } from "vitest";
import {
  THUMB_WIDTH,
  THUMB_QUALITY,
  MID_WIDTH,
  MID_QUALITY,
} from "@/lib/image-variants-spec";

describe("image-variants-spec", () => {
  it("exports four positive integer constants", () => {
    expect(Number.isInteger(THUMB_WIDTH)).toBe(true);
    expect(Number.isInteger(MID_WIDTH)).toBe(true);
    expect(Number.isInteger(THUMB_QUALITY)).toBe(true);
    expect(Number.isInteger(MID_QUALITY)).toBe(true);
    expect(THUMB_WIDTH).toBeGreaterThan(0);
    expect(MID_WIDTH).toBeGreaterThan(THUMB_WIDTH);
    expect(THUMB_QUALITY).toBeGreaterThan(0);
    expect(THUMB_QUALITY).toBeLessThanOrEqual(100);
    expect(MID_QUALITY).toBeGreaterThan(0);
    expect(MID_QUALITY).toBeLessThanOrEqual(100);
  });

  it("matches the pre-existing client values", () => {
    expect(THUMB_WIDTH).toBe(240);
    expect(THUMB_QUALITY).toBe(70);
    expect(MID_WIDTH).toBe(1200);
    expect(MID_QUALITY).toBe(85);
  });
});
