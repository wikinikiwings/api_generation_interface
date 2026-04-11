"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/select";

/**
 * /admin/login — password entry page.
 *
 * Publicly accessible (middleware explicitly skips auth for this path).
 * On successful login, redirects to the `next` query param (or /admin
 * by default).
 *
 * Note: we read the `next` query param via `window.location.search` inside
 * a useEffect instead of using Next.js `useSearchParams`. This avoids the
 * CSR bailout requirement that Next 15 enforces on pages using
 * useSearchParams (which would otherwise need a <Suspense> boundary).
 * Since the `next` param is just a convenience (default is /admin),
 * reading it post-hydration is fine.
 */
export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [nextPath, setNextPath] = React.useState("/admin");

  React.useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const next = params.get("next");
      if (next && next.startsWith("/admin")) {
        setNextPath(next);
      }
    } catch {
      // ignore
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || !password) return;
    setSubmitting(true);

    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        // Full navigation so middleware re-evaluates on the next request
        // with the freshly-set cookie. router.push + router.refresh also
        // works but this is more reliable for cookie-driven auth.
        window.location.href = nextPath;
      } else {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        toast.error(body.error ?? `Ошибка ${res.status}`);
        setPassword("");
        setSubmitting(false);
      }
    } catch (err) {
      console.error(err);
      toast.error("Сетевая ошибка при логине");
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-xl border border-border bg-background p-6 shadow-md"
      >
        <h1 className="mb-1 text-xl font-semibold">Админка</h1>
        <p className="mb-5 text-sm text-muted-foreground">
          Введи пароль из{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
            ADMIN_PASSWORD
          </code>{" "}
          чтобы получить доступ к настройкам.
        </p>

        <div className="space-y-2">
          <Label htmlFor="password">Пароль</Label>
          <input
            id="password"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>

        <Button
          type="submit"
          className="mt-5 w-full"
          disabled={submitting || !password}
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Проверяем...
            </>
          ) : (
            "Войти"
          )}
        </Button>
      </form>
    </div>
  );
}
