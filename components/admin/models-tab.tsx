"use client";
import * as React from "react";
import { toast } from "sonner";
import { Check, Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import { sortByPickerOrder } from "@/lib/providers/models";

interface AdminModel {
  model_id: string;
  display_name: string;
  default_monthly_limit: number | null;
  is_active: 0 | 1;
  total_generations: number;
}

type EditorStatus = "synced" | "dirty" | "saving" | "saved";

type DateFilter = { from: string | null; to: string | null };

const MONTHS_RU = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
] as const;

function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function detectExactMonth(filter: DateFilter): boolean {
  if (!filter.from || !filter.to) return false;
  const f = new Date(filter.from);
  const t = new Date(filter.to);
  if (f.getUTCFullYear() !== t.getUTCFullYear()) return false;
  if (f.getUTCMonth() !== t.getUTCMonth()) return false;
  if (f.getUTCDate() !== 1) return false;
  const lastDay = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return t.getUTCDate() === lastDay;
}

function captionForFilter(filter: DateFilter): string {
  if (!filter.from && !filter.to) return "за всё время";
  if (detectExactMonth(filter)) {
    const f = new Date(filter.from!);
    return `за ${MONTHS_RU[f.getUTCMonth()].toLowerCase()} ${f.getUTCFullYear()}`;
  }
  return `с ${filter.from ?? "…"} по ${filter.to ?? "…"}`;
}

export function ModelsTab() {
  const [models, setModels] = React.useState<AdminModel[]>([]);
  const [filter, setFilter] = React.useState<DateFilter>({ from: null, to: null });

  const refetch = React.useCallback(async () => {
    const qs = new URLSearchParams();
    if (filter.from) qs.set("from", filter.from);
    if (filter.to) qs.set("to", filter.to);
    const url = qs.toString() ? `/api/admin/models?${qs}` : "/api/admin/models";
    const r = await fetch(url, { cache: "no-store" });
    if (r.ok) setModels(await r.json());
  }, [filter.from, filter.to]);
  React.useEffect(() => { void refetch(); }, [refetch]);

  // Pull fresh counts whenever the admin returns to the tab.
  React.useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === "visible") void refetch();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refetch]);

  // Real-time path: same `admin.user_generated` fan-out the Users tab
  // listens to. Refetch whenever any user successfully creates a
  // generation so the per-model `Всего генераций` stays live without
  // requiring focus loss.
  React.useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource("/api/history/stream");
    const onEvent = () => void refetch();
    es.addEventListener("admin.user_generated", onEvent);
    es.onerror = () => es.close();
    return () => es.close();
  }, [refetch]);

  async function patchActive(model_id: string, is_active: 0 | 1) {
    const r = await fetch(`/api/admin/models/${model_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active }),
    });
    if (r.ok) { toast.success("Сохранено"); void refetch(); }
    else toast.error("Ошибка");
  }

  // Silent saver: the per-row LimitEditor reports status visually, so we
  // don't fire a toast on success — only on failure (where toast doubles
  // as an explanation for why the dirty dot didn't clear).
  const saveLimit = React.useCallback(
    async (model_id: string, limit: number | null): Promise<boolean> => {
      const r = await fetch(`/api/admin/models/${model_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default_monthly_limit: limit }),
      });
      if (!r.ok) {
        toast.error("Ошибка сохранения лимита");
        return false;
      }
      void refetch();
      return true;
    },
    [refetch]
  );

  return (
    <div className="space-y-3">
      <DateRangeFilter value={filter} onChange={setFilter} />
      <table className="w-full text-sm">
      <thead className="text-zinc-500">
        <tr className="border-b border-zinc-200 dark:border-zinc-800">
          <th className="py-2 pr-3 text-left font-medium">Модель</th>
          <th className="w-56 py-2 px-3 text-center font-medium">Лимит / мес</th>
          <th className="w-20 py-2 px-3 text-center font-medium">Активна</th>
          <th className="py-2 pl-3 text-right font-medium">
            <div>Всего генераций</div>
            <div className="text-[10px] font-normal text-zinc-400 dark:text-zinc-500">
              {captionForFilter(filter)}
            </div>
          </th>
        </tr>
      </thead>
      <tbody>
        {sortByPickerOrder(models, (m) => m.model_id, (m) => m.display_name).map((m) => (
          <tr
            key={m.model_id}
            className="border-t border-zinc-100 dark:border-zinc-900 hover:bg-zinc-100/40 dark:hover:bg-zinc-900/40"
          >
            <td className="py-2 pr-3">
              <div>{m.display_name}</div>
              <div className="text-xs text-zinc-500">{m.model_id}</div>
            </td>
            <td className="py-2 px-3 text-center">
              <LimitEditor
                modelId={m.model_id}
                serverLimit={m.default_monthly_limit}
                onSave={saveLimit}
              />
            </td>
            <td className="py-2 px-3 text-center">
              <input
                type="checkbox"
                checked={m.is_active === 1}
                onChange={(e) => patchActive(m.model_id, e.target.checked ? 1 : 0)}
              />
            </td>
            <td className="py-2 pl-3 text-right tabular-nums">{m.total_generations}</td>
          </tr>
        ))}
      </tbody>
      </table>
    </div>
  );
}

