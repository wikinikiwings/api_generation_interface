"use client";
import * as React from "react";

export interface Quota {
  model_id: string;
  display_name: string;
  limit: number | null;
  used: number;
  unlimited: boolean;
}

interface Ctx {
  quotas: Quota[];
  loading: boolean;
  refetch: () => Promise<void>;
  bumpUsage: (model_id: string) => void;
  getForModel: (model_id: string) => Quota | undefined;
}

const QuotasContext = React.createContext<Ctx | null>(null);

export function QuotasProvider({ children }: { children: React.ReactNode }) {
  const [quotas, setQuotas] = React.useState<Quota[]>([]);
  const [loading, setLoading] = React.useState(true);

  const refetch = React.useCallback(async () => {
    try {
      const r = await fetch("/api/me/quotas", { cache: "no-store" });
      if (r.ok) setQuotas(await r.json());
    } catch (err) {
      console.warn("[quotas] refetch failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refetch();
    function onVisibility() {
      if (document.visibilityState === "visible") void refetch();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refetch]);

  // Listen for SSE-driven updates broadcast on a BroadcastChannel.
  // The history SSE handler in lib/history/* posts to this channel
  // when it receives `quota_updated` / `user_role_changed` events.
  React.useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel("quotas");
    bc.onmessage = () => { void refetch(); };
    return () => bc.close();
  }, [refetch]);

  const bumpUsage = React.useCallback((model_id: string) => {
    setQuotas((qs) => qs.map((q) => q.model_id === model_id ? { ...q, used: q.used + 1 } : q));
  }, []);

  const getForModel = React.useCallback(
    (model_id: string) => quotas.find((q) => q.model_id === model_id),
    [quotas]
  );

  return (
    <QuotasContext.Provider value={{ quotas, loading, refetch, bumpUsage, getForModel }}>
      {children}
    </QuotasContext.Provider>
  );
}

export function useQuotas(): Ctx {
  const v = React.useContext(QuotasContext);
  if (!v) throw new Error("useQuotas must be used inside QuotasProvider");
  return v;
}
