"use client";

import { useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="narrow">
      <h1>Forgot password</h1>
      {done ? (
        <>
          <div className="success-box">
            If an account exists for that email, a password reset link has been sent. The link expires
            in 30 minutes.
          </div>
          <p className="small">
            <Link href="/login">Back to login</Link>
          </p>
        </>
      ) : (
        <>
          <p className="muted">Enter your account email and we&apos;ll send you a reset link.</p>
          <form onSubmit={onSubmit}>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            {error && <div className="error">{error}</div>}
            <div className="mt">
              <button type="submit" disabled={busy}>
                {busy ? "Sending…" : "Send reset link"}
              </button>
            </div>
          </form>
          <p className="small mt">
            <Link href="/login">Back to login</Link>
          </p>
        </>
      )}
    </div>
  );
}
