"use client";

import * as React from "react";
import { toast } from "sonner";
import { GenerateForm } from "@/components/generate-form";
import { OutputArea } from "@/components/output-area";
import { HistorySidebar } from "@/components/history-sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { HeaderUserMenu } from "@/components/header-user-menu";
import { Select } from "@/components/ui/select";
import { UsernameModal } from "@/components/username-modal";
import { useSettingsStore } from "@/stores/settings-store";
import { useUser } from "@/app/providers/user-provider";
import { useQuotas } from "@/app/providers/quotas-provider";
import { listAllModels } from "@/lib/providers/models";
import type { ModelId, ProviderId } from "@/lib/providers/types";
import type { Style } from "@/lib/styles/types";

/**
 * Display names for the three provider IDs. Hardcoded here — there are
 * only three and they rarely change. If you add a fourth provider, update
 * this map and PROVIDER_MODELS below in the same commit.
 */
const PROVIDER_LABELS: Record<ProviderId, string> = {
  wavespeed: "WaveSpeed",
  fal: "Fal.ai",
  comfy: "ComfyUI",
};

/**
 * Per-provider model whitelist (client-side mirror of each provider's
 * `supportedModels`). We don't fetch /api/providers because that would add
 * a round-trip on every mount; the canonical source remains the provider
 * files in lib/providers/. If you add a model, update both the provider
 * file AND this table. The autoswitch effect below uses this to bounce
 * selectedModel to a supported one when the user changes provider while a
 * non-supported model is active.
 */
const PROVIDER_MODELS: Record<ProviderId, ModelId[]> = {
  wavespeed: ["nano-banana-pro", "nano-banana-2", "nano-banana", "seedream-4-5", "seedream-5-0-lite"],
  fal:       ["nano-banana-pro", "nano-banana-2", "nano-banana", "seedream-4-5", "seedream-5-0-lite"],
  comfy:     ["nano-banana-pro", "nano-banana-2", "nano-banana", "seedream-4-5", "seedream-5-0-lite"],
};

export function Playground() {
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const selectedProvider = useSettingsStore((s) => s.selectedProvider);
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const setSelectedModel = useSettingsStore((s) => s.setSelectedModel);
  const hydrateUserModel = useSettingsStore((s) => s.hydrateUserModel);
  const startProviderPolling = useSettingsStore((s) => s.startProviderPolling);
  const reconcileSelectedStyles = useSettingsStore((s) => s.reconcileSelectedStyles);
  const [styles, setStyles] = React.useState<Style[]>([]);

  const loadStyles = React.useCallback(async () => {
    try {
      const res = await fetch("/api/styles", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { styles: Style[] };
      setStyles(data.styles);
      reconcileSelectedStyles(data.styles.map((s) => s.id));
    } catch (err) {
      console.warn("[playground] failed to load styles:", err);
    }
  }, [reconcileSelectedStyles]);

  React.useEffect(() => {
    void loadStyles();
    const onFocus = () => void loadStyles();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadStyles]);

  const { user } = useUser(); const username = user?.email ?? null;

  // Flag set by the polling callback to mark that the next provider change
  // came from the server (admin action), not from a user interaction in
  // this tab. The auto-switch effect below reads this to decide whether
  // to surface a toast about an incompatible model. Using a ref instead
  // of state because we don't want to trigger a re-render — the flag is
  // consumed inside an effect that already runs on selectedProvider change.
  const adminSwitchRef = React.useRef(false);

  // Per-user model hydration. Runs once when username becomes known
  // (i.e. after UsernameModal closes on first visit, or immediately on
  // subsequent visits since the cookie is already set). The store guards
  // against stomping a click that happens during the in-flight request,
  // so it's safe to fire even if the user is interacting with the picker.
  React.useEffect(() => {
    if (username) void hydrateUserModel();
  }, [username, hydrateUserModel]);

  // Provider polling: detect admin-side changes to the active provider
  // and notify the user. The toast "Админ переключил endpoint на X"
  // fires here. The companion toast about incompatible models lives in
  // the auto-switch effect below — they're separate concerns.
  React.useEffect(() => {
    const cleanup = startProviderPolling((next, prev) => {
      adminSwitchRef.current = true;
      toast.info(
        `Админ переключил endpoint на ${PROVIDER_LABELS[next]}`,
        {
          description: `Было: ${PROVIDER_LABELS[prev]}. Следующая генерация пойдёт через новый endpoint.`,
        }
      );
    });
    return cleanup;
  }, [startProviderPolling]);

  const { getForModel } = useQuotas();

  // Filter the visible model options to those supported by the active provider.
  const modelOptions = React.useMemo(
    () =>
      listAllModels()
        .filter((m) => PROVIDER_MODELS[selectedProvider].includes(m.id))
        .map((m) => ({ value: m.id, label: m.displayName })),
    [selectedProvider]
  );

  // Augment model options with quota exhaustion indicators.
  // The Select component does not support per-option disabled, so we append
  // ⛔ to the label to signal exhausted models visually.
  const modelOptionsWithQuota = React.useMemo(
    () =>
      modelOptions.map((opt) => {
        const q = getForModel(opt.value);
        const isExhausted = q && !q.unlimited && q.used >= (q.limit ?? 0);
        return {
          ...opt,
          label: isExhausted ? `${opt.label} ⛔` : opt.label,
        };
      }),
    [modelOptions, getForModel]
  );

  // If the user switches provider while their currently-selected model isn't
  // supported by the new provider (e.g. seedream selected then provider
  // switches to comfy), snap selectedModel to the first one the new provider
  // does support. Without this, the API route would 400 on the next submit.
  // The snapped fallback is also persisted server-side — the user effectively
  // "chose" this fallback by changing the provider.
  //
  // If the provider change came from the admin (adminSwitchRef.current is
  // true), surface an extra toast explaining what happened to the model.
  React.useEffect(() => {
    const supported = PROVIDER_MODELS[selectedProvider];
    if (!supported.includes(selectedModel)) {
      const fallback = supported[0];
      const wasAdminSwitch = adminSwitchRef.current;
      // Capture display names BEFORE setSelectedModel updates state, so
      // the toast shows the old model name, not the new one.
      const allModels = listAllModels();
      const oldLabel =
        allModels.find((m) => m.id === selectedModel)?.displayName ?? selectedModel;
      const newLabel =
        allModels.find((m) => m.id === fallback)?.displayName ?? fallback;
      setSelectedModel(fallback);
      if (wasAdminSwitch) {
        toast.warning(
          `Модель «${oldLabel}» недоступна для этого endpoint`,
          {
            description: `Вы были автоматически переключены на «${newLabel}».`,
          }
        );
      }
    }
    // Always reset the flag at the end of the effect, regardless of
    // whether a model swap happened. Otherwise a future user-driven
    // model change could pick up a stale flag.
    adminSwitchRef.current = false;
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
                  options={modelOptionsWithQuota}
                  className="h-9"
                />
              </div>
              <ThemeToggle />
              <HeaderUserMenu />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-5 pb-0">
              <GenerateForm styles={styles} />
            </div>
          </div>
        </section>

        {/* Right: output area (+ optional history sidebar) */}
        <section className="flex min-h-0 flex-1 gap-3 rounded-r-xl bg-muted/50 p-4">
          <OutputArea
            historyOpen={historyOpen}
            onToggleHistory={() => setHistoryOpen((v) => !v)}
            styles={styles}
          />
          <HistorySidebar open={historyOpen} setOpen={setHistoryOpen} styles={styles} />
        </section>
      </main>
    </div>
  );
}
