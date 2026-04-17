"use client";

import * as React from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { cn, copyToClipboard } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useSettingsStore } from "@/stores/settings-store";
import { usePromptStore } from "@/stores/prompt-store";
import { composeFinalPrompt } from "@/lib/styles/inject";
import { buildPreviewBlocks, STYLE_COLORS } from "@/lib/styles/preview";
import type { Style } from "@/lib/styles/types";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { reorderStyleIds } from "@/lib/styles/reorder";

interface PromptPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  styles: Style[];
}

interface StyleRowProps {
  style: Style;
  onToggle: () => void;
}

function SortableStyleRow({
  style,
  order,
  onToggle,
}: StyleRowProps & { order: number }) {
  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: style.id });

  const dragStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={dragStyle}
      {...attributes}
      {...listeners}
      aria-label={`${style.name}, позиция ${order}. Потяни чтобы изменить порядок`}
      title="Потяни чтобы изменить порядок"
      className={cn(
        "flex items-center gap-1 rounded-md bg-primary/5 cursor-grab transition-colors active:cursor-grabbing",
        isDragging && "z-10 opacity-50"
      )}
    >
      <span className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded border border-primary bg-primary text-[11px] font-semibold text-primary-foreground">
        {order}
      </span>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={true}
        aria-label={`Снять стиль ${style.name}`}
        className="flex min-w-0 flex-1 items-center rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <span className="truncate">{style.name}</span>
      </button>
    </div>
  );
}

function PlainStyleRow({ style, onToggle }: StyleRowProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      role="menuitemcheckbox"
      aria-checked={false}
      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-muted-foreground/40 text-[10px]" />
      <span className="truncate">{style.name}</span>
    </button>
  );
}

export function PromptPreviewDialog({
  open,
  onOpenChange,
  styles,
}: PromptPreviewDialogProps) {
  const selectedStyleIds = useSettingsStore((s) => s.selectedStyleIds);
  const setSelectedStyleIds = useSettingsStore((s) => s.setSelectedStyleIds);
  const prompt = usePromptStore((s) => s.prompt);

  const activeStyles = React.useMemo<Style[]>(() => {
    return selectedStyleIds
      .map((id) => styles.find((s) => s.id === id))
      .filter((s): s is Style => s !== undefined);
  }, [styles, selectedStyleIds]);

  const untickedStyles = React.useMemo<Style[]>(
    () => styles.filter((s) => !selectedStyleIds.includes(s.id)),
    [styles, selectedStyleIds]
  );

  const blocks = React.useMemo(
    () => buildPreviewBlocks(prompt, activeStyles),
    [prompt, activeStyles]
  );

  const finalPrompt = React.useMemo(
    () => composeFinalPrompt(prompt, activeStyles),
    [prompt, activeStyles]
  );

  function toggle(id: string) {
    if (selectedStyleIds.includes(id)) {
      setSelectedStyleIds(selectedStyleIds.filter((x) => x !== id));
    } else {
      setSelectedStyleIds([...selectedStyleIds, id]);
    }
  }

  async function copyFinal() {
    if (finalPrompt.length === 0) return;
    const ok = await copyToClipboard(finalPrompt);
    if (ok) toast.success("Финальный промпт скопирован");
    else toast.error("Не удалось скопировать");
  }

  const copyDisabled = finalPrompt.length === 0;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragEnd(e: DragEndEvent) {
    const next = reorderStyleIds(
      selectedStyleIds,
      String(e.active.id),
      e.over ? String(e.over.id) : null
    );
    if (next) setSelectedStyleIds(next);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden rounded-lg border border-border bg-background p-5 shadow-xl">
        <DialogTitle>Превью промпта</DialogTitle>

        <div className="grid gap-4 md:grid-cols-[minmax(0,280px)_minmax(0,1fr)] md:max-h-[70vh] md:overflow-hidden">
          {/* Left: styles list */}
          <div className="flex flex-col gap-1 md:overflow-y-auto md:pr-2">
            {styles.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                Стилей пока нет. Создайте в админке.
              </div>
            ) : (
              <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
                <SortableContext
                  items={activeStyles.map((s) => s.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {activeStyles.map((s, i) => (
                    <SortableStyleRow
                      key={s.id}
                      style={s}
                      order={i + 1}
                      onToggle={() => toggle(s.id)}
                    />
                  ))}
                </SortableContext>
                {untickedStyles.map((s) => (
                  <PlainStyleRow
                    key={s.id}
                    style={s}
                    onToggle={() => toggle(s.id)}
                  />
                ))}
              </DndContext>
            )}
            {selectedStyleIds.length > 3 && (
              <div className="mt-1 px-2 text-[11px] text-muted-foreground">
                ⚠ Больше 3 стилей — может выйти невнятный промпт
              </div>
            )}
          </div>

          {/* Right: structured preview */}
          <div className="flex min-w-0 flex-col md:overflow-hidden">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-medium text-muted-foreground">
                Итоговый промпт
              </div>
              <button
                type="button"
                onClick={copyFinal}
                disabled={copyDisabled}
                title="Скопировать финальный промпт"
                aria-label="Скопировать финальный промпт"
                className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="flex min-w-0 flex-col gap-2 md:overflow-y-auto md:pr-1">
              {blocks.map((blk) => {
                if (blk.kind === "prompt") {
                  const empty = blk.text.trim().length === 0;
                  return (
                    <div
                      key="prompt"
                      className="rounded-md border border-primary/40 bg-primary/5 p-2"
                    >
                      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-primary">
                        Промпт
                      </div>
                      {empty ? (
                        <div className="font-mono text-xs italic text-muted-foreground">
                          (пустой промпт)
                        </div>
                      ) : (
                        <div className="whitespace-pre-wrap break-words font-mono text-sm text-foreground">
                          {blk.text}
                        </div>
                      )}
                    </div>
                  );
                }

                const color =
                  STYLE_COLORS[blk.colorIndex! % STYLE_COLORS.length];
                return (
                  <div
                    key={`${blk.kind}:${blk.styleId}`}
                    className="flex gap-2 rounded-md border border-border bg-muted/20 p-2"
                  >
                    <div className={cn("w-1 shrink-0 rounded-sm", color)} />
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 text-[11px] text-muted-foreground">
                        {blk.styleName} · {blk.kind}
                      </div>
                      <div className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                        {blk.text}
                      </div>
                    </div>
                  </div>
                );
              })}

              {activeStyles.length === 0 && (
                <div className="px-2 text-[11px] text-muted-foreground">
                  стили не выбраны — промпт уходит как есть
                </div>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
