const MONTHS_SHORT_RU = [
  "янв", "фев", "мар", "апр", "май", "июн",
  "июл", "авг", "сен", "окт", "ноя", "дек",
] as const;

/**
 * Russian-locale humanized time. Pure function — pass a fixed `now`
 * for deterministic tests. Local timezone is used for the calendar-day
 * boundaries ("вчера", "same year"), matching how the user reads dates.
 */
export function formatRelativeTime(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return "—";
  const then = new Date(iso);
  const diffMs = now.getTime() - then.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "только что";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} мин назад`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} ч назад`;

  // Calendar-day comparisons (local timezone).
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = startOfDay(now);
  const thenDay = startOfDay(then);
  const diffDays = Math.round((today.getTime() - thenDay.getTime()) / (24 * 60 * 60 * 1000));

  if (diffDays === 1) return "вчера";
  if (diffDays < 7) return `${diffDays} дн назад`;

  const day = then.getDate();
  const month = MONTHS_SHORT_RU[then.getMonth()];
  if (then.getFullYear() === now.getFullYear()) return `${day} ${month}`;
  return `${day} ${month} ${then.getFullYear()}`;
}
