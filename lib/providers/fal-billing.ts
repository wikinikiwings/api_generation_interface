// Server-only. fal.ai PLATFORM billing — account credit balance.
//
// Distinct from lib/providers/fal.ts (inference on fal.run): this hits
// api.fal.ai and uses an admin-scoped key (FAL_ADMIN_KEY), NEVER the
// inference FAL_KEY. The key is never returned to the caller or logged.

const BILLING_URL = "https://api.fal.ai/v1/account/billing?expand=credits";

export type FalBalanceResult =
  | { status: "ok"; balance: number; currency: string; username: string }
  | { status: "not_configured" }
  | { status: "forbidden" }
  | { status: "error"; message: string };

function getAdminKey(): string | null {
  const k = process.env.FAL_ADMIN_KEY;
  // Treat the .env.example placeholder as unconfigured — an unedited example
  // file must not be sent to the billing API.
  if (!k || k === "your-fal-admin-key-here") return null;
  return k;
}

export async function getFalBalance(): Promise<FalBalanceResult> {
  const key = getAdminKey();
  if (!key) return { status: "not_configured" };

  let res: Response;
  try {
    res = await fetch(BILLING_URL, {
      method: "GET",
      headers: { Authorization: `Key ${key}` },
      cache: "no-store",
    });
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "network error" };
  }

  if (res.status === 401 || res.status === 403) return { status: "forbidden" };

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { status: "error", message: text || `HTTP ${res.status}` };
  }

  let body: { username?: unknown; credits?: { current_balance?: unknown; currency?: unknown } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { status: "error", message: "invalid JSON from fal billing API" };
  }

  const bal = body.credits?.current_balance;
  const cur = body.credits?.currency;
  const username = body.username;
  if (typeof bal !== "number" || typeof cur !== "string" || typeof username !== "string") {
    return { status: "error", message: "unexpected billing response shape" };
  }
  return { status: "ok", balance: bal, currency: cur, username };
}
