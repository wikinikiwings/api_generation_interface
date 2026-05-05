"use client";
import * as React from "react";
import { toast } from "sonner";
import { ChevronRight, ChevronDown } from "lucide-react";
import { sortByPickerOrder } from "@/lib/providers/models";

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
                <td className="py-2">{u.email}</td>
                <td>{u.name ?? "—"}</td>
                <td>{u.role}</td>
                <td>{u.status}</td>
                <td>{u.last_login_at ?? "—"}</td>
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

  async function setOverride(model_id: string, monthly_limit: number | null) {
    const r = await fetch(`/api/admin/users/${userId}/quotas/${model_id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ monthly_limit }),
    });
    if (r.ok) { toast.success("Сохранено"); void refetch(); } else toast.error("Ошибка");
  }
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
          <th className="py-1.5 px-3 text-right font-medium">Использовано</th>
          <th className="py-1.5 pl-3"></th>
        </tr>
      </thead>
      <tbody>
        {sortedRows.map((r) => <QuotaRowEditor key={r.model_id} row={r} onSave={setOverride} onClear={clearOverride} />)}
      </tbody>
    </table>
  );
}

function QuotaRowEditor({ row, onSave, onClear }: {
  row: QuotaRow;
  onSave: (model_id: string, monthly_limit: number | null) => void;
  onClear: (model_id: string) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [val, setVal] = React.useState<string>(row.applicable_limit?.toString() ?? "");
  const [unlimited, setUnlimited] = React.useState(row.applicable_limit === null);

  const isOverride = row.source === "override";

  return (
    <tr className="border-t border-zinc-100 dark:border-zinc-900 hover:bg-zinc-100/40 dark:hover:bg-zinc-900/40">
      <td className="py-1.5 pr-3">{row.display_name}</td>
      <td className="py-1.5 px-3 text-right tabular-nums">
        {editing ? (
          <span className="inline-flex items-center justify-end gap-2">
            <input
              type="number"
              value={val}
              disabled={unlimited}
              onChange={(e) => setVal(e.target.value)}
              className="border rounded px-2 py-0.5 w-20 text-right tabular-nums disabled:opacity-40"
            />
            <label className="inline-flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={unlimited}
                onChange={(e) => setUnlimited(e.target.checked)}
              />
              <span>∞</span>
            </label>
          </span>
        ) : row.applicable_limit === null ? (
          "∞"
        ) : (
          row.applicable_limit
        )}
      </td>
      <td className="py-1.5 px-3 text-center">
        <span
          className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${
            isOverride
              ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
              : "text-zinc-400 dark:text-zinc-500"
          }`}
        >
          {isOverride ? "override" : "default"}
        </span>
      </td>
      <td className="py-1.5 px-3 text-right tabular-nums">{row.usage_this_month}</td>
      <td className="py-1.5 pl-3 text-right space-x-2 whitespace-nowrap">
        {editing ? (
          <>
            <button
              onClick={() => { onSave(row.model_id, unlimited ? null : Number(val)); setEditing(false); }}
              className="text-blue-600 hover:underline"
            >
              Сохранить
            </button>
            <button
              onClick={() => setEditing(false)}
              className="text-zinc-500 hover:underline"
            >
              Отмена
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => setEditing(true)}
              className="text-blue-600 hover:underline"
            >
              изменить
            </button>
            {row.has_override && (
              <button
                onClick={() => onClear(row.model_id)}
                className="text-orange-600 hover:underline"
              >
                сброс
              </button>
            )}
          </>
        )}
      </td>
    </tr>
  );
}
