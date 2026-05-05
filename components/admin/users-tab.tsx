"use client";
import * as React from "react";
import { toast } from "sonner";
import { ChevronRight, ChevronDown, Check, Loader2, Undo2 } from "lucide-react";
import { sortByPickerOrder } from "@/lib/providers/models";
import { formatRelativeTime } from "@/lib/format/relative-time";

interface AdminUser {
  id: number;
  email: string;
  name: string | null;
  picture_url: string | null;
  role: "user" | "admin";
  status: "active" | "banned" | "deleted";
  last_login_at: string | null;
  created_at: string;
  gens_this_month: number;
}

interface QuotaRow {
  model_id: string;
  display_name: string;
  applicable_limit: number | null;
  source: "default" | "override";
  default_limit: number | null;
  override_limit: number | null;
  has_override: boolean;
  usage_this_month: number;
}

type EditorStatus = "synced" | "dirty" | "saving" | "saved";

export function UsersTab() {
  const [users, setUsers] = React.useState<AdminUser[]>([]);
  const [showDeleted, setShowDeleted] = React.useState(false);
  const [newEmail, setNewEmail] = React.useState("");
  const [expandedId, setExpandedId] = React.useState<number | null>(null);

  const refetch = React.useCallback(async () => {
    const r = await fetch(`/api/admin/users${showDeleted ? "?showDeleted=1" : ""}`, { cache: "no-store" });
    if (r.ok) setUsers(await r.json());
  }, [showDeleted]);

  React.useEffect(() => { void refetch(); }, [refetch]);

  // Pull fresh data whenever the admin returns to this tab.
  React.useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === "visible") void refetch();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refetch]);

  // True real-time path: subscribe to the same SSE stream that history
  // sync uses, but listen only for the admin-scoped fan-out. The server
  // fires `admin.user_generated` to every active admin whenever ANY
  // user posts a generation; we simply refetch on receipt so the per-
  // user counters stay live even when the admin window keeps focus
  // (visibilitychange wouldn't fire in that case).
  React.useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource("/api/history/stream");
    const onEvent = () => void refetch();
    es.addEventListener("admin.user_generated", onEvent);
    es.addEventListener("quota_updated", onEvent);
    es.onerror = () => {
      // No watchdog here — the visibilitychange path already covers
      // the recovery case. Just close to free the slot; will reopen
      // on next mount / dependency change.
      es.close();
    };
    return () => es.close();
  }, [refetch]);

  async function addUser() {
    const email = newEmail.trim().toLowerCase();
    if (!email) return;
    const r = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (r.ok) { setNewEmail(""); toast.success("Добавлен"); void refetch(); }
    else if (r.status === 409) toast.error("Уже существует");
    else toast.error("Ошибка");
  }

  async function patch(id: number, body: Partial<{ role: AdminUser["role"]; status: AdminUser["status"] }>) {
    const r = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) { toast.success("Обновлено"); void refetch(); }
    else toast.error("Ошибка");
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2 items-center">
        <input
          type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addUser()}
          placeholder="alice@tapclap.com"
          className="border rounded px-3 py-1.5 flex-1 max-w-sm"
        />
        <button onClick={addUser} className="px-3 py-1.5 rounded bg-blue-600 text-white">+ Добавить</button>
        <label className="ml-auto text-sm flex items-center gap-2">
          <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
          Показать удалённых
        </label>
      </div>

      <table className="w-full text-sm">
        <thead className="text-left text-zinc-500">
          <tr>
            <th className="w-6 py-2"></th>
            <th className="py-2">Email</th>
            <th>Имя</th>
            <th>Роль</th>
            <th>Статус</th>
            <th>Последний вход</th>
            <th>Генераций (мес.)</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const expanded = expandedId === u.id;
            return (
            <React.Fragment key={u.id}>
              <tr
                className={`border-t cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900/40 ${u.status === "deleted" ? "opacity-50" : ""}`}
                onClick={() => {
                  const next = expanded ? null : u.id;
                  setExpandedId(next);
                  // Refresh outer counts at the same moment the inner
                  // UserQuotas remounts and pulls fresh data — keeps
                  // the row header (`Генераций (мес.)`) in sync with
                  // the per-model `Использовано` numbers below it.
                  if (next !== null) void refetch();
                }}
              >
                <td className="py-2 pr-1 text-zinc-400" aria-hidden="true">
                  {expanded
                    ? <ChevronDown className="h-4 w-4" />
                    : <ChevronRight className="h-4 w-4" />}
                </td>
                <td className="py-2">
                  <span className="inline-flex items-center gap-2">
                    <UserAvatar src={u.picture_url} email={u.email} />
                    <span>{u.email}</span>
                  </span>
                </td>
                <td>{u.name ?? "—"}</td>
                <td>{u.role}</td>
                <td>{u.status}</td>
                <td>
                  {u.last_login_at
                    ? <span title={u.last_login_at}>{formatRelativeTime(u.last_login_at)}</span>
                    : "—"}
                </td>
                <td>{u.gens_this_month}</td>
                <td className="text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-zinc-700 px-1.5 py-1">
                    <button
                      onClick={() => patch(u.id, { role: u.role === "admin" ? "user" : "admin" })}
                      className={`rounded px-2 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                        u.role === "admin" ? "text-orange-600" : "text-blue-600"
                      }`}
                    >
                      {u.role === "admin" ? "Снять админку" : "Сделать админом"}
                    </button>
                    {u.status === "active" && (
                      <button
                        onClick={() => patch(u.id, { status: "banned" })}
                        className="rounded px-2 py-0.5 text-orange-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      >
                        Бан
                      </button>
                    )}
                    {u.status === "banned" && (
                      <button
                        onClick={() => patch(u.id, { status: "active" })}
                        className="rounded px-2 py-0.5 text-green-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      >
                        Разбан
                      </button>
                    )}
                    {u.status === "deleted" ? (
                      <button
                        onClick={() => patch(u.id, { status: "active" })}
                        className="rounded px-2 py-0.5 text-green-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      >
                        Восстановить
                      </button>
                    ) : (
                      <button
                        onClick={() => confirm(`Удалить ${u.email}?`) && patch(u.id, { status: "deleted" })}
                        className="rounded px-2 py-0.5 text-red-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      >
                        Удалить
                      </button>
                    )}
                  </div>
                </td>
              </tr>
              {expanded && (
                <tr className="bg-zinc-50 dark:bg-zinc-900/40">
                  <td colSpan={8} className="p-3">
                    <UserQuotas userId={u.id} />
                  </td>
                </tr>
              )}
            </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function UserQuotas({ userId }: { userId: number }) {
  const [rows, setRows] = React.useState<QuotaRow[] | null>(null);
  const refetch = React.useCallback(async () => {
    const r = await fetch(`/api/admin/users/${userId}/quotas`, { cache: "no-store" });
    if (r.ok) setRows(await r.json());
  }, [userId]);
  React.useEffect(() => { void refetch(); }, [refetch]);

  // Cross-tab admin real-time: another admin (or this admin from another
  // tab) saving an override on this user, OR a model default change, OR
  // any user posting a generation that affects usage_this_month — all
  // refetch our rows so values stay live without manual interaction.
  React.useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource("/api/history/stream");
    es.addEventListener("admin.quota_changed", (e) => {
      try {
        const { user_id } = JSON.parse((e as MessageEvent).data) as { user_id: number };
        if (user_id === userId || user_id === 0) void refetch();
      } catch {
        // Malformed payload — defensive ignore.
      }
    });
    es.addEventListener("admin.user_generated", (e) => {
      try {
        const { user_id } = JSON.parse((e as MessageEvent).data) as { user_id: number };
        if (user_id === userId) void refetch();
      } catch {
        // Malformed payload — defensive ignore.
      }
    });
    es.onerror = () => es.close();
    return () => es.close();
  }, [userId, refetch]);

  async function clearOverride(model_id: string) {
    const r = await fetch(`/api/admin/users/${userId}/quotas/${model_id}`, { method: "DELETE" });
    if (r.ok) { toast.success("Сброшено"); void refetch(); } else toast.error("Ошибка");
  }

  if (!rows) return <div className="text-xs">Загрузка…</div>;

  // Match the playground picker order (MODELS_META declaration).
  const sortedRows = sortByPickerOrder(rows, (r) => r.model_id, (r) => r.display_name);

  return (
    <table className="w-full text-xs">
      <thead className="text-zinc-500">
        <tr className="border-b border-zinc-200 dark:border-zinc-800">
          <th className="py-1.5 pr-3 text-left font-medium">Модель</th>
          <th className="py-1.5 px-3 text-right font-medium">Лимит</th>
          <th className="py-1.5 px-3 text-center font-medium">Источник</th>
          <th className="py-1.5 pl-3 text-right font-medium">Использовано</th>
        </tr>
      </thead>
      <tbody>
        {sortedRows.map((r) => <QuotaRowEditor key={r.model_id} row={r} userId={userId} onClear={clearOverride} />)}
      </tbody>
    </table>
  );
}

