"use client";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function LoginContent() {
  const sp = useSearchParams();
  const next = sp.get("next") ?? "/";
  const href = `/api/auth/google?next=${encodeURIComponent(next)}`;
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border bg-white dark:bg-zinc-900 p-8 shadow-sm">
        <h1 className="text-2xl font-semibold mb-2">LGen</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-6">
          Доступ выдаётся администратором по приглашению. Если у вас должен быть доступ, но его нет — напишите админу.
        </p>
        <a
          href={href}
          className="flex items-center justify-center gap-3 w-full rounded-lg border bg-white text-zinc-900 hover:bg-zinc-50 px-4 py-3 font-medium transition-colors"
        >
          {/* Inline G icon — keep simple, no external SVG asset */}
          <svg width="18" height="18" viewBox="0 0 18 18">
            <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.71v2.26h2.92a8.79 8.79 0 0 0 2.68-6.61z"/>
            <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.85-3.04.85-2.34 0-4.32-1.58-5.03-3.7H.96v2.34A9 9 0 0 0 9 18z"/>
            <path fill="#FBBC05" d="M3.97 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l3.01-2.33z"/>
            <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A8.97 8.97 0 0 0 9 0a9 9 0 0 0-8.04 4.96l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/>
          </svg>
          Войти через Google
        </a>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginContent />
    </Suspense>
  );
}
