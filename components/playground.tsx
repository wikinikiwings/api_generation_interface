"use client";

import * as React from "react";
import { GenerateForm } from "@/components/generate-form";
import { OutputArea } from "@/components/output-area";
import { HistorySidebar } from "@/components/history-sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Select } from "@/components/ui/select";
import { UsernameModal } from "@/components/username-modal";
import { useSettingsStore } from "@/stores/settings-store";
import { listAllModels } from "@/lib/providers/models";
import type { ModelId, ProviderId } from "@/lib/providers/types";

// Client-side mirror of each provider's `supportedModels`. We don't fetch from
// /api/providers because that would add a round-trip on every mount; the
// canonical source remains the provider files in lib/providers/. If you add a
// model, update both the provider file AND this table. The autoswitch effect
// below uses this to bounce selectedModel to a supported one when the user
// changes provider while a non-supported model is active.
const PROVIDER_MODELS: Record<ProviderId, ModelId[]> = {
  wavespeed: ["nano-banana-pro", "nano-banana-2", "nano-banana", "seedream-4-5", "seedream-5-0-lite"],
  fal:       ["nano-banana-pro", "nano-banana-2", "nano-banana", "seedream-4-5", "seedream-5-0-lite"],
  comfy:     ["nano-banana-pro", "nano-banana-2", "nano-banana", "seedream-4-5", "seedream-5-0-lite"],
};

/**
 * Model picker options shown in the form card header.
 *
 * Currently there's only one model (Nano Banana Pro) shared across all three
 * providers. When multi-model support is wired (see CHECKPOINT-v3 →
 * "Подготовка к мульти-модельной архитектуре"), expand this array and thread
 * `selectedModel` down to `GenerateForm` as a prop so it can be included in
 * the `EditInput` sent to providers.
 *
 * For now, this select is a real functional component but has only one
 * option — it acts as a visual slot ready to grow without any refactor.
 */
const MODEL_OPTIONS = [
  { value: "nano-banana-pro", label: "Nano Banana Pro" },
];

export function Playground() {
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const selectedProvider = useSettingsStore((s) => s.selectedProvider);
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const setSelectedModel = useSettingsStore((s) => s.setSelectedModel);

  // Filter the visible model options to those supported by the active provider.
  const modelOptions = React.useMemo(
    () =>
      listAllModels()
        .filter((m) => PROVIDER_MODELS[selectedProvider].includes(m.id))
        .map((m) => ({ value: m.id, label: m.displayName })),
    [selectedProvider]
  );

  // If the user switches provider while their currently-selected model isn't
  // supported by the new provider (e.g. seedream selected then provider
  // switches to comfy), snap selectedModel to the first one the new provider
  // does support. Without this, the API route would 400 on the next submit.
  React.useEffect(() => {
    const supported = PROVIDER_MODELS[selectedProvider];
    if (!supported.includes(selectedModel)) {
      setSelectedModel(supported[0]);
    }
  }, [selectedProvider, selectedModel, setSelectedModel]);

  return (
    // The top bar was removed to give the form card more vertical real estate
    // so that the Generate button is always reachable without scrolling. What
    // used to live in the top bar (theme toggle) now lives inside the form
    // card header.
    <div className="flex h-screen flex-col bg-background">
      {/* Blocking nickname modal — must be inside <UserProvider> scope
          (provided by app/providers.tsx). Renders null once the username
          cookie is set. CHECKPOINT-v4 §"Identity layer". */}
      <UsernameModal />

      <main className="flex min-h-0 flex-1 gap-0 p-4 md:p-6">
        {/* Left: form */}
        <section className="hidden w-full max-w-[440px] flex-shrink-0 flex-col overflow-hidden rounded-l-xl bg-muted/50 p-4 md:flex">
          <div className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border border-border bg-background shadow-md">
            {/* Card header: model picker + theme toggle.
                The admin panel lives at /admin but there's no visible link
                to it — the URL is known only to the owner, and in production
                Caddy/nginx blocks /admin from public access entirely. */}
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <div className="flex-1">
                <Select
                  id="model"
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value as ModelId)}
                  options={modelOptions}
                  className="h-9"
                />
              </div>
              <ThemeToggle />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <GenerateForm />
            </div>
          </div>
        </section>

        {/* Right: output area (+ optional history sidebar) */}
        <section className="flex min-h-0 flex-1 gap-3 rounded-r-xl bg-muted/50 p-4">
          <OutputArea
            historyOpen={historyOpen}
            onToggleHistory={() => setHistoryOpen((v) => !v)}
          />
          <HistorySidebar open={historyOpen} setOpen={setHistoryOpen} />
        </section>
      </main>
    </div>
  );
}
