import { describe, it, expect } from "vitest";
import { formatRelativeTime } from "../relative-time";

// Fixed reference "now" so the test is deterministic regardless of run time.
// 2026-05-05T15:00:00Z (a Tuesday).
const NOW = new Date("2026-05-05T15:00:00.000Z");

describe("formatRelativeTime", () => {
  it("returns '—' for null", () => {
    expect(formatRelativeTime(null, NOW)).toBe("—");
  });

  it("returns 'только что' for < 60 seconds ago", () => {
    expect(formatRelativeTime("2026-05-05T14:59:30.000Z", NOW)).toBe("только что");
  });

  it("returns 'N мин назад' for < 60 minutes", () => {
    expect(formatRelativeTime("2026-05-05T14:55:00.000Z", NOW)).toBe("5 мин назад");
    expect(formatRelativeTime("2026-05-05T14:01:00.000Z", NOW)).toBe("59 мин назад");
  });

  it("returns 'N ч назад' for < 24 hours", () => {
    expect(formatRelativeTime("2026-05-05T12:00:00.000Z", NOW)).toBe("3 ч назад");
    expect(formatRelativeTime("2026-05-04T16:00:00.000Z", NOW)).toBe("23 ч назад");
  });

  it("returns 'вчера' when the date is yesterday's calendar day", () => {
    // > 24h ago but on yesterday's local calendar date.
    expect(formatRelativeTime("2026-05-04T10:00:00.000Z", NOW)).toBe("вчера");
  });

  it("returns 'N дн назад' for < 7 days when not yesterday", () => {
    expect(formatRelativeTime("2026-05-02T15:00:00.000Z", NOW)).toBe("3 дн назад");
    expect(formatRelativeTime("2026-04-29T15:00:00.000Z", NOW)).toBe("6 дн назад");
  });

  it("returns 'D MMM' for older dates within the same year", () => {
    expect(formatRelativeTime("2026-04-15T10:00:00.000Z", NOW)).toBe("15 апр");
    expect(formatRelativeTime("2026-01-03T10:00:00.000Z", NOW)).toBe("3 янв");
  });

  it("returns 'D MMM YYYY' for prior years", () => {
    expect(formatRelativeTime("2025-12-31T10:00:00.000Z", NOW)).toBe("31 дек 2025");
    expect(formatRelativeTime("2024-06-01T10:00:00.000Z", NOW)).toBe("1 июн 2024");
  });
});
