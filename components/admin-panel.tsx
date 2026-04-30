"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  LogOut,
  CheckCircle2,
  XCircle,
  CircleDashed,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useSettingsStore } from "@/stores/settings-store";
import { StylesSection } from "@/components/admin/styles-section";
import { UsersTab } from "@/components/admin/users-tab";
import { ModelsTab } from "@/components/admin/models-tab";
import type { ProviderId } from "@/lib/providers/types";
import type { ProviderMeta } from "@/lib/providers/registry";

/**
 * Admin panel UI.
 *
 * Currently shows:
 *   - Active provider picker (with configured / not-configured status)
 *   - Header with "back to main" link + logout button
 *   - Placeholder for future settings
 *
 * The provider list is fetched from /api/providers on mount (client-safe
 * endpoint, does not leak any API keys). Selecting a provider writes to
 * the settings store (localStorage), and the main form reads from the
 * same store so the change is instantly reflected when you navigate back.
 */
export function AdminPanel() {
  const selectedProvider = useSettingsStore((s) => s.selectedProvider);
  const updateSelectedProvider = useSettingsStore((s) => s.updateSelectedProvider);

  const [providers, setProviders] = React.useState<ProviderMeta[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [loggingOut, setLoggingOut] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<"settings" | "styles" | "users" | "models">("settings");

  // Fetch provider metadata on mount
  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/providers", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { providers: ProviderMeta[] };
        if (!cancelled) setProviders(data.providers);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "unknown error";
        setLoadError(msg);
        toast.error(`Не удалось загрузить провайдеров: ${msg}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelectProvider = async (id: ProviderId) => {
    if (id === selectedProvider) return;
    const name =
      providers?.find((p) => p.id === id)?.displayName ?? id;
    try {
      await updateSelectedProvider(id);
      toast.success(`Активный провайдер: ${name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      toast.error(`Не удалось сохранить: ${msg}`);
    }
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      // Full page navigation so cookies are re-read and middleware
      // re-evaluates access on the next request.
      window.location.href = "/";
    } catch (err) {
      console.error(err);
      toast.error("Ошибка при выходе");
      setLoggingOut(false);
    }
  };

  function SettingsContent() {
    return (
      <section className="rounded-xl border border-border bg-background shadow-sm">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold">Активный провайдер</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Выбранный провайдер используется для всех новых генераций.
            Провайдеры без галочки не настроены — добавь их API-ключ в{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
              .env.local
            </code>{" "}
            и перезапусти dev-сервер.
          </p>
        </div>

        <div className="p-2">
          {loading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Загрузка провайдеров...
            </div>
          ) : loadError || !providers ? (
            <div className="p-4 text-sm text-destructive">
              Ошибка загрузки: {loadError ?? "unknown"}
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {providers.map((provider) => {
                const isSelected = selectedProvider === provider.id;
                const isAvailable =
                  provider.isImplemented && provider.isConfigured;

                return (
                  <li key={provider.id}>
                    <button
                      type="button"
                      disabled={!isAvailable}
                      onClick={() => handleSelectProvider(provider.id)}
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors ${
                        isSelected ? "bg-primary/10" : "hover:bg-muted/60"
                      } ${
                        !isAvailable
                          ? "cursor-not-allowed opacity-60"
                          : "cursor-pointer"
                      }`}
                    >
                      {/* Radio indicator */}
                      <div className="flex h-5 w-5 shrink-0 items-center justify-center">
                        {isSelected ? (
                          <div className="h-4 w-4 rounded-full border-2 border-primary bg-primary shadow-sm" />
                        ) : (
                          <div className="h-4 w-4 rounded-full border-2 border-muted-foreground/40" />
                        )}
                      </div>

                      {/* Name + model */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">
                            {provider.displayName}
                          </span>
                          <span className="rounded-full border border-border px-1.5 py-0 text-[9px] uppercase tracking-wider text-muted-foreground">
                            {provider.isAsync ? "async" : "sync"}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          {provider.modelLabel}
                        </div>
                      </div>

                      {/* Status */}
                      <div className="flex shrink-0 items-center">
                        {!provider.isImplemented ? (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <CircleDashed className="h-4 w-4" />
                            не реализовано
                          </span>
                        ) : provider.isConfigured ? (
                          <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-500">
                            <CheckCircle2 className="h-4 w-4" />
                            configured
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
                            <XCircle className="h-4 w-4" />
                            no key
                          </span>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    );
  }

  const tabs: { key: "settings" | "styles" | "users" | "models"; label: string }[] = [
    { key: "settings", label: "Settings" },
    { key: "styles", label: "Styles" },
    { key: "users", label: "Users" },
    { key: "models", label: "Модели" },
  ];

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6 md:p-10">
      {/* Header */}
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Админка</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Настройки провайдеров и приложения
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/"
            className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ArrowLeft className="h-4 w-4" />
            К студии
          </Link>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            disabled={loggingOut}
          >
            {loggingOut ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <LogOut className="h-4 w-4" />
            )}
            Выйти
          </Button>
        </div>
      </header>

      {/* Tab strip */}
      <div className="flex gap-1 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium rounded-t-md transition-colors ${
              activeTab === tab.key
                ? "bg-primary/10 text-primary border-b-2 border-primary"
                : "text-muted-foreground hover:bg-muted/60"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "settings" && <SettingsContent />}
      {activeTab === "styles" && <StylesSection />}
      {activeTab === "users" && <UsersTab />}
      {activeTab === "models" && <ModelsTab />}
    </div>
  );
}
