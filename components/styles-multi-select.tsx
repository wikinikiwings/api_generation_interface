"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
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
 * Soft warning appears below the trigger when selectedIds.length > 3.
 */
export function StylesMultiSelect({
  styles,
  selectedIds,
  onChange,
  id,
  className,
}: StylesMultiSelectProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  // Close on click outside.
  React.useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Close on Escape.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

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

  return (
    <div className={cn("relative", className)} ref={containerRef}>
      <button
        type="button"
        id={id}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 z-20 mt-1 max-h-64 overflow-auto rounded-md border border-border bg-background p-1 shadow-md"
        >
          {styles.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              Стилей пока нет. Создайте в админке.
            </div>
          ) : (
            styles.map((s) => {
              const idx = selectedIds.indexOf(s.id);
              const checked = idx !== -1;
              const order = checked ? idx + 1 : null;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  onClick={() => toggle(s.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
                    checked && "bg-primary/5"
                  )}
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
              );
            })
          )}
        </div>
      )}

      {selectedIds.length > 3 && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          ⚠ Больше 3 стилей — может выйти невнятный промпт
        </div>
      )}
    </div>
  );
}
