"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

interface Stats {
  originals_in_db: number;
  variants_on_disk_thumb: number;
  variants_on_disk_mid: number;
  variants_dir: string;
  images_dir: string;
}

interface UserRow {
  user_id: number;
  email: string;
  image_generation_count: number;
}

interface JobState {
  jobId: string;
  scope: "user" | "all";
  total: number;
  done: number;
  errors: Array<{ generationId: number; reason: string; error?: string }>;
  /**
   * Live error count from SSE progress events. The `errors` array above is
   * the detailed list — only populated by the final `done` poll (or future
   * polling). Mid-job, `errorCount` is the authoritative count.
   */
  errorCount: number;
  finished: boolean;
  currentEmail?: string;
}

export function PreviewStateTab() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [scan, setScan] = useState<{ count: number; dirs: string[] } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [purgeConfirm, setPurgeConfirm] = useState("");
  const [purging, setPurging] = useState(false);
  const [orphanScan, setOrphanScan] = useState<{ count: number; files: string[] } | null>(null);
  const [orphanScanning, setOrphanScanning] = useState(false);
  const [orphanConfirm, setOrphanConfirm] = useState("");
  const [orphanPurging, setOrphanPurging] = useState(false);
  const [activeJob, setActiveJob] = useState<JobState | null>(null);
  const [filter, setFilter] = useState("");

  const reloadStats = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/variants/stats");
      if (r.ok) setStats(await r.json());
    } catch { /* ignore */ }
  }, []);

  const reloadUsers = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/variants/users");
      if (r.ok) setUsers(await r.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    reloadStats();
    reloadUsers();
  }, [reloadStats, reloadUsers]);

  // SSE - receive progress and completion events.
  useEffect(() => {
    const es = new EventSource("/api/history/stream");
    const onProgress = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setActiveJob((prev) => prev && prev.jobId === data.jobId
          ? { ...prev, done: data.done, total: data.total, currentEmail: data.currentEmail, errorCount: data.errors }
          : prev);
      } catch { /* ignore */ }
    };
    const onDone = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setActiveJob((prev) => prev && prev.jobId === data.jobId
          ? { ...prev, finished: true, errorCount: data.errors }
          : prev);
        reloadStats();
        reloadUsers();
      } catch { /* ignore */ }
    };
    es.addEventListener("admin.variants_rebuild_progress", onProgress as EventListener);
    es.addEventListener("admin.variants_rebuild_done", onDone as EventListener);
    return () => { es.close(); };
  }, [reloadStats, reloadUsers]);

  const doScan = async () => {
    setScanning(true);
    try {
      const r = await fetch("/api/admin/variants/legacy-scan");
      if (r.ok) setScan(await r.json());
    } finally { setScanning(false); }
  };

  const doPurge = async () => {
    if (purgeConfirm !== "УДАЛИТЬ") {
      toast.error("Введите УДАЛИТЬ для подтверждения");
      return;
    }
    setPurging(true);
    try {
      const r = await fetch("/api/admin/variants/legacy-purge", { method: "POST" });
      if (r.ok) {
        const data = await r.json();
        toast.success(`Удалено: ${data.deleted}`);
        setScan(null);
        setPurgeConfirm("");
        reloadStats();
      } else {
        toast.error("Ошибка очистки");
      }
    } finally { setPurging(false); }
  };

  const doOrphanScan = async () => {
    setOrphanScanning(true);
    try {
      const r = await fetch("/api/admin/variants/orphan-scan");
      if (r.ok) setOrphanScan(await r.json());
    } finally { setOrphanScanning(false); }
  };

  const doOrphanPurge = async () => {
    if (orphanConfirm !== "УДАЛИТЬ") {
      toast.error("Введите УДАЛИТЬ для подтверждения");
      return;
    }
    setOrphanPurging(true);
    try {
      const r = await fetch("/api/admin/variants/orphan-purge", { method: "POST" });
      if (r.ok) {
        const data = await r.json();
        toast.success(`Удалено орфанов: ${data.deleted}`);
        setOrphanScan(null);
        setOrphanConfirm("");
        reloadStats();
      } else {
        toast.error("Ошибка очистки");
      }
    } finally { setOrphanPurging(false); }
  };

  const startRebuildUser = async (userId: number, email: string) => {
    const r = await fetch("/api/admin/variants/rebuild", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    if (!r.ok) { toast.error("Не удалось запустить"); return; }
    const data = await r.json();
    if (data.folded) {
      toast.message("Job уже выполняется", { description: "Дождитесь окончания и запустите снова" });
      return;
    }
    setActiveJob({
      jobId: data.jobId, scope: "user", total: 0, done: 0, errors: [], errorCount: 0, finished: false,
      currentEmail: email,
    });
  };

  const startRebuildAll = async () => {
    const r = await fetch("/api/admin/variants/rebuild-all", { method: "POST" });
    if (!r.ok) { toast.error("Не удалось запустить"); return; }
    const data = await r.json();
    if (data.folded) {
      toast.message("Job уже выполняется", { description: "Дождитесь окончания и запустите снова" });
      return;
    }
    setActiveJob({
      jobId: data.jobId, scope: "all", total: 0, done: 0, errors: [], errorCount: 0, finished: false,
    });
  };

  const filteredUsers = users.filter((u) =>
    !filter || u.email.toLowerCase().includes(filter.toLowerCase())
  );

  const jobRunning = activeJob !== null && !activeJob.finished;
  const pct = activeJob && activeJob.total > 0
    ? Math.round((activeJob.done / activeJob.total) * 100)
    : 0;

  return (
    <div className="max-w-6xl space-y-6">
      <section className="rounded-md border p-4">
        <h2 className="text-base font-semibold mb-2">Состояние превью</h2>
        {stats ? (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt>Оригиналов в БД:</dt><dd>{stats.originals_in_db}</dd>
            <dt>Thumb на диске:</dt><dd>{stats.variants_on_disk_thumb}</dd>
            <dt>Mid на диске:</dt><dd>{stats.variants_on_disk_mid}</dd>
            <dt>Каталог вариантов:</dt><dd className="font-mono text-xs">{stats.variants_dir}</dd>
          </dl>
        ) : <p className="text-sm text-muted-foreground">Загрузка...</p>}
      </section>

      <section className="rounded-md border p-4">
        <h2 className="text-base font-semibold mb-1">Очистка старых вариантов</h2>
        <p className="text-sm text-muted-foreground mb-3">
          Удалит файлы <code>thumb_*.jpg</code> и <code>mid_*.jpg</code> из папок пользователей.
          Используйте один раз перед первой пересборкой.
        </p>
        <div className="flex items-center gap-2 mb-2">
          <button onClick={doScan} disabled={scanning || jobRunning}
            className="px-3 py-1.5 rounded border text-sm">
            {scanning ? "Сканирование..." : "Сканировать"}
          </button>
          {scan && (
            <span className="text-sm">найдено {scan.count} файлов в {scan.dirs.length} папках</span>
          )}
        </div>
        {scan && scan.count > 0 && (
          <div className="flex items-center gap-2">
            <input type="text" value={purgeConfirm} onChange={(e) => setPurgeConfirm(e.target.value)}
              placeholder='Введите "УДАЛИТЬ"'
              className="px-2 py-1 rounded border text-sm bg-background text-foreground" />
            <button onClick={doPurge} disabled={purging || purgeConfirm !== "УДАЛИТЬ" || jobRunning}
              className="px-3 py-1.5 rounded border border-destructive text-destructive text-sm disabled:opacity-50">
              Удалить старые
            </button>
          </div>
        )}
      </section>

      <section className="rounded-md border p-4">
        <h2 className="text-base font-semibold mb-1">Удаление орфан-оригиналов</h2>
        <p className="text-sm text-muted-foreground mb-3">
          Удалит <code>&lt;uuid&gt;.&lt;ext&gt;</code> файлы из папок пользователей, на которые
          не ссылается ни одна строка в БД. Это исторические дубли от sync-провайдеров
          (Fal/Comfy), накопленные до текущего исправления. <code>deleted_*/</code> архивы
          и пользовательские нестандартные файлы не трогаются.
        </p>
        <div className="flex items-center gap-2 mb-2">
          <button onClick={doOrphanScan} disabled={orphanScanning || jobRunning}
            className="px-3 py-1.5 rounded border text-sm">
            {orphanScanning ? "Сканирование..." : "Сканировать"}
          </button>
          {orphanScan && (
            <span className="text-sm">найдено {orphanScan.count} орфанов</span>
          )}
        </div>
        {orphanScan && orphanScan.count > 0 && (
          <div className="flex items-center gap-2">
            <input type="text" value={orphanConfirm} onChange={(e) => setOrphanConfirm(e.target.value)}
              placeholder='Введите "УДАЛИТЬ"'
              className="px-2 py-1 rounded border text-sm bg-background text-foreground" />
            <button onClick={doOrphanPurge} disabled={orphanPurging || orphanConfirm !== "УДАЛИТЬ" || jobRunning}
              className="px-3 py-1.5 rounded border border-destructive text-destructive text-sm disabled:opacity-50">
              Удалить орфанов
            </button>
          </div>
        )}
      </section>

      <section className="rounded-md border p-4">
        <h2 className="text-base font-semibold mb-2">Пересборка вариантов</h2>
        <div className="flex items-center gap-2 mb-3">
          <button onClick={startRebuildAll} disabled={jobRunning}
            className="px-3 py-1.5 rounded border text-sm">
            Пересобрать всё
          </button>
          {activeJob && (
            <span className="text-sm">
              {activeJob.finished ? "Готово" : `Job ${activeJob.jobId.slice(0, 8)}...`}: {activeJob.done} / {activeJob.total}
              {activeJob.errorCount > 0 && ` (${activeJob.errorCount} ошибок)`}
              {activeJob.currentEmail && !activeJob.finished && ` - ${activeJob.currentEmail}`}
            </span>
          )}
        </div>
        {jobRunning && (
          <div className="h-2 w-full bg-muted rounded overflow-hidden mb-3">
            <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
        )}
        <input type="text" placeholder="Поиск..."
          value={filter} onChange={(e) => setFilter(e.target.value)}
          className="px-2 py-1 rounded border text-sm bg-background text-foreground w-64 mb-2" />
        <ul className="text-sm divide-y border rounded">
          {filteredUsers.map((u) => (
            <li key={u.user_id} className="flex items-center justify-between px-3 py-2">
              <span>{u.email}</span>
              <span className="flex items-center gap-3">
                <span className="text-muted-foreground">{u.image_generation_count} ген.</span>
                <button onClick={() => startRebuildUser(u.user_id, u.email)} disabled={jobRunning}
                  className="px-2 py-1 rounded border text-xs">
                  Пересобрать
                </button>
              </span>
            </li>
          ))}
          {filteredUsers.length === 0 && (
            <li className="px-3 py-2 text-muted-foreground">Нет пользователей с изображениями</li>
          )}
        </ul>
      </section>

      {activeJob && activeJob.errorCount > 0 && (
        <section className="rounded-md border p-4">
          <details>
            <summary className="cursor-pointer text-sm font-semibold">
              Ошибки последней пересборки ({activeJob.errorCount})
            </summary>
            {activeJob.errors.length > 0 ? (
              <ul className="mt-2 space-y-1 text-xs font-mono">
                {activeJob.errors.map((e, i) => (
                  <li key={i}>generation {e.generationId}: {e.reason} {e.error}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                Детали будут доступны после обновления страницы (поднимаются из job state).
              </p>
            )}
          </details>
        </section>
      )}
    </div>
  );
}
