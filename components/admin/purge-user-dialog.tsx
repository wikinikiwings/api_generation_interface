"use client";

import * as React from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle } from "lucide-react";

interface PurgeUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: { id: number; email: string; gens_this_month: number } | null;
  onPurged: () => void;
}

export function PurgeUserDialog({ open, onOpenChange, user, onPurged }: PurgeUserDialogProps) {
  const [typed, setTyped] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  // Reset on open/close.
  React.useEffect(() => {
    if (!open) { setTyped(""); setSubmitting(false); }
  }, [open]);

  if (!user) return null;

  const matches = typed.trim().toLowerCase() === user.email.toLowerCase();

  async function confirm() {
    if (!matches || submitting || !user) return;
    setSubmitting(true);
    try {
      const r = await fetch(`/api/admin/users/${user.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation_email: typed.trim() }),
      });
      const json = await r.json().catch(() => ({}));
      if (r.ok) {
        if (json.warning === "rename_failed") {
          toast.warning(
            `Пользователь стёрт. Папка не переименована — переименуйте вручную: ${user.email}/ → ${json.intended_target ?? "deleted_*"}/`,
            { duration: 10_000 }
          );
        } else {
          toast.success("Пользователь стёрт навсегда");
        }
        onPurged();
        onOpenChange(false);
        return;
      }
      // Error mapping
      const errMap: Record<string, string> = {
        confirmation_mismatch: "Email не совпадает",
        must_be_soft_deleted_first: "Сначала переведите в статус «удалён»",
        self_purge_forbidden: "Нельзя стереть самого себя",
        not_found: "Пользователь не найден",
        summary_write_failed: "Не удалось записать сводку (диск/доступ); БД не тронута",
        db_delete_failed: "Сбой удаления из БД (rollback)",
      };
      toast.error(errMap[json.error] ?? `Ошибка: ${json.error ?? r.status}`);
    } catch (err) {
      console.error("[purge dialog]", err);
      toast.error("Сетевая ошибка");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-background border border-border rounded-lg p-5 shadow-xl">
        <DialogTitle className="flex items-center gap-2 text-red-600">
          <AlertTriangle className="h-5 w-5" />
          Стереть пользователя навсегда
        </DialogTitle>

        <div className="space-y-3 text-sm">
          <p>
            Это действие <span className="font-semibold">необратимо</span>.
            Из базы будут удалены: пользователь <span className="font-mono">{user.email}</span>,
            все его генерации (за этот месяц: {user.gens_this_month}), оверрайды квот, сессии,
            настройки.
          </p>
          <p>
            Папка <span className="font-mono">{user.email}/</span> на диске будет переименована
            в <span className="font-mono">deleted_{user.email}/</span> (или
            <span className="font-mono"> deleted_2_{user.email}/</span>, если первая занята).
            Внутри останется CSV-сводка по моделям и месяцам.
          </p>
          <label className="block">
            <span className="block text-xs text-zinc-500 mb-1">
              Для подтверждения введите email пользователя:
            </span>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
              className="w-full border rounded px-2 py-1 bg-background text-foreground"
              placeholder={user.email}
              disabled={submitting}
            />
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="px-3 py-1.5 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-900"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={!matches || submitting}
            className="px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? "Стираем…" : "Стереть навсегда"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
