"use client";

import * as React from "react";
import { toast } from "sonner";
import { Plus, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  type Style,
  STYLE_NAME_MAX,
  STYLE_PART_MAX,
} from "@/lib/styles/types";
import { composeFinalPrompt } from "@/lib/styles/inject";

type Draft = {
  // For a new (unsaved) style, id is undefined.
  id: string | undefined;
  name: string;
  prefix: string;
  suffix: string;
};

export function StylesSection() {
  const [styles, setStyles] = React.useState<Style[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const selected = React.useMemo(
    () => styles.find((s) => s.id === selectedId) ?? null,
    [styles, selectedId]
  );

  const dirty = React.useMemo(() => {
    if (!draft) return false;
    if (draft.id === undefined) return true; // new unsaved
    const s = styles.find((x) => x.id === draft.id);
    if (!s) return false;
    return (
      s.name !== draft.name ||
      s.prefix !== draft.prefix ||
      s.suffix !== draft.suffix
    );
  }, [draft, styles]);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/styles", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { styles: Style[] };
      setStyles(data.styles);
      setLoadError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      setLoadError(msg);
      toast.error(`Не удалось загрузить стили: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  function selectStyle(id: string) {
    if (dirty && !window.confirm("Отменить несохранённые изменения?")) return;
    setSelectedId(id);
    const s = styles.find((x) => x.id === id);
    setDraft(
      s
        ? { id: s.id, name: s.name, prefix: s.prefix, suffix: s.suffix }
        : null
    );
  }

  function startNew() {
    if (dirty && !window.confirm("Отменить несохранённые изменения?")) return;
    setSelectedId(null);
    setDraft({ id: undefined, name: "", prefix: "", suffix: "" });
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const isNew = draft.id === undefined;
      const url = isNew
        ? "/api/admin/styles"
        : `/api/admin/styles/${encodeURIComponent(draft.id!)}`;
      const method = isNew ? "POST" : "PUT";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          prefix: draft.prefix,
          suffix: draft.suffix,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { style: Style };
      await load();
      setSelectedId(body.style.id);
      setDraft({
        id: body.style.id,
        name: body.style.name,
        prefix: body.style.prefix,
        suffix: body.style.suffix,
      });
      toast.success(isNew ? "Стиль создан" : "Стиль сохранён");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      toast.error(`Не удалось сохранить: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!selected) return;
    if (!window.confirm(`Удалить стиль "${selected.name}"?`)) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/admin/styles/${encodeURIComponent(selected.id)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      await load();
      setSelectedId(null);
      setDraft(null);
      toast.success("Стиль удалён");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      toast.error(`Не удалось удалить: ${msg}`);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-background shadow-sm">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-base font-semibold">Стили промпта</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Оборачивают промпт пользователя: <code>prefix</code>
          {" + \". \" + промпт + \". \" + "}
          <code>suffix</code>. Пустые части не вставляют разделитель. Стиль{" "}
          <em>Стандартный</em> всегда доступен и ничего не меняет.
        </p>
      </div>

      <div className="flex flex-col gap-4 p-4 md:flex-row">
        {/* Left: list */}
        <div className="w-full md:w-[260px] md:shrink-0">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={startNew}
            className="mb-2 w-full justify-start"
          >
            <Plus className="h-4 w-4" />
            Новый стиль
          </Button>
          {loading ? (
            <div className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Загрузка…
            </div>
          ) : loadError ? (
            <div className="p-2 text-xs text-destructive">
              Ошибка: {loadError}
            </div>
          ) : styles.length === 0 && draft?.id === undefined ? (
            <div className="p-2 text-xs text-muted-foreground">
              Пока стилей нет.
            </div>
          ) : (
            <ul className="space-y-1">
              {/* Unsaved new style gets a row at the top */}
              {draft !== null && draft.id === undefined && (
                <li>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md bg-primary/10 px-2 py-1.5 text-left text-sm"
                  >
                    <span className="text-primary">●</span>
                    <span className="truncate">
                      {draft.name.trim() || "Без названия"}
                    </span>
                  </button>
                </li>
              )}
              {styles.map((s) => {
                const isSel = selectedId === s.id;
                const isDirty = dirty && draft?.id === s.id;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => selectStyle(s.id)}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                        isSel ? "bg-primary/10" : "hover:bg-muted/60"
                      }`}
                    >
                      {isDirty && <span className="text-primary">●</span>}
                      <span className="truncate">{s.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Right: editor */}
        <div className="flex-1">
          {!draft ? (
            <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
              {styles.length === 0
                ? "Создайте первый стиль, нажав +."
                : "Выберите стиль из списка или создайте новый."}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div>
                <label
                  htmlFor="style-name"
                  className="mb-1 block text-xs font-medium"
                >
                  Название
                </label>
                <input
                  id="style-name"
                  type="text"
                  maxLength={STYLE_NAME_MAX}
                  value={draft.name}
                  onChange={(e) =>
                    setDraft({ ...draft, name: e.target.value })
                  }
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  placeholder="Короткое имя стиля"
                />
              </div>

              <div>
                <label
                  htmlFor="style-prefix"
                  className="mb-1 block text-xs font-medium"
                >
                  Вставка до промпта
                </label>
                <textarea
                  id="style-prefix"
                  maxLength={STYLE_PART_MAX}
                  value={draft.prefix}
                  onChange={(e) =>
                    setDraft({ ...draft, prefix: e.target.value })
                  }
                  rows={3}
                  className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  placeholder="Что дописать ПЕРЕД промптом пользователя"
                />
              </div>

              <div>
                <label
                  htmlFor="style-suffix"
                  className="mb-1 block text-xs font-medium"
                >
                  Вставка после промпта
                </label>
                <textarea
                  id="style-suffix"
                  maxLength={STYLE_PART_MAX}
                  value={draft.suffix}
                  onChange={(e) =>
                    setDraft({ ...draft, suffix: e.target.value })
                  }
                  rows={3}
                  className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  placeholder="Что дописать ПОСЛЕ промпта пользователя"
                />
              </div>

              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  Превью
                </div>
                <div className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs font-mono text-muted-foreground">
                  {previewFor(draft)}
                </div>
              </div>

              <div className="mt-1 flex gap-2">
                <Button
                  type="button"
                  onClick={save}
                  disabled={saving || !draft.name.trim()}
                  size="sm"
                >
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  Сохранить
                </Button>
                {draft.id !== undefined && (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={remove}
                    disabled={deleting}
                  >
                    {deleting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    Удалить
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function previewFor(draft: Draft): string {
  return composeFinalPrompt("<промпт пользователя>", [
    {
      id: "__preview__",
      name: "",
      prefix: draft.prefix,
      suffix: draft.suffix,
      createdAt: "",
      updatedAt: "",
    },
  ]);
}
