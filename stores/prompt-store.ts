"use client";

import { create } from "zustand";

/**
 * Holds the current text in the prompt textarea of GenerateForm.
 *
 * Lives in a store (not local component state) so that the
 * "Copy prompt" buttons in OutputArea and HistorySidebar can
 * push a prompt directly into the form on click — the user
 * shouldn't have to paste manually to re-run a prior generation.
 *
 * Not persisted: the form's prompt is ephemeral UI state, same
 * as before. Initial value matches the prior hard-coded default
 * in components/generate-form.tsx.
 */
interface PromptState {
  prompt: string;
  setPrompt: (p: string) => void;
}

export const usePromptStore = create<PromptState>()((set) => ({
  prompt: "Make the hamburger made of glass.",
  setPrompt: (prompt) => set({ prompt }),
}));