function QuotaRowEditor({ row, userId, onClear }: {
  row: QuotaRow;
  userId: number;
  onClear: (model_id: string) => void;
}) {
  const [val, setVal] = React.useState<string>(row.applicable_limit?.toString() ?? "");
  const [unlimited, setUnlimited] = React.useState(row.applicable_limit === null);
  const [status, setStatus] = React.useState<EditorStatus>("synced");
  const savedTimerRef = React.useRef<number | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  // Re-sync from props when the row changes (e.g. SSE-driven refetch),
  // but never stomp an in-progress edit.
  React.useEffect(() => {
    if (status === "dirty" || status === "saving") return;
    setVal(row.applicable_limit?.toString() ?? "");
    setUnlimited(row.applicable_limit === null);
  }, [row.applicable_limit, status]);

  React.useEffect(() => () => {
    if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
  }, []);

  function flashSaved() {
    setStatus("saved");
    if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
    savedTimerRef.current = window.setTimeout(() => setStatus("synced"), 1500);
  }

  async function commit(nextUnlim: boolean, nextRaw: string) {
    // Empty input + not unlimited = no actionable value. Snap back.
    if (!nextUnlim && nextRaw.trim() === "") {
      setVal(row.applicable_limit?.toString() ?? "");
      setUnlimited(row.applicable_limit === null);
      setStatus("synced");
      return;
    }
    const next = nextUnlim ? null : Number(nextRaw);
    // Skip PUT only when the override row already has this exact value —
    // an admin who types the default value into a row WITHOUT an override
    // is making the explicit gesture "I want an override" and we honor it.
    if (row.has_override && next === row.applicable_limit) {
      setStatus("synced");
      return;
    }
    setStatus("saving");
    try {
      const r = await fetch(`/api/admin/users/${userId}/quotas/${row.model_id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthly_limit: next }),
      });
      if (r.ok) flashSaved();
      else throw new Error("save failed");
    } catch {
      toast.error("Ошибка сохранения квоты");
      setStatus("dirty");
    }
  }

  return (
    <tr className="border-t border-zinc-100 dark:border-zinc-900 hover:bg-zinc-100/40 dark:hover:bg-zinc-900/40">
      <td className="py-1.5 pr-3">{row.display_name}</td>
      <td className="py-1.5 px-3 text-right">
        <span className="inline-flex items-center justify-end gap-2">
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
                  void commit(true, val);
                } else {
                  setStatus("dirty");
                  window.requestAnimationFrame(() => inputRef.current?.focus());
                }
              }}
            />
            <span>∞</span>
          </label>
          {/* Fixed slot so the row width never shifts when ↺ appears/disappears
              (override toggled via save or refetch). */}
          <span className="inline-flex h-5 w-5 items-center justify-center">
            {row.has_override && (
              <button
                type="button"
                onClick={() => onClear(row.model_id)}
                disabled={status === "saving"}
                title="Сбросить override → default"
                className="rounded p-0.5 text-zinc-400 hover:text-orange-600 disabled:opacity-30"
              >
                <Undo2 className="h-3.5 w-3.5" />
              </button>
            )}
          </span>
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
      </td>
      <td className="py-1.5 px-3 text-center">
        <span
          className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${
            row.source === "override"
              ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
              : "text-zinc-400 dark:text-zinc-500"
          }`}
        >
          {row.source}
        </span>
      </td>
      <td className="py-1.5 pl-3 text-right tabular-nums">{row.usage_this_month}</td>
    </tr>
  );
}

function UserAvatar({ src, email, size = 24 }: {
  src: string | null;
  email: string;
  size?: number;
}) {
  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        className="rounded-full shrink-0"
      />
    );
  }
  return (
    <span
      style={{ width: size, height: size }}
      className="rounded-full bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 inline-flex items-center justify-center text-xs font-medium shrink-0"
    >
      {email[0]?.toUpperCase() ?? "?"}
    </span>
  );
}
