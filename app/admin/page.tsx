import { AdminPanel } from "@/components/admin-panel";

/**
 * /admin — main admin page.
 *
 * This is a server component that just mounts the client-side AdminPanel.
 * Auth is enforced by middleware.ts at the root — if the user reaches
 * this page, they've already passed the auth check.
 */
export default function AdminPage() {
  return <AdminPanel />;
}
