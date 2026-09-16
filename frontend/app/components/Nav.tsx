import Link from "next/link";
import type { SessionUser } from "../../lib/api";

export function Nav({ user }: { user?: SessionUser | null }) {
  return (
    <nav className="nav">
      <Link href="/">Dashboard</Link>
      <Link href="/review">Review</Link>
      <Link href="/decisions">Decisions</Link>
      <Link href="/activity">Activity</Link>
      {user?.role === "admin" && <Link href="/users">Users</Link>}
      {user?.role === "admin" && <Link href="/integrations">Integrations</Link>}
    </nav>
  );
}
