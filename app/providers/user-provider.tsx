"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

interface UserContextType {
  username: string | null;
  setUsername: (name: string) => void;
  isUsernameSet: boolean;
}

const UserContext = createContext<UserContextType>({
  username: null,
  setUsername: () => {},
  isUsernameSet: false,
});

export function useUser() {
  return useContext(UserContext);
}

// Shared with viewcomfy-claude — users who already set a nickname there
// auto-log-in here and immediately see their existing history from the
// shared SQLite DB. See CHECKPOINT-v4.
const COOKIE_NAME = "viewcomfy_username";
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(^| )${name}=([^;]+)`));
  return match ? decodeURIComponent(match[2]) : null;
}

function setCookie(name: string, value: string, maxAge: number) {
  document.cookie = `${name}=${encodeURIComponent(value)};path=/;max-age=${maxAge};SameSite=Lax`;
}

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [username, setUsernameState] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const saved = getCookie(COOKIE_NAME);
    if (saved) setUsernameState(saved);
    setLoaded(true);
  }, []);

  const setUsername = (name: string) => {
    const trimmed = name.trim();
    if (trimmed) {
      setCookie(COOKIE_NAME, trimmed, COOKIE_MAX_AGE);
      setUsernameState(trimmed);
    }
  };

  if (!loaded) return null; // avoid hydration mismatch

  return (
    <UserContext.Provider
      value={{ username, setUsername, isUsernameSet: !!username }}
    >
      {children}
    </UserContext.Provider>
  );
}