function DateRangeFilter({
  value,
  onChange,
}: {
  value: DateFilter;
  onChange: (next: DateFilter) => void;
}) {
  // Anchor month/year for the stepper + dropdowns. Falls back to "now"
  // when filter is "all time", so the dropdowns aren't blank.
  const anchor = React.useMemo(
    () => (value.from ? new Date(value.from) : new Date()),
    [value.from]
  );
  const anchorYear = anchor.getUTCFullYear();
  const anchorMonth = anchor.getUTCMonth();
  const isAllTime = !value.from && !value.to;
  const isExactMonth = detectExactMonth(value);
  // "Этот месяц" wins over the stepper highlight when the chosen
  // exact month happens to BE the current calendar month — keeps the
  // active-state cue mutually exclusive across all four control groups.
  const isThisMonth =
    isExactMonth &&
    (() => {
      const f = new Date(value.from!);
      const now = new Date();
      return (
        f.getUTCFullYear() === now.getUTCFullYear() &&
        f.getUTCMonth() === now.getUTCMonth()
      );
    })();
  const isExactMonthOther = isExactMonth && !isThisMonth;
  // Anything that's not "all time" or a clean calendar month is a
  // free-form range — that's where the От/До inputs are the source.
  const isCustomRange = !isAllTime && !isExactMonth;

  // Tailwind helper: blue bg + border for the active filter group,
  // muted border otherwise. Gives a single visible "this is the active
  // mode" cue at any moment.
  const groupClass = (active: boolean) =>
    `inline-flex items-center gap-1 rounded-lg border px-1 py-0.5 transition-colors ${
      active
        ? "border-blue-300 bg-blue-50 dark:border-blue-700 dark:bg-blue-950/40"
        : "border-zinc-200 dark:border-zinc-700"
    }`;

  const currentYear = new Date().getUTCFullYear();
  const years = React.useMemo(() => {
    // Recent four years + always include the currently-anchored year
    // (in case from/to point further back than the default window).
    const set = new Set<number>();
    for (let y = currentYear; y >= currentYear - 3; y--) set.add(y);
    set.add(anchorYear);
    return Array.from(set).sort((a, b) => b - a);
  }, [currentYear, anchorYear]);

  function applyMonth(year: number, month: number) {
    // Date.UTC handles overflow for month (-1 → prev year Dec, 12 → next year Jan).
    const from = new Date(Date.UTC(year, month, 1));
    const to = new Date(Date.UTC(year, month + 1, 0)); // last day of month
    onChange({ from: ymd(from), to: ymd(to) });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <button
        onClick={() => onChange({ from: null, to: null })}
        className={`rounded px-2.5 py-1 text-xs font-medium ${
          isAllTime
            ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
            : "border border-zinc-200 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        }`}
      >
        Всё время
      </button>

      <button
        onClick={() => {
          const now = new Date();
          applyMonth(now.getUTCFullYear(), now.getUTCMonth());
        }}
        className={`rounded px-2.5 py-1 text-xs font-medium ${
          isThisMonth
            ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
            : "border border-zinc-200 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        }`}
      >
        Этот месяц
      </button>

      <div className={groupClass(isExactMonthOther)}>
        <button
          onClick={() => applyMonth(anchorYear, anchorMonth - 1)}
          className="rounded p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          title="Предыдущий месяц"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <select
          value={anchorYear}
          onChange={(e) => applyMonth(parseInt(e.target.value, 10), anchorMonth)}
          className="rounded bg-background px-1.5 py-0.5 text-xs text-foreground"
        >
          {years.map((y) => (
            <option key={y} value={y} className="bg-background text-foreground">
              {y}
            </option>
          ))}
        </select>
        <select
          value={anchorMonth}
          onChange={(e) => applyMonth(anchorYear, parseInt(e.target.value, 10))}
          className="rounded bg-background px-1.5 py-0.5 text-xs text-foreground"
        >
          {MONTHS_RU.map((name, i) => (
            <option key={i} value={i} className="bg-background text-foreground">
              {name}
            </option>
          ))}
        </select>
        <button
          onClick={() => applyMonth(anchorYear, anchorMonth + 1)}
          className="rounded p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          title="Следующий месяц"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className={`${groupClass(isCustomRange)} text-xs`}>
        <span className="px-1 text-zinc-500">От</span>
        <input
          type="date"
          value={value.from ?? ""}
          // Native date picker respects max — UI prevents picking
          // a "from" later than the current "to". Direct typing is
          // additionally guarded in onChange below.
          max={value.to ?? undefined}
          onChange={(e) => {
            const next = { ...value, from: e.target.value || null };
            if (next.from && next.to && next.from > next.to) return;
            onChange(next);
          }}
          className="rounded bg-background px-1.5 py-0.5 text-foreground"
        />
        <span className="px-1 text-zinc-500">До</span>
        <input
          type="date"
          value={value.to ?? ""}
          min={value.from ?? undefined}
          onChange={(e) => {
            const next = { ...value, to: e.target.value || null };
            if (next.from && next.to && next.from > next.to) return;
            onChange(next);
          }}
          className="rounded bg-background px-1.5 py-0.5 text-foreground"
        />
      </div>
    </div>
  );
}

