"use client";

import * as React from "react";
import { useUser } from "@/app/providers/user-provider";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/select";
import { User } from "lucide-react";

/**
 * Blocking nickname-entry modal. Renders null once a username is set.
 *
 * Adapted from viewcomfy-claude. wavespeed-claude's `ui/dialog.tsx` is a
 * minimal port that only exports {Dialog, DialogContent, DialogTitle} —
 * no DialogHeader / DialogDescription / DialogFooter helpers — so we
 * inline plain divs/<p>/header structure with the same Tailwind look.
 *
 * The X close button is suppressed via `hideClose` (a prop the local
 * DialogContent supports), and pointer/escape/interact-outside are all
 * preventDefault'd so the user can't dismiss the modal without entering
 * a nickname.
 *
 * Input is a styled native <input> (wavespeed-claude has no
 * `components/ui/input.tsx`); Label is re-exported from `ui/select`,
 * matching the pattern used in app/admin/login/page.tsx.
 */
export function UsernameModal() {
  const { isUsernameSet, setUsername } = useUser();
  const [inputValue, setInputValue] = React.useState("");
  const [error, setError] = React.useState("");

  if (isUsernameSet) return null;

  const handleSubmit = () => {
    const trimmed = inputValue.trim();
    if (!trimmed) {
      setError("Введи никнейм");
      return;
    }
    if (trimmed.length < 2) {
      setError("Минимум 2 символа");
      return;
    }
    if (trimmed.length > 30) {
      setError("Максимум 30 символов");
      return;
    }
    setUsername(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <Dialog open={!isUsernameSet}>
      <DialogContent
        hideClose
        className="sm:max-w-[400px] rounded-xl border border-border bg-background p-6 shadow-lg"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className="flex flex-col space-y-1.5">
          <DialogTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Добро пожаловать
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            Введи никнейм — он используется для сохранения твоей истории
            генераций. Если ты уже заходил в viewcomfy под этим именем,
            историю увидишь сразу.
          </p>
        </div>

        <div className="space-y-2 py-2">
          <Label htmlFor="nickname">Никнейм</Label>
          <input
            id="nickname"
            type="text"
            placeholder="Твой никнейм..."
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              setError("");
            }}
            onKeyDown={handleKeyDown}
            autoFocus
            maxLength={30}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <Button onClick={handleSubmit} className="w-full">
          Продолжить
        </Button>
      </DialogContent>
    </Dialog>
  );
}
