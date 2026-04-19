"use client";

import * as React from "react";
import { ChevronDown, Info, Copy } from "lucide-react";
import { toast } from "sonner";
import { cn, copyToClipboard } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { Style } from "@/lib/styles/types";

interface StylesMultiSelectProps {
  styles: Style[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  id?: string;
  className?: string;
}

/**
 * Checkbox dropdown with order numbers. Click order determines wrap
 * order (matryoshka). Unticking renumbers remaining ticks to stay
 * contiguous (1, 2, 3 — untick 2 — remaining become 1, 2).
 *
 * No styles selected is the "Стандартный" state — the trigger shows
 * that label, and the list does not include a "Стандартный" row
 * (ticking nothing is the same thing).
 *
 * Each row also exposes two small action buttons next to the name:
 * an Info button that opens a modal showing the raw prefix/suffix
 * content (so the style is not a "black box"), and a Copy button
 * that places prefix + blank line + suffix on the clipboard.
 */
export function StylesMultiSelect({
  styles,
  selectedIds,
  onChange,
  id,
  className,
}: StylesMultiSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [infoStyle, setInfoStyle] = React.useState<Style | null>(null);
  const [query, setQuery] = React.useState("");
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (open) {
      const t = window.setTimeout(() => searchInputRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
    setQuery("");
  }, [open]);

  const filteredStyles = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return styles;
    return styles.filter((s) => s.name.toLowerCase().includes(q));
  }, [styles, query]);

  // Close on click outside. Ignore clicks when the info dialog is open —
  // the dialog renders in a portal outside containerRef, and without this
  // guard the dropdown would auto-close under the dialog, leaving the
  // user with no dropdown to return to.
  React.useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (infoStyle) return;
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open, infoStyle]);

  // Close on Escape. Ignored while the info dialog is open — Radix
  // handles Esc for the dialog itself.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (infoStyle) return;
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, infoStyle]);

  const triggerLabel = React.useMemo(() => {
    if (selectedIds.length === 0) return "Стандартный";
    return selectedIds
      .map((id) => styles.find((s) => s.id === id)?.name ?? id)
      .join(" + ");
  }, [selectedIds, styles]);

  function toggle(id: string) {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  }

  async function copyStyleText(s: Style) {
    const parts = [s.prefix.trim(), s.suffix.trim()].filter(
      (p) => p.length > 0
    );
    if (parts.length === 0) {
      toast.info("В стиле пусто — копировать нечего");
      return;
    }
    const ok = await copyToClipboard(parts.join("\n\n"));
    if (ok) toast.success(`Текст стиля «${s.name}» скопирован`);
    else toast.error("Не удалось скопировать");
  }

  return (
    <div className={cn("relative", className)} ref={containerRef}>
      <button
        type="button"
        id={id}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex h-9 w-full items-center justify-between rounded-md border border-input px-3 py-1 text-sm shadow-sm transition-colors duration-300 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          selectedIds.length > 0 ? "bg-violet-500/15" : "bg-background"
        )}
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-20 mt-1 rounded-md border border-border bg-background p-1 shadow-md">
          {styles.length > 0 && (
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск стилей…"
              aria-label="Поиск стилей"
              className="mb-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          )}
          <div role="listbox" className="max-h-64 overflow-auto">
          {styles.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              Стилей пока нет. Создайте в админке.
            </div>
          ) : filteredStyles.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              Ничего не найдено
            </div>
          ) : (
            filteredStyles.map((s) => {
              const idx = selectedIds.indexOf(s.id);
              const checked = idx !== -1;
              const order = checked ? idx + 1 : null;
              return (
                <div
                  key={s.id}
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  className={cn(
                    "flex items-center gap-0.5 rounded-md transition-colors",
                    checked && "bg-primary/5"
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggle(s.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    <span
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-semibold",
                        checked
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-muted-foreground/40"
                      )}
                    >
                      {order ?? ""}
                    </span>
                    <span className="truncate">{s.name}</span>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setInfoStyle(s);
                    }}
                    title="Посмотреть содержимое стиля"
                    aria-label={`Посмотреть содержимое стиля ${s.name}`}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <Info className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void copyStyleText(s);
                    }}
                    title="Скопировать текст стиля"
                    aria-label={`Скопировать текст стиля ${s.name}`}
                    className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })
          )}
          </div>
        </div>
      )}

      <Dialog
        open={infoStyle !== null}
        onOpenChange={(v) => {
          if (!v) setInfoStyle(null);
        }}
      >
        {infoStyle && (
          <DialogContent className="max-w-xl rounded-lg border border-border bg-background p-5 shadow-xl">
            <DialogTitle>{infoStyle.name}</DialogTitle>
            <div className="space-y-3 text-xs">
              <div>
                <div className="mb-1 font-medium text-muted-foreground">
                  До промпта (prefix)
                </div>
                <div className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-dashed border-border bg-muted/30 p-2 font-mono text-muted-foreground">
                  {infoStyle.prefix.trim() || "—"}
                </div>
              </div>
              <div>
                <div className="mb-1 font-medium text-muted-foreground">
                  После промпта (suffix)
                </div>
                <div className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-dashed border-border bg-muted/30 p-2 font-mono text-muted-foreground">
                  {infoStyle.suffix.trim() || "—"}
                </div>
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
