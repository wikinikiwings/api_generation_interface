"use client";
import * as React from "react";
import { toast } from "sonner";

interface AdminModel {
  model_id: string;
  display_name: string;
  default_monthly_limit: number | null;
  is_active: 0 | 1;
  total_generations: number;
}

export function ModelsTab() {
  const [models, setModels] = React.useState<AdminModel[]>([]);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [val, setVal] = React.useState<string>("");
  const [unlimited, setUnlimited] = React.useState(false);

  const refetch = React.useCallback(async () => {
    const r = await fetch("/api/admin/models", { cache: "no-store" });
    if (r.ok) setModels(await r.json());
  }, []);
  React.useEffect(() => { void refetch(); }, [refetch]);

  async function patch(model_id: string, body: Partial<{ default_monthly_limit: number | null; is_active: 0 | 1 }>) {
    const r = await fetch(`/api/admin/models/${model_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) { toast.success("Сохранено"); void refetch(); } else toast.error("Ошибка");
  }

  function startEdit(m: AdminModel) {
    setEditing(m.model_id);
    setVal(m.default_monthly_limit?.toString() ?? "");
    setUnlimited(m.default_monthly_limit === null);
  }

  return (
    <table className="w-full text-sm">
      <thead className="text-left text-zinc-500"><tr>
        <th className="py-2">Модель</th>
        <th>Default monthly limit</th>
        <th>Активна</th>
        <th>Всего генераций</th>
        <th></th>
      </tr></thead>
      <tbody>
        {models.map((m) => (
          <tr key={m.model_id} className="border-t">
            <td className="py-2">
              <div>{m.display_name}</div>
              <div className="text-xs text-zinc-500">{m.model_id}</div>
            </td>
            <td>
              {editing === m.model_id ? (
                <span className="space-x-1">
                  <input type="number" value={val} disabled={unlimited} onChange={(e) => setVal(e.target.value)}
                    className="border rounded px-2 py-0.5 w-24" />
                  <label className="text-xs"><input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} /> ∞</label>
                </span>
              ) : m.default_monthly_limit === null ? "∞ (unlimited)" : m.default_monthly_limit}
            </td>
            <td>
              <input type="checkbox" checked={m.is_active === 1}
                onChange={(e) => patch(m.model_id, { is_active: e.target.checked ? 1 : 0 })} />
            </td>
            <td>{m.total_generations}</td>
            <td className="text-right space-x-1">
              {editing === m.model_id ? (
                <>
                  <button onClick={() => { patch(m.model_id, { default_monthly_limit: unlimited ? null : Number(val) }); setEditing(null); }} className="text-blue-600">Сохранить</button>
                  <button onClick={() => setEditing(null)} className="text-zinc-500">Отмена</button>
                </>
              ) : (
                <button onClick={() => startEdit(m)} className="text-blue-600">[edit]</button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
