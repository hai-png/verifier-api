"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type ApiKey } from "@/lib/api";
import { useAuth } from "@/lib/useAuth";

export default function ApiKeysPage() {
  const { workspace } = useAuth();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ success: boolean; apiKeys: ApiKey[] }>(
        `/dashboard/${workspace.id}/api-keys`
      );
      setKeys(res.apiKeys);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load API keys.");
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createKey() {
    if (!workspace) return;
    setBusy(true);
    setError(null);
    setNewKey(null);
    setCopied(false);
    try {
      const res = await api<{ success: boolean; apiKey: { key: string } }>(
        `/dashboard/${workspace.id}/api-keys`,
        { method: "POST", body: JSON.stringify({}) }
      );
      setNewKey(res.apiKey.key);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create API key.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeKey(keyId: string) {
    if (!workspace) return;
    if (!window.confirm("Revoke this API key? Integrations using it will stop working.")) return;
    try {
      await api(`/dashboard/${workspace.id}/api-keys/${keyId}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to revoke API key.");
    }
  }

  async function copyKey() {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      <h1>API keys</h1>
      <p className="muted">Keys authenticate your integrations (send as <code>x-api-key</code> header).</p>
      {error && <div className="error">{error}</div>}
      {newKey && (
        <div className="success-box">
          <strong>Copy this key now — you will not see it again.</strong>
          <br />
          <code>{newKey}</code>
          <div className="mt">
            <button className="secondary small-btn" onClick={() => void copyKey()}>
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
      )}
      <div className="mt">
        <button onClick={() => void createKey()} disabled={busy || !workspace}>
          {busy ? "Creating…" : "Create API key"}
        </button>
      </div>
      <div className="card mt">
        {loading ? (
          <p className="muted">Loading…</p>
        ) : keys.length === 0 ? (
          <p className="muted">No API keys yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Prefix</th>
                <th>Status</th>
                <th>Uses</th>
                <th>Last used</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td><code className="small">{k.prefix ?? k.id.slice(0, 12)}</code></td>
                  <td>
                    <span className={`badge ${k.isActive ? "green" : "red"}`}>
                      {k.isActive ? "active" : "revoked"}
                    </span>
                  </td>
                  <td>{k.usageCount}</td>
                  <td className="small">{k.lastUsed ? new Date(k.lastUsed).toLocaleString() : "—"}</td>
                  <td>
                    {k.isActive && (
                      <button className="danger small-btn" onClick={() => void revokeKey(k.id)}>
                        Revoke
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
