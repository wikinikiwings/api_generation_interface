"use client";
import * as React from "react";
import { useUser } from "@/app/providers/user-provider";

interface Quota {
  model_id: string; display_name: string;
  limit: number | null; used: number; unlimited: boolean;
}

export function MyQuotasTab() {
  const [data, setData] = React.useState<Quota[] | null>(null);

  const refetch = React.useCallback(async () => {
    const r = await fetch("/api/me/quotas", { cache: "no-store" });
    if (r.ok) setData(await r.json());
  }, []);

  React.useEffect(() => { void refetch(); }, [refetch]);

  // Subscribe to BroadcastChannel("quotas") — SSE quota_updated posts here via lib/history/sse.ts
  React.useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel("quotas");
    bc.onmessage = (ev) => {
      if (ev.data?.type === "quota_updated") void refetch();
    };
    return () => bc.close();
  }, [refetch]);

  if (!data) return <div className="p-4 text-sm text-muted">Loading...</div>;

  const sorted = [...data].sort((a, b) => {
    const aExhausted = !a.unlimited && a.used >= (a.limit ?? 0);
    const bExhausted = !b.unlimited && b.used >= (b.limit ?? 0);
    if (aExhausted !== bExhausted) return aExhausted ? 1 : -1;
    return a.display_name.localeCompare(b.display_name);
  });

  return (
    <div className="flex flex-col gap-2 p-3">
      {sorted.map((q) => <QuotaCard key={q.model_id} q={q} />)}
    </div>
  );
}

function QuotaCard({ q }: { q: Quota }) {
  if (q.unlimited) {
    return (
      <div className="rounded-lg border p-3">
        <div className="text-sm font-medium">{q.display_name}</div>
        <div className="text-xs text-muted-foreground">∞ Без ограничений · использовано в этом месяце: {q.used}</div>
      </div>
    );
  }
  const limit = q.limit ?? 0;
  const pct = limit === 0 ? 100 : Math.min(100, (q.used / limit) * 100);
  const color =
    pct >= 100 ? "bg-red-500" :
    pct >= 80  ? "bg-orange-500" : "bg-green-500";
  return (
    <div className="rounded-lg border p-3">
      <div className="text-sm font-medium">{q.display_name}</div>
      <div className="h-2 bg-zinc-200 dark:bg-zinc-800 rounded-full mt-2 overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-xs text-muted-foreground mt-1">
        {q.used} / {limit}
        {q.used >= limit ? " · Лимит исчерпан" : " · В этом месяце"}
      </div>
    </div>
  );
}
