"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Webhook } from "@/lib/api";
import { useAuth } from "@/lib/useAuth";

const EVENTS = [
  "order.paid",
  "payment-link.created",
  "verification.completed",
  "notification.test",
];

export default function WebhooksPage() {
  const { workspace } = useAuth();
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["order.paid"]);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ success: boolean; webhooks: Webhook[] }>(
        `/dashboard/${workspace.id}/webhooks`
      );
      setHooks(res.webhooks);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load webhooks.");
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleEvent(ev: string) {
    setEvents((prev) => (prev.includes(ev) ? prev.filter((x) => x !== ev) : [...prev, ev]));
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!workspace) return;
    setBusy(true);
    setError(null);
    setNewSecret(null);
    try {
      const res = await api<{ success: boolean; webhook: Webhook & { signingSecret?: string } }>(
        `/dashboard/${workspace.id}/webhooks`,
        { method: "POST", body: JSON.stringify({ url, events }) }
      );
      if (res.webhook.signingSecret) setNewSecret(res.webhook.signingSecret);
      setUrl("");
      setEvents(["order.paid"]);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create webhook.");
    } finally {
      setBusy(false);
    }
  }

  async function deactivate(id: string) {
    if (!workspace) return;
    try {
      await api(`/dashboard/${workspace.id}/webhooks/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to deactivate webhook.");
    }
  }

  return (
    <>
      <h1>Webhooks</h1>
      <p className="muted">Get notified at your URL when events happen in this workspace.</p>
      {error && <div className="error">{error}</div>}
      {newSecret && (
        <div className="success-box">
          <strong>Signing secret (show once — store it securely):</strong>
          <br />
          <code>{newSecret}</code>
        </div>
      )}
      <div className="card">
        <h2>New webhook</h2>
        <form onSubmit={onCreate}>
          <label htmlFor="url">Endpoint URL</label>
          <input
            id="url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            required
          />
          <label>Events</label>
          <div className="checkbox-row">
            {EVENTS.map((ev) => (
              <label key={ev}>
                <input type="checkbox" checked={events.includes(ev)} onChange={() => toggleEvent(ev)} />
                {ev}
              </label>
            ))}
          </div>
          <div className="mt">
            <button type="submit" disabled={busy || !workspace}>
              {busy ? "Creating…" : "Create webhook"}
            </button>
          </div>
        </form>
      </div>
      <div className="card mt">
        {loading ? (
          <p className="muted">Loading…</p>
        ) : hooks.length === 0 ? (
          <p className="muted">No webhooks yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>URL</th>
                <th>Events</th>
                <th>Status</th>
                <th>Deliveries</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {hooks.map((h) => (
                <tr key={h.id}>
                  <td className="small"><code>{h.url}</code></td>
                  <td className="small">
                    {Array.isArray(h.events) ? (h.events as string[]).join(", ") : String(h.events)}
                  </td>
                  <td>
                    <span className={`badge ${h.active ? "green" : "red"}`}>
                      {h.active ? "active" : "inactive"}
                    </span>
                  </td>
                  <td>{h._count?.deliveries ?? "—"}</td>
                  <td>
                    {h.active && (
                      <button className="danger small-btn" onClick={() => void deactivate(h.id)}>
                        Deactivate
                      </button>
                    )}
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
