"use client";
import * as React from "react";
import { toast } from "sonner";

interface AdminUser {
  id: number;
  email: string;
  name: string | null;
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
          {users.map((u) => (
            <React.Fragment key={u.id}>
              <tr
                className={`border-t cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900/40 ${u.status === "deleted" ? "opacity-50" : ""}`}
                onClick={() => setExpandedId(expandedId === u.id ? null : u.id)}
              >
                <td className="py-2">{u.email}</td>
                <td>{u.name ?? "—"}</td>
                <td>{u.role}</td>
                <td>{u.status}</td>
                <td>{u.last_login_at ?? "—"}</td>
                <td>{u.gens_this_month}</td>
                <td className="text-right space-x-2" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => patch(u.id, { role: u.role === "admin" ? "user" : "admin" })} className="text-blue-600">
                    {u.role === "admin" ? "→ user" : "→ admin"}
                  </button>
                  {u.status === "active" && (
                    <button onClick={() => patch(u.id, { status: "banned" })} className="text-orange-600">Бан</button>
                  )}
                  {u.status === "banned" && (
                    <button onClick={() => patch(u.id, { status: "active" })} className="text-green-600">Разбан</button>
                  )}
                  {u.status === "deleted" ? (
                    <button onClick={() => patch(u.id, { status: "active" })} className="text-green-600">Восстановить</button>
                  ) : (
                    <button onClick={() => confirm(`Удалить ${u.email}?`) && patch(u.id, { status: "deleted" })} className="text-red-600">
                      Удалить
                    </button>
                  )}
                </td>
              </tr>
              {expandedId === u.id && (
                <tr className="bg-zinc-50 dark:bg-zinc-900/40">
                  <td colSpan={7} className="p-3">
                    <UserQuotas userId={u.id} />
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
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
  return (
    <table className="w-full text-xs">
      <thead className="text-zinc-500"><tr>
        <th className="text-left">Модель</th>
        <th>Лимит</th><th>Источник</th><th>Использовано</th><th></th>
      </tr></thead>
      <tbody>
        {rows.map((r) => <QuotaRowEditor key={r.model_id} row={r} onSave={setOverride} onClear={clearOverride} />)}
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

  return (
    <tr className="border-t">
      <td className="py-1">{row.display_name}</td>
      <td>{editing
        ? <span className="space-x-1">
            <input type="number" value={val} disabled={unlimited} onChange={(e) => setVal(e.target.value)}
              className="border rounded px-2 py-0.5 w-20" />
            <label className="text-xs"><input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} /> ∞</label>
          </span>
        : row.applicable_limit === null ? "∞" : row.applicable_limit}
      </td>
      <td>{row.source}</td>
      <td>{row.usage_this_month}</td>
      <td className="text-right space-x-1">
        {editing ? (
          <>
            <button onClick={() => { onSave(row.model_id, unlimited ? null : Number(val)); setEditing(false); }} className="text-blue-600">Сохранить</button>
            <button onClick={() => setEditing(false)} className="text-zinc-500">Отмена</button>
          </>
        ) : (
          <>
            <button onClick={() => setEditing(true)} className="text-blue-600">[edit]</button>
            {row.has_override && (
              <button onClick={() => onClear(row.model_id)} className="text-orange-600">сброс default</button>
            )}
          </>
        )}
      </td>
    </tr>
  );
}
