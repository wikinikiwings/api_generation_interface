// Browser-local <-> UTC "HH:MM" conversion + a short tz label, using native
// Date. Mirrors C:\dev\runpod_manager's utcTimeToLocal/localTimeToUtc/getTzLabel.
// Pure; safe on server or client (uses the runtime's local timezone).

const HHMM = /^(\d{1,2}):(\d{1,2})$/;

export function utcTimeToLocal(hhmmUtc: string): string {
  const m = HHMM.exec(hhmmUtc);
  if (!m) return hhmmUtc;
  const d = new Date();
  d.setUTCHours(Number(m[1]), Number(m[2]), 0, 0);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function localTimeToUtc(hhmmLocal: string): string {
  const m = HHMM.exec(hhmmLocal);
  if (!m) return hhmmLocal;
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function tzLabel(): string {
  const off = -new Date().getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const h = Math.floor(abs / 60);
  const mm = abs % 60;
  return `UTC${sign}${h}${mm ? ":" + String(mm).padStart(2, "0") : ""}`;
}
