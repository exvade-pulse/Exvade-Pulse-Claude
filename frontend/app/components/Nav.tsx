import Link from "next/link";

export function Nav() {
  return (
    <nav className="nav">
      <Link href="/">Dashboard</Link>
      <Link href="/review">Review</Link>
    </nav>
  );
}
