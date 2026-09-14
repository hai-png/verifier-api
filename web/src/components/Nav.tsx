"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/useAuth";

const TABS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/verify", label: "Verify" },
  { href: "/dashboard/api-keys", label: "API Keys" },
  { href: "/dashboard/payouts", label: "Payouts" },
  { href: "/dashboard/payment-links", label: "Payment Links" },
  { href: "/dashboard/webhooks", label: "Webhooks" },
];

export default function Nav() {
  const pathname = usePathname();
  const { workspaces, workspace, selectWorkspace, logout, user } = useAuth();

  return (
    <nav className="nav">
      <Link className="brand" href="/dashboard">
        Veritas
      </Link>
      {TABS.map((t) => (
        <Link
          key={t.href}
          className={`tab${pathname === t.href || pathname === `${t.href}/` ? " active" : ""}`}
          href={t.href}
        >
          {t.label}
        </Link>
      ))}
      <span className="spacer" />
      {workspaces.length > 0 && (
        <select
          value={workspace?.id ?? ""}
          onChange={(e) => selectWorkspace(e.target.value)}
          aria-label="Workspace"
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      )}
      {user?.email && <span className="muted small">{user.email}</span>}
      <button className="secondary small-btn" onClick={() => void logout()}>
        Log out
      </button>
    </nav>
  );
}
