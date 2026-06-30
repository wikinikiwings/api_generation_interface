"use client";

import * as React from "react";
import { Plus, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { utcTimeToLocal, localTimeToUtc, tzLabel } from "@/lib/time/tz";

interface MaskedWebhook { id: string; label: string; urlMask: string }

export function FalBalanceAlertConfig() {
  const [threshold, setThreshold] = React.useState<string>("");
  const [localTimes, setLocalTimes] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  const [webhooks, setWebhooks] = React.useState<MaskedWebhook[]>([]);
  const [newLabel, setNewLabel] = React.useState("");
  const [newUrl, setNewUrl] = React.useState("");
  const [adding, setAdding] = React.useState(false);

  const loadWebhooks = React.useCallback(async () => {
    const r = await fetch("/api/admin/balance-webhooks", { cache: "no-store" });
    if (!r.ok) return;
    const d = (await r.json()) as { webhooks: MaskedWebhook[] };
    setWebhooks(d.webhooks);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/admin/balance-config", { cache: "no-store" });
        if (r.ok) {
          const d = (await r.json()) as { threshold: number | null; checkTimesUtc: string[] };
          if (!cancelled) {
            setThreshold(d.threshold === null ? "" : String(d.threshold));
            setLocalTimes(d.checkTimesUtc.map(utcTimeToLocal));
          }
        }
        await loadWebhooks();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadWebhooks]);

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

  const addWebhook = async () => {
    setAdding(true);
    try {
      const r = await fetch("/api/admin/balance-webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: newLabel.trim(), url: newUrl.trim() }),
      });
      if (r.ok) {
        setNewLabel("");
        setNewUrl("");
        await loadWebhooks();
        toast.success("Получатель добавлен");
      } else {
        const b = await r.json().catch(() => ({}));
        toast.error(`Ошибка: ${b?.error ?? r.status}`);
      }
    } catch {
      toast.error("Сетевая ошибка при добавлении");
    } finally {
      setAdding(false);
    }
  };

  const deleteWebhook = async (id: string) => {
    try {
      const r = await fetch("/api/admin/balance-webhooks", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (r.ok) await loadWebhooks();
      else toast.error("Не удалось удалить получателя");
    } catch {
      toast.error("Сетевая ошибка при удалении");
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

            <div className="space-y-2 border-t border-border pt-4">
              <span className="text-sm text-muted-foreground">
                Получатели уведомления (Slack, по одному на человека)
              </span>
              {webhooks.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Пока нет получателей — используется webhook из .env (если задан).
                </p>
              ) : (
                webhooks.map((w) => (
                  <div key={w.id} className="flex items-center gap-2 text-sm">
                    <span className="font-medium">{w.label}</span>
                    <span className="text-xs text-muted-foreground">{w.urlMask}</span>
                    <button
                      type="button"
                      onClick={() => void deleteWebhook(w.id)}
                      aria-label="Удалить получателя"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))
              )}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <input
                  type="text"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="Имя"
                  className="w-32 rounded-md border border-border bg-background px-2 py-1 text-sm"
                />
                <input
                  type="text"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  placeholder="https://hooks.slack.com/services/..."
                  className="w-72 rounded-md border border-border bg-background px-2 py-1 text-sm"
                />
                <button
                  type="button"
                  onClick={() => void addWebhook()}
                  disabled={adding || !newLabel.trim() || !newUrl.trim()}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60 disabled:opacity-50"
                >
                  {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  Добавить
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
