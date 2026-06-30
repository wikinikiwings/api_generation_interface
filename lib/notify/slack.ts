// Server-only. Posts a plain-text message to a given Slack incoming webhook
// URL. Falsy url → no-op. Never throws. (Callers resolve which url(s) to use.)

export async function sendSlackAlert(text: string, url: string): Promise<boolean> {
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ text }),
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}
