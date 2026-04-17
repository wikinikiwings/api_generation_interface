import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function shortId(id: string, len = 8): string {
  return id.length > len ? `${id.slice(0, len)}…` : id;
}

/**
 * Downscale an image File to a data URL suitable for thumbnails (history).
 * Keeps aspect ratio, max dimension = maxSize px.
 */
export async function fileToThumbnail(
  file: File,
  maxSize = 240,
  quality = 0.8
): Promise<string> {
  const dataUrl = await fileToDataURL(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > height) {
        if (width > maxSize) {
          height = Math.round((height * maxSize) / width);
          width = maxSize;
        }
      } else if (height > maxSize) {
        width = Math.round((width * maxSize) / height);
        height = maxSize;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("Canvas ctx unavailable"));
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => reject(new Error("Image load failed"));
    img.src = dataUrl;
  });
}

export function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Read failed"));
    reader.readAsDataURL(file);
  });
}

/**
 * Generate a canonical RFC-4122 v4 UUID string.
 *
 * Tries `crypto.randomUUID` first (secure-context only — HTTPS or
 * localhost). Falls back to `crypto.getRandomValues` (Web Crypto,
 * available everywhere) with manual v4 formatting. Final fallback
 * uses `Math.random` — not cryptographically strong, but the output
 * is still RFC-compliant so it passes the server's uuid regex.
 *
 * We need valid v4 shape because `app/api/history/route.ts` validates
 * submitted uuids against /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.
 */
export function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  // Use a local alias to escape TypeScript's narrowing — at this point
  // crypto is defined but `randomUUID` is absent (non-secure context).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _crypto: any = typeof crypto !== "undefined" ? crypto : undefined;
  if (_crypto && typeof _crypto.getRandomValues === "function") {
    _crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = (Math.random() * 256) | 0;
  }
  // Set version (4) and variant (10) bits per RFC-4122.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20, 32)
  );
}

/** Format execution time in ms as "Xm Ys" (e.g. "2m 7s", "0m 13s"). */
export function fromMsToTime(ms: number): string {
  if (!ms || ms < 0) return "0m 0s";
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

/** Format a timestamp as "D/M/YYYY HH:MM:SS" matching viewcomfy style. */
export function formatFullDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Start of today (local) as ms timestamp. */
export function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Copy text to clipboard with a robust fallback for non-secure contexts.
 *
 * The modern `navigator.clipboard.writeText` API is only available in
 * secure contexts (HTTPS or localhost/127.0.0.1). On a LAN dev URL like
 * `http://192.168.x.x:3000` it is undefined, and we fall through to
 * `execCommand("copy")` on a temporary textarea.
 *
 * The fallback appends the textarea inside the currently-open Radix
 * Dialog if there is one (not `document.body`). Radix's FocusScope
 * on an open dialog traps focus — appending to body lets Radix bounce
 * focus back inside the dialog the moment `ta.focus()` fires, which
 * drops the textarea's selection. `execCommand("copy")` then returns
 * `true` (command dispatched) but copies nothing, and the caller sees
 * a successful toast with an empty clipboard. Appending inside the
 * dialog keeps the textarea within the focus scope so the selection
 * actually sticks.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    navigator.clipboard?.writeText
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or document not focused — fall through.
    }
  }

  try {
    const host =
      document.querySelector<HTMLElement>('[role="dialog"]') ?? document.body;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";
    host.appendChild(ta);
    ta.focus();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    host.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
