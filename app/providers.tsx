"use client";

import * as React from "react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import { UserProvider } from "@/app/providers/user-provider";
import { QuotasProvider } from "@/app/providers/quotas-provider";
import { useSettingsStore } from "@/stores/settings-store";

export function Providers({ children }: { children: React.ReactNode }) {
  // Hydrate the global settings store from /api/settings on mount.
  // This runs exactly once per page load, regardless of which route
  // the user lands on (home, /admin, etc.) because Providers wraps
  // the entire app. Until hydration completes, the store keeps its
  // default ("wavespeed") so the form is still usable.
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  React.useEffect(() => {
    void hydrateSettings();
  }, [hydrateSettings]);

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      <UserProvider>
        <QuotasProvider>
          {children}
        </QuotasProvider>
      </UserProvider>
      <Toaster
        position="top-right"
        richColors
        closeButton
        theme="system"
        toastOptions={{
          style: {
            background: "hsl(var(--card))",
            color: "hsl(var(--card-foreground))",
            border: "1px solid hsl(var(--border))",
          },
        }}
      />
    </ThemeProvider>
  );
}
