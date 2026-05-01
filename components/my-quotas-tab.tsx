"use client";
import * as React from "react";
import { useQuotas, type Quota } from "@/app/providers/quotas-provider";
import { sortByPickerOrder } from "@/lib/providers/models";

export function MyQuotasTab() {
  // Read from the shared QuotasProvider so optimistic `bumpUsage()` calls
  // from the form (and SSE-driven refetches via BroadcastChannel) reflect
  // here without a remount. The provider already handles initial fetch,
  // visibilitychange refresh, and the BC subscription.
  const { quotas, loading } = useQuotas();

  if (loading && quotas.length === 0) {
    return <div className="p-4 text-sm text-muted">Loading...</div>;
  }

  // Match the playground picker order (MODELS_META declaration). The
  // helper handles fallback for any model_id unknown to the picker.
  const sorted = sortByPickerOrder(quotas, (q) => q.model_id, (q) => q.display_name);

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
