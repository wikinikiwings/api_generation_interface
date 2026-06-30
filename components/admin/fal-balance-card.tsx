"use client";

import * as React from "react";
import { Loader2, RefreshCw } from "lucide-react";

type Balance =
  | { status: "ok"; balance: number; currency: string; username: string }
  | { status: "not_configured" }
  | { status: "forbidden" }
  | { status: "error"; message: string };

export function FalBalanceCard() {
  const [data, setData] = React.useState<Balance | null>(null);
  const [loading, setLoading] = React.useState(true);

  const refetch = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/fal-balance", { cache: "no-store" });
      if (!r.ok) {
        setData({ status: "error", message: `HTTP ${r.status}` });
        return;
      }
      setData((await r.json()) as Balance);
    } catch {
      setData({ status: "error", message: "network error" });
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refetch();
  }, [refetch]);

  return (
    <section className="rounded-xl border border-border bg-background shadow-sm">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div>
          <h2 className="text-base font-semibold">Баланс fal.ai</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Кредиты аккаунта fal.ai (читается admin-ключом FAL_ADMIN_KEY).
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={loading}
          aria-label="Обновить баланс"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      <div className="p-5">
        {loading && data === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Загрузка...
          </div>
        ) : data?.status === "ok" ? (
          <div>
            <div className="text-2xl font-semibold">
              {data.balance.toFixed(2)} {data.currency}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">{data.username}</div>
          </div>
        ) : data?.status === "not_configured" ? (
          <div className="text-sm text-amber-600 dark:text-amber-500">
            FAL_ADMIN_KEY не задан — добавь admin-ключ fal.ai в{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">.env.local</code> и
            перезапусти контейнер.
          </div>
        ) : data?.status === "forbidden" ? (
          <div className="text-sm text-amber-600 dark:text-amber-500">
            Ключ без прав на биллинг — нужен admin-scoped ключ fal.ai.
          </div>
        ) : (
          <div className="text-sm text-destructive">
            Ошибка: {data?.status === "error" ? data.message : "unknown"}
          </div>
        )}
      </div>
    </section>
  );
}