function LimitEditor({
  modelId,
  serverLimit,
  onSave,
}: {
  modelId: string;
  serverLimit: number | null;
  onSave: (model_id: string, limit: number | null) => Promise<boolean>;
}) {
  const [val, setVal] = React.useState<string>(serverLimit?.toString() ?? "");
  const [unlimited, setUnlimited] = React.useState(serverLimit === null);
  const [status, setStatus] = React.useState<EditorStatus>("synced");
  const savedTimerRef = React.useRef<number | null>(null);

  // Pull fresh server value into the editor when it changes (after refetch
  // or external update). Don't stomp an in-progress edit — if the user is
  // mid-typing (dirty) or mid-save (saving), keep their input.
  React.useEffect(() => {
    if (status === "dirty" || status === "saving") return;
    setVal(serverLimit?.toString() ?? "");
    setUnlimited(serverLimit === null);
  }, [serverLimit, status]);

  React.useEffect(() => () => {
    if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
  }, []);

  function flashSaved() {
    setStatus("saved");
    if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
    savedTimerRef.current = window.setTimeout(() => setStatus("synced"), 1500);
  }

  async function commit(nextUnlim: boolean, nextRaw: string) {
    // Empty input + not unlimited = no actionable value. Snap back to
    // server state silently rather than saving null (which would flip
    // the model to unlimited unintentionally).
    if (!nextUnlim && nextRaw.trim() === "") {
      setVal(serverLimit?.toString() ?? "");
      setUnlimited(serverLimit === null);
      setStatus("synced");
      return;
    }
    const next = nextUnlim ? null : Number(nextRaw);
    if (next === serverLimit) {
      setStatus("synced");
      return;
    }
    setStatus("saving");
    const ok = await onSave(modelId, next);
    if (ok) flashSaved();
    else setStatus("dirty");
  }

  const inputRef = React.useRef<HTMLInputElement | null>(null);

  return (
    <span className="inline-flex items-center justify-center gap-2">
      <input
        ref={inputRef}
        type="number"
        value={val}
        disabled={unlimited}
        onChange={(e) => { setVal(e.target.value); setStatus("dirty"); }}
        onBlur={() => void commit(unlimited, val)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        }}
        className="w-20 rounded border px-2 py-0.5 text-right tabular-nums disabled:opacity-40"
      />
      <label className="inline-flex items-center gap-1 text-xs">
        <input
          type="checkbox"
          checked={unlimited}
          onChange={(e) => {
            const nextUnlim = e.target.checked;
            setUnlimited(nextUnlim);
            if (nextUnlim) {
              // Going TO unlimited is a discrete commit (no natural blur
              // on a checkbox). Save now.
              void commit(true, val);
            } else {
              // Leaving unlimited — enable the input and wait for the
              // user to type. Committing here with an empty val would
              // hit the empty-snap-back guard and the checkbox would
              // bounce back to checked. Just mark dirty and focus the
              // input so the next keystroke goes there.
              setStatus("dirty");
              window.requestAnimationFrame(() => inputRef.current?.focus());
            }
          }}
        />
        <span>∞</span>
      </label>
      {/* Fixed slot so the row width never shifts as the icon swaps. */}
      <span
        className="inline-flex h-4 w-4 items-center justify-center"
        aria-live="polite"
        aria-label={
          status === "dirty" ? "не сохранено"
            : status === "saving" ? "сохраняем"
            : status === "saved" ? "сохранено"
            : ""
        }
      >
        {status === "saving" && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />}
        {status === "saved" && <Check className="h-3.5 w-3.5 text-green-500" />}
        {status === "dirty" && <span className="h-2 w-2 rounded-full bg-orange-400" />}
      </span>
    </span>
  );
}
