"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, setToken, ApiError } from "@/lib/api";

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ success: boolean; token: string }>("/auth/signup", {
        method: "POST",
        body: JSON.stringify({ email, password, name: name || undefined }),
      });
      setToken(res.token);
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Signup failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="narrow">
      <h1>Sign up</h1>
      <p className="muted">Create your account — a workspace with 100 free verifications is included.</p>
      <form onSubmit={onSubmit}>
        <label htmlFor="name">Name (optional)</label>
        <input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <label htmlFor="password">Password (min 8 characters)</label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
        />
        {error && <div className="error">{error}</div>}
        <div className="mt">
          <button type="submit" disabled={busy}>
            {busy ? "Creating account…" : "Sign up"}
          </button>
        </div>
      </form>
      <p className="small mt">
        Already have an account? <Link href="/login">Log in</Link>
      </p>
    </div>
  );
}
