"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CreditCard, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
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
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto w-12 h-12 bg-primary rounded-xl flex items-center justify-center mb-2">
            <CreditCard className="w-6 h-6 text-primary-foreground" />
          </div>
          <CardTitle className="text-2xl">Forgot password</CardTitle>
          <CardDescription>We&apos;ll email you a reset link.</CardDescription>
        </CardHeader>
        <CardContent>
          {done ? (
            <div className="flex items-start gap-2 text-sm">
              <CheckCircle2 className="w-4 h-4 mt-0.5 text-green-600" />
              <span>
                If an account exists for that email, a password reset link has been sent. The link
                expires in 30 minutes.
              </span>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                />
              </div>
              {error && (
                <div className="flex items-center gap-2 text-sm text-destructive">
                  <AlertCircle className="w-4 h-4" />
                  {error}
                </div>
              )}
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Send reset link
              </Button>
            </form>
          )}
          <div className="text-center text-sm mt-4">
            <a href="/" className="text-muted-foreground underline hover:text-foreground">
              Back to login
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
