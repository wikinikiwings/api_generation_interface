import { describe, it, expect } from "vitest";
import { utcTimeToLocal, localTimeToUtc, tzLabel } from "@/lib/time/tz";

describe("tz helpers", () => {
  it("round-trips local↔UTC for valid HH:MM (offset-independent)", () => {
    for (const t of ["00:00", "09:30", "13:00", "23:45"]) {
      expect(localTimeToUtc(utcTimeToLocal(t))).toBe(t);
    }
  });

  it("pads to HH:MM", () => {
    expect(utcTimeToLocal("9:5")).toMatch(/^\d{2}:\d{2}$/);
  });

  it("passes through malformed input unchanged", () => {
    expect(utcTimeToLocal("nope")).toBe("nope");
    expect(localTimeToUtc("")).toBe("");
  });

  it("tzLabel looks like UTC+N / UTC-N[:MM]", () => {
    expect(tzLabel()).toMatch(/^UTC[+-]\d+(:\d{2})?$/);
  });
});
