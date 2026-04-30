"use client";
import * as React from "react";
import { useRouter } from "next/navigation";

export interface CurrentUser {
  id: number;
  email: string;
  name: string | null;
  picture_url: string | null;
  role: "user" | "admin";
}

interface Ctx {
  user: CurrentUser | null;
  loading: boolean;
  refetch: () => Promise<void>;
}

const Context = React.createContext<Ctx | null>(null);

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<CurrentUser | null>(null);
  const [loading, setLoading] = React.useState(true);
  const router = useRouter();

  const fetchMe = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      if (res.status === 401) {
        setUser(null);
        // We're somewhere protected — middleware will redirect on next nav,
        // but pre-empt to avoid a flash of stale UI:
        if (window.location.pathname !== "/login") router.replace("/login");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setUser(await res.json());
    } catch (err) {
      console.warn("[user-provider] fetchMe failed:", err);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [router]);

  React.useEffect(() => {
    void fetchMe();
  }, [fetchMe]);

  // Refetch on user_role_changed SSE — the SSE handler in lib/history/sse.ts
  // posts to BroadcastChannel("auth") when an admin promotes/demotes the
  // current user. Without this, role-dependent UI (admin badge, /admin link)
  // would only update on next manual reload.
  React.useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel("auth");
    bc.onmessage = (ev) => {
      if (ev.data?.type === "user_role_changed") void fetchMe();
    };
    return () => bc.close();
  }, [fetchMe]);

  return (
    <Context.Provider value={{ user, loading, refetch: fetchMe }}>{children}</Context.Provider>
  );
}

export function useUser(): Ctx {
  const v = React.useContext(Context);
  if (!v) throw new Error("useUser must be used inside UserProvider");
  return v;
}
