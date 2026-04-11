/**
 * @deprecated
 *
 * The top bar was removed in the UI refactor (CHECKPOINT-v3+) to give the
 * form card more vertical real estate so that the Generate button is always
 * reachable without scrolling. The ThemeToggle that used to live here has
 * been moved into the form card header (`components/playground.tsx`).
 *
 * This file is kept as an empty stub only to avoid breaking any stray import
 * that might still reference it. It renders nothing. You can safely delete
 * this file when you're confident nothing imports it.
 */
export function TopBar() {
  return null;
}
