"use client";

import * as React from "react";
import { Plus, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { utcTimeToLocal, localTimeToUtc, tzLabel } from "@/lib/time/tz";

export function FalBalanceAlertConfig() {
  const [threshold, setThreshold] = React.useState<string>("");
  const [localTimes, setLocalTimes] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/admin/balance-config", { cache: "no-store" });
        if (!r.ok) return;
        const d = (await r.json()) as { threshold: number | null; checkTimesUtc: string[] };
        if (cancelled) return;
        setThreshold(d.threshold === null ? "" : String(d.threshold));
        setLocalTimes(d.checkTimesUtc.map(utcTimeToLocal));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const addRow = () => setLocalTimes((t) => [...t, "09:00"]);
  const removeRow = (i: number) => setLocalTimes((t) => t.filter((_, idx) => idx !== i));
  const setRow = (i: number, v: string) =>
    setLocalTimes((t) => t.map((x, idx) => (idx === i ? v : x)));

  const save = async () => {
    setSaving(true);
    try {
      const thr = threshold.trim() === "" ? null : Number(threshold);
      const checkTimesUtc = localTimes.filter(Boolean).map(localTimeToUtc);
      const r = await fetch("/api/admin/balance-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threshold: thr, checkTimesUtc }),
      });
      if (r.ok) toast.success("Настройки оповещения сохранены");
      else {
        const b = await r.json().catch(() => ({}));
        toast.error(`Ошибка: ${b?.error ?? r.status}`);
      }
    } catch {
      toast.error("Сетевая ошибка при сохранении");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-background shadow-sm">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-base font-semibold">Оповещение о низком балансе</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Slack-уведомление, когда баланс ниже порога. Проверки идут в заданные
          времена ({tzLabel()}). Пусто = выключено.
        </p>
      </div>
      <div className="p-5">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Загрузка...
          </div>
        ) : (
          <div className="space-y-4">
            <label className="block text-sm">
              <span className="text-muted-foreground">Порог (USD)</span>
              <input
                type="number"
                min={0}
                step="0.01"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                placeholder="напр. 10"
                className="mt-1 block w-40 rounded-md border border-border bg-background px-2 py-1 text-sm"
              />
            </label>

            <div className="space-y-2">
              <span className="text-sm text-muted-foreground">Времена проверок ({tzLabel()})</span>
              {localTimes.map((t, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="time"
                    value={t}
                    onChange={(e) => setRow(i, e.target.value)}
                    className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    aria-label="Удалить время"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addRow}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60"
              >
                <Plus className="h-3.5 w-3.5" /> Добавить время
              </button>
            </div>

            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Сохранить
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
