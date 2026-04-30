"use client";
import * as React from "react";
import Link from "next/link";
import { useUser } from "@/app/providers/user-provider";

export function HeaderUserMenu() {
  const { user } = useUser();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  if (!user) return null;

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  const initial = (user.name ?? user.email)[0]?.toUpperCase() ?? "?";

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-900 px-2 py-1"
      >
        {user.picture_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.picture_url} alt="" className="w-7 h-7 rounded-full" />
        ) : (
          <span className="w-7 h-7 rounded-full bg-zinc-200 dark:bg-zinc-700 grid place-items-center text-xs font-medium">
            {initial}
          </span>
        )}
        <span className="text-sm hidden sm:inline">{user.name ?? user.email}</span>
        {user.role === "admin" && (
          <span className="text-[10px] uppercase font-semibold tracking-wide bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 px-1.5 py-0.5 rounded">
            admin
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-56 rounded-lg border bg-white dark:bg-zinc-900 shadow-lg p-1 z-50">
          <div className="px-3 py-2 text-xs text-zinc-500 truncate">{user.email}</div>
          {user.role === "admin" && (
            <Link href="/admin" className="block px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded">
              Админка
            </Link>
          )}
          <button onClick={logout} className="block w-full text-left px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded">
            Выйти
          </button>
        </div>
      )}
    </div>
  );
}
