"use client";

import { useState } from "react";
import SiteNav from "@/components/SiteNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, AlertCircle, CheckCircle2, ShieldCheck } from "lucide-react";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "https://verifier-api-selfhosted.onrender.com";

interface VerifyResult {
  success: boolean;
  provider?: string;
  error?: string;
  details?: unknown;
  data?: unknown;
}

export default function VerifyPage() {
  const [reference, setReference] = useState("");
  const [suffix, setSuffix] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/verify/public`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reference: reference.trim(),
          suffix: suffix.trim() || undefined,
          phoneNumber: phoneNumber.trim() || undefined,
        }),
      });
      const body = (await res.json()) as VerifyResult;
      if (!res.ok && !body) throw new Error(`Request failed (${res.status})`);
      setResult(body);
      if (!body.success && !body.error) setError("Verification failed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <SiteNav />
      <main className="flex-1 container mx-auto px-4 py-10 max-w-2xl">
        <div className="text-center mb-8">
          <div className="mx-auto w-12 h-12 bg-primary rounded-xl flex items-center justify-center mb-3">
            <ShieldCheck className="w-6 h-6 text-primary-foreground" />
          </div>
          <h1 className="text-3xl font-bold">Verify a payment</h1>
          <p className="text-muted-foreground mt-2">
            Enter a reference number or new CBE receipt URL to auto-detect the payment provider. No
            account needed for quick checks.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Quick check</CardTitle>
            <CardDescription>
              Supports Telebirr, CBE, CBE Birr, Dashen, Abyssinia, M-Pesa, Awash and Zemen.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="reference">Payment reference</Label>
                <Input
                  id="reference"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="e.g. Telebirr receipt no or CBE reference"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="suffix">Account suffix (optional — CBE / Abyssinia)</Label>
                <Input
                  id="suffix"
                  value={suffix}
                  onChange={(e) => setSuffix(e.target.value)}
                  placeholder="Last digits of the receiving account"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">Phone number (optional — CBE Birr)</Label>
                <Input
                  id="phone"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  placeholder="09… or 251…"
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
                Verify Transaction
              </Button>
            </form>
          </CardContent>
        </Card>

        {result && (
          <Card className="mt-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 flex-wrap">
                Result
                {result.provider && <Badge variant="secondary">{result.provider}</Badge>}
                <Badge variant={result.success ? "default" : "destructive"}>
                  {result.success ? (
                    <span className="flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> VERIFIED
                    </span>
                  ) : (
                    "FAILED"
                  )}
                </Badge>
              </CardTitle>
              {!result.success && result.error && (
                <CardDescription>{result.error}</CardDescription>
              )}
            </CardHeader>
            {result.success && (
              <CardContent>
                <pre className="bg-muted rounded-md p-4 overflow-auto text-xs max-h-96 whitespace-pre-wrap break-words">
                  {JSON.stringify(result.data ?? result, null, 2)}
                </pre>
              </CardContent>
            )}
          </Card>
        )}

        <p className="text-center text-sm text-muted-foreground mt-8">
          Need regular usage, hosted checkout or webhooks?{" "}
          <a href="/" className="underline hover:text-foreground">
            Create an account
          </a>{" "}
          ·{" "}
          <a href="/docs" className="underline hover:text-foreground">
            API docs
          </a>
        </p>
      </main>
    </div>
  );
}
