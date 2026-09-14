"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type ApiKey, type PaymentLink, type Workspace } from "@/lib/api";
import { useAuth } from "@/lib/useAuth";

function creditLine(ws: Workspace) {
  return `${ws.verificationCredits} / ${ws.verificationCreditsMonthly} verifications left`;
}

export default function OverviewPage() {
  const { workspace, workspaces } = useAuth();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [links, setLinks] = useState<PaymentLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace) return;
    setError(null);
    setKeys(null);
    setLinks(null);
    Promise.all([
      api<{ success: boolean; apiKeys: ApiKey[] }>(`/dashboard/${workspace.id}/api-keys`),
      api<{ success: boolean; paymentLinks: PaymentLink[] }>(`/dashboard/${workspace.id}/payment-links`),
    ])
      .then(([k, l]) => {
        setKeys(k.apiKeys);
        setLinks(l.paymentLinks);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load."));
  }, [workspace]);

  if (!workspace) {
    return (
      <>
        <h1>Overview</h1>
        <p className="muted">
          {workspaces.length === 0 ? "You are not a member of any workspace yet." : "Select a workspace."}
        </p>
      </>
    );
  }

  const activeKeys = keys?.filter((k) => k.isActive).length ?? null;
  const paidOrders = links?.reduce((sum, l) => sum + (l._count?.orders ?? 0), 0) ?? null;

  return (
    <>
      <h1>{workspace.name}</h1>
      <p className="muted">
        <span className="badge blue">{workspace.tier}</span> {creditLine(workspace)}
      </p>
      {error && <div className="error">{error}</div>}
      <div className="grid two mt">
        <div className="card">
          <span className="muted small">Active API keys</span>
          <div className="stat-num">{activeKeys ?? "…"}</div>
          <Link href="/dashboard/api-keys">Manage keys →</Link>
        </div>
        <div className="card">
          <span className="muted small">Payment links</span>
          <div className="stat-num">{links?.length ?? "…"}</div>
          <Link href="/dashboard/payment-links">Manage links →</Link>
        </div>
        <div className="card">
          <span className="muted small">Paid orders</span>
          <div className="stat-num">{paidOrders ?? "…"}</div>
        </div>
        <div className="card">
          <span className="muted small">Verify a payment</span>
          <div className="stat-num">→</div>
          <Link href="/dashboard/verify">Open manual verification →</Link>
        </div>
      </div>
    </>
  );
}
