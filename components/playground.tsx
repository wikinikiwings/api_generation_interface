"use client";

import * as React from "react";
import { toast } from "sonner";
import { GenerateForm } from "@/components/generate-form";
import { OutputArea } from "@/components/output-area";
import { HistorySidebar } from "@/components/history-sidebar";
import { HeaderUserMenu } from "@/components/header-user-menu";
import { Select } from "@/components/ui/select";
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
  const hydrateClient = useSettingsStore((s) => s.hydrateClient);
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

  // Pull localStorage-backed picks (selectedModel, selectedStyleIds) into the
  // store after mount. The store starts with SSR-safe defaults so server
  // and client render identically; this effect overlays the restored choice
  // on the next render. Must run BEFORE hydrateUserModel so the server-side
  // pref can stomp the LS seed (the stomp-guard inside hydrateUserModel
  // compares the snapshot it took to the current state).
  React.useEffect(() => {
    hydrateClient();
  }, [hydrateClient]);

  // Per-user model hydration. Runs once when the authenticated user becomes
  // known (UserProvider has resolved /api/auth/me). The store guards against
  // stomping a click that happens during the in-flight request, so it's safe
  // to fire even if the user is interacting with the picker.
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

  const { getForModel, quotas, loading: quotasLoading } = useQuotas();

  // Set of model_ids the server says are currently active for this user.
  // /api/me/quotas filters by `is_active=1`, so flipping that admin
  // checkbox propagates here automatically (BroadcastChannel("quotas")
  // → QuotasProvider refetch → this set rebuilds → picker re-renders).
  const activeModelIds = React.useMemo(
    () => new Set(quotas.map((q) => q.model_id)),
    [quotas]
  );

  // Have we received quotas at least once? Used to defer the is_active
  // filter on cold start so the picker isn't briefly empty before the
  // first /api/me/quotas response lands.
  const haveQuotaData = quotas.length > 0 || !quotasLoading;

  // Filter the visible model options to those supported by the active
  // provider AND marked active by the admin (is_active=1).
  const modelOptions = React.useMemo(
    () => {
      let list = listAllModels()
        .filter((m) => PROVIDER_MODELS[selectedProvider].includes(m.id));
      if (haveQuotaData) {
        list = list.filter((m) => activeModelIds.has(m.id));
      }
      return list.map((m) => ({ value: m.id, label: m.displayName }));
    },
    [selectedProvider, activeModelIds, haveQuotaData]
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

  // Snap selectedModel when it becomes invalid for either reason:
  //   1. Provider switched and the model isn't in the new provider's set.
  //   2. Admin disabled (is_active=0) the currently-selected model.
  // Pick the first model that satisfies BOTH filters so we don't snap
  // to another disabled/unsupported one.
  //
  // For (1) the toast only fires when the change was admin-driven (we
  // already track that via adminSwitchRef). For (2) the change is by
  // definition admin-driven, so the toast always fires.
  React.useEffect(() => {
    const supported = PROVIDER_MODELS[selectedProvider];
    // Until quota data lands, defer the is_active check to avoid a
    // false-positive snap on first render.
    const isActive = !haveQuotaData ? true : activeModelIds.has(selectedModel);
    const isProviderSupported = supported.includes(selectedModel);

    if (!isProviderSupported || !isActive) {
      const candidates = haveQuotaData
        ? supported.filter((id) => activeModelIds.has(id))
        : [...supported];
      const fallback = candidates[0];
      if (fallback && fallback !== selectedModel) {
        const wasAdminSwitch = adminSwitchRef.current;
        // Capture display names BEFORE setSelectedModel updates state.
        const allModels = listAllModels();
        const oldLabel =
          allModels.find((m) => m.id === selectedModel)?.displayName ?? selectedModel;
        const newLabel =
          allModels.find((m) => m.id === fallback)?.displayName ?? fallback;
        setSelectedModel(fallback);
        if (!isProviderSupported && wasAdminSwitch) {
          toast.warning(
            `Модель «${oldLabel}» недоступна для этого endpoint`,
            { description: `Вы были автоматически переключены на «${newLabel}».` }
          );
        } else if (!isActive) {
          toast.warning(
            `Модель «${oldLabel}» отключена администратором`,
            { description: `Вы были автоматически переключены на «${newLabel}».` }
          );
        }
      }
    }
    // Always reset the flag at the end of the effect, regardless of
    // whether a model swap happened. Otherwise a future user-driven
    // model change could pick up a stale flag.
    adminSwitchRef.current = false;
  }, [selectedProvider, selectedModel, setSelectedModel, activeModelIds, haveQuotaData]);

  return (
    // The top bar was removed to give the form card more vertical real estate
    // so that the Generate button is always reachable without scrolling. What
    // used to live in the top bar (theme toggle) now lives inside the form
    // card header.
    <div className="flex h-screen flex-col bg-background">
      <main className="flex min-h-0 flex-1 gap-0 p-4 md:p-6">
        {/* Left: form */}
        <section className="hidden w-full max-w-[440px] flex-shrink-0 flex-col overflow-hidden rounded-l-xl bg-muted/50 p-4 md:flex">
          <div className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border border-border bg-background shadow-md">
            {/* Card header: model picker + user menu. Theme toggle moved
                into the Настройки sidebar header (history-sidebar.tsx). The
                admin panel lives at /admin but there's no visible link to
                it — the URL is known only to the owner, and in production
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
