"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, PROVIDERS, type PaymentLink } from "@/lib/api";
import { useAuth } from "@/lib/useAuth";

export default function PaymentLinksPage() {
  const { workspace } = useAuth();
  const [links, setLinks] = useState<PaymentLink[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [providers, setProviders] = useState<string[]>(["telebirr"]);
  const [redirectUrl, setRedirectUrl] = useState("");

  const load = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ success: boolean; paymentLinks: PaymentLink[] }>(
        `/dashboard/${workspace.id}/payment-links`
      );
      setLinks(res.paymentLinks);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load payment links.");
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleProvider(p: string) {
    setProviders((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!workspace) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/dashboard/${workspace.id}/payment-links`, {
        method: "POST",
        body: JSON.stringify({
          name,
          fixedAmount: Number(amount),
          acceptedProviders: providers,
          redirectUrl: redirectUrl || undefined,
        }),
      });
      setName("");
      setAmount("");
      setRedirectUrl("");
      setProviders(["telebirr"]);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create payment link.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Payment links</h1>
      <p className="muted">Shareable checkout links with a fixed amount.</p>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <h2>New payment link</h2>
        <form onSubmit={onCreate}>
          <label htmlFor="name">Name</label>
          <input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
          <label htmlFor="amount">Fixed amount (ETB)</label>
          <input
            id="amount"
            type="number"
            min="1"
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
          <label>Accepted providers</label>
          <div className="checkbox-row">
            {PROVIDERS.map((p) => (
              <label key={p}>
                <input type="checkbox" checked={providers.includes(p)} onChange={() => toggleProvider(p)} />
                {p}
              </label>
            ))}
          </div>
          <label htmlFor="redirect">Redirect URL (optional)</label>
          <input
            id="redirect"
            type="url"
            value={redirectUrl}
            onChange={(e) => setRedirectUrl(e.target.value)}
            placeholder="https://…"
          />
          <div className="mt">
            <button type="submit" disabled={busy || !workspace}>
              {busy ? "Creating…" : "Create link"}
            </button>
          </div>
        </form>
      </div>
      <div className="card mt">
        {loading ? (
          <p className="muted">Loading…</p>
        ) : links.length === 0 ? (
          <p className="muted">No payment links yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Amount</th>
                <th>Providers</th>
                <th>Status</th>
                <th>Paid orders</th>
              </tr>
            </thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.id}>
                  <td>{l.name}</td>
                  <td>{l.fixedAmount} ETB</td>
                  <td className="small">
                    {Array.isArray(l.acceptedProviders)
                      ? (l.acceptedProviders as string[]).join(", ")
                      : "—"}
                  </td>
                  <td>
                    <span className={`badge ${l.status === "ACTIVE" ? "green" : "red"}`}>
                      {l.status}
                    </span>
                  </td>
                  <td>{l._count?.orders ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
