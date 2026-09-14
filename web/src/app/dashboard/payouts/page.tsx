"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, PROVIDERS, type PayoutAccount } from "@/lib/api";
import { useAuth } from "@/lib/useAuth";

export default function PayoutsPage() {
  const { workspace } = useAuth();
  const [accounts, setAccounts] = useState<PayoutAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [holder, setHolder] = useState("");
  const [type, setType] = useState<"PHONE" | "BANK">("PHONE");
  const [account, setAccount] = useState("");
  const [providers, setProviders] = useState<string[]>(["telebirr"]);

  const load = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ success: boolean; payouts: PayoutAccount[] }>(
        `/dashboard/${workspace.id}/payouts`
      );
      setAccounts(res.payouts);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load payout accounts.");
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
      await api(`/dashboard/${workspace.id}/payouts`, {
        method: "POST",
        body: JSON.stringify({
          label,
          accountHolderName: holder,
          type,
          account,
          providersAllowed: providers,
        }),
      });
      setLabel("");
      setHolder("");
      setAccount("");
      setProviders(["telebirr"]);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create payout account.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!workspace) return;
    if (!window.confirm("Remove this payout account?")) return;
    try {
      await api(`/dashboard/${workspace.id}/payouts/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to remove payout account.");
    }
  }

  return (
    <>
      <h1>Payout accounts</h1>
      <p className="muted">Destinations where verified payments land. One account per provider.</p>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <h2>Add payout account</h2>
        <form onSubmit={onCreate}>
          <label htmlFor="label">Label</label>
          <input id="label" value={label} onChange={(e) => setLabel(e.target.value)} required placeholder="Main Telebirr" />
          <label htmlFor="holder">Account holder name</label>
          <input id="holder" value={holder} onChange={(e) => setHolder(e.target.value)} required />
          <label htmlFor="type">Type</label>
          <select id="type" value={type} onChange={(e) => setType(e.target.value as "PHONE" | "BANK")}>
            <option value="PHONE">Phone (mobile money)</option>
            <option value="BANK">Bank account</option>
          </select>
          <label htmlFor="account">Account number</label>
          <input id="account" value={account} onChange={(e) => setAccount(e.target.value)} required />
          <label>Providers</label>
          <div className="checkbox-row">
            {PROVIDERS.map((p) => (
              <label key={p}>
                <input type="checkbox" checked={providers.includes(p)} onChange={() => toggleProvider(p)} />
                {p}
              </label>
            ))}
          </div>
          <div className="mt">
            <button type="submit" disabled={busy || !workspace}>
              {busy ? "Adding…" : "Add account"}
            </button>
          </div>
        </form>
      </div>
      <div className="card mt">
        {loading ? (
          <p className="muted">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="muted">No payout accounts yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Holder</th>
                <th>Account</th>
                <th>Providers</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.label}{" "}
                    {a.isDefault && <span className="badge blue">default</span>}
                  </td>
                  <td>{a.accountHolderName ?? "—"}</td>
                  <td><code className="small">{a.account}</code></td>
                  <td className="small">
                    {Array.isArray(a.providersAllowed) ? (a.providersAllowed as string[]).join(", ") : "—"}
                  </td>
                  <td>
                    <button className="danger small-btn" onClick={() => void remove(a.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
