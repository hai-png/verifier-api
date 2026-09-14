"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/useAuth";

interface VerifyResult {
  success: boolean;
  provider?: string;
  error?: string;
  details?: unknown;
  data?: unknown;
}

export default function VerifyPage() {
  const { workspace } = useAuth();
  const [reference, setReference] = useState("");
  const [suffix, setSuffix] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!workspace) return;
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const res = await api<VerifyResult>(`/dashboard/${workspace.id}/verify`, {
        method: "POST",
        body: JSON.stringify({
          reference: reference.trim(),
          suffix: suffix.trim() || undefined,
          phoneNumber: phoneNumber.trim() || undefined,
        }),
      });
      setResult(res);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Verification failed.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Manual verification</h1>
      <p className="muted">
        Look up a payment by reference. Each lookup uses one verification credit (workspace:{" "}
        {workspace?.name ?? "—"}).
      </p>
      <div className="card">
        <form onSubmit={onSubmit}>
          <label htmlFor="reference">Payment reference</label>
          <input
            id="reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="e.g. Telebirr receipt no, CBE reference…"
            required
          />
          <label htmlFor="suffix">Account suffix (optional — CBE / Abyssinia)</label>
          <input
            id="suffix"
            value={suffix}
            onChange={(e) => setSuffix(e.target.value)}
            placeholder="Last digits of the receiving account"
          />
          <label htmlFor="phone">Phone number (optional — CBE Birr)</label>
          <input
            id="phone"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder="09… or 251…"
          />
          {error && <div className="error">{error}</div>}
          <div className="mt">
            <button type="submit" disabled={busy || !workspace}>
              {busy ? "Verifying…" : "Verify payment"}
            </button>
          </div>
        </form>
      </div>
      {result && (
        <div className="card mt">
          <h2>
            Result {result.provider && <span className="badge blue">{result.provider}</span>}{" "}
            <span className={`badge ${result.success ? "green" : "red"}`}>
              {result.success ? "VERIFIED" : "FAILED"}
            </span>
          </h2>
          <pre className="result">{JSON.stringify(result.data ?? result, null, 2)}</pre>
        </div>
      )}
    </>
  );
}
