// Server-only. Posts a plain-text message to the configured Slack incoming
// webhook. Webhook unset → no-op (alerting disabled). Never throws.

export async function sendSlackAlert(text: string): Promise<boolean> {
  const url = process.env.FAL_BALANCE_SLACK_WEBHOOK;
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
