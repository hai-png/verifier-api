"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import SiteNav from "@/components/SiteNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, AlertCircle, CheckCircle2, CreditCard } from "lucide-react";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "https://verifier-api-selfhosted.onrender.com";

interface PublicLink {
  id: string;
  name: string;
  status: string;
  fixedAmount: number;
  acceptedProviders: unknown;
  redirectUrl: string | null;
  expiresAt: string | null;
  product: {
    name: string;
    successMessage: string | null;
    deliveryUrl: string | null;
  } | null;
}

interface ConfirmOk {
  success: boolean;
  orderId: string;
  deliveryUrl: string | null;
  successMessage: string | null;
  redirectUrl: string | null;
  buyerEmailDelivery: string;
}

function Checkout() {
  const params = useSearchParams();
  // Supports both /pl?id=xxx and path-style /pl/xxx (via the /pl/* rewrite).
  const pathId =
    typeof window !== "undefined"
      ? window.location.pathname.replace(/^\/pl\/?/, "").split("/")[0]
      : "";
  const id = pathId || params.get("id") || "";
  const [link, setLink] = useState<PublicLink | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [provider, setProvider] = useState("");
  const [reference, setReference] = useState("");
  const [buyerName, setBuyerName] = useState("");
  const [buyerEmail, setBuyerEmail] = useState("");
  const [buyerPhone, setBuyerPhone] = useState("");
  const [suffix, setSuffix] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ConfirmOk | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    fetch(`${API_BASE}/payment-links/${id}/public`)
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          setLink(data.paymentLink);
          const providers = Array.isArray(data.paymentLink.acceptedProviders)
            ? (data.paymentLink.acceptedProviders as string[])
            : [];
          if (providers.length === 1) setProvider(providers[0]);
        } else {
          setLoadError(data.error ?? "Payment link not found.");
        }
      })
      .catch(() => setLoadError("Could not load this payment link."));
  }, [id]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/payment-links/${id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reference: reference.trim(),
          provider,
          buyerName: buyerName.trim(),
          buyerEmail: buyerEmail.trim(),
          buyerPhone: buyerPhone.trim() || undefined,
          suffix: suffix.trim() || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) {
        setError(body.error ?? `Payment confirmation failed (${res.status}).`);
        return;
      }
      setDone(body as ConfirmOk);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment confirmation failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!id) {
    return (
      <div className="min-h-screen bg-background flex flex-col">
        <SiteNav />
        <main className="flex-1 container mx-auto px-4 py-10 max-w-xl">
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="w-4 h-4" /> Missing payment link. Check the link you opened.
          </div>
        </main>
      </div>
    );
  }

  const providers = link && Array.isArray(link.acceptedProviders)
    ? (link.acceptedProviders as string[])
    : [];
  const needsSuffix = provider === "cbe" || provider === "abyssinia";

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <SiteNav />
      <main className="flex-1 container mx-auto px-4 py-10 max-w-xl">
        {loadError && (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="w-4 h-4" /> {loadError}
          </div>
        )}

        {done ? (
          <Card>
            <CardHeader className="text-center">
              <CheckCircle2 className="w-10 h-10 text-green-600 mx-auto mb-2" />
              <CardTitle>Payment confirmed</CardTitle>
              <CardDescription>
                {done.successMessage ?? "Thank you! Your payment was verified."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Order</span>
                <code>{done.orderId}</code>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Receipt email</span>
                <span>{done.buyerEmailDelivery === "sent" ? "sent" : "could not be sent"}</span>
              </div>
              {done.deliveryUrl && (
                <Button className="w-full" asChild>
                  <a href={done.deliveryUrl} target="_blank" rel="noreferrer">
                    Get your delivery
                  </a>
                </Button>
              )}
              {done.redirectUrl && (
                <Button variant="outline" className="w-full" asChild>
                  <a href={done.redirectUrl}>Continue</a>
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          link && (
            <>
              <div className="text-center mb-6">
                <h1 className="text-2xl font-bold">{link.product?.name ?? link.name}</h1>
                <div className="text-3xl font-extrabold mt-2">{link.fixedAmount} ETB</div>
                <div className="flex gap-1 justify-center mt-2 flex-wrap">
                  {providers.map((p) => (
                    <Badge key={p} variant="secondary" className="capitalize">
                      {p}
                    </Badge>
                  ))}
                </div>
                {link.status !== "ACTIVE" && (
                  <div className="mt-3 text-sm text-destructive">
                    This payment link is {link.status.toLowerCase()} and cannot accept payments.
                  </div>
                )}
              </div>

              {link.status === "ACTIVE" && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <CreditCard className="w-5 h-5" /> Pay now
                    </CardTitle>
                    <CardDescription>
                      Pay to the seller&apos;s account, then confirm below with your reference.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <form onSubmit={onSubmit} className="space-y-4">
                      <div className="space-y-2">
                        <Label>Paid with</Label>
                        <select
                          className="w-full border rounded-md p-2 bg-background"
                          value={provider}
                          onChange={(e) => setProvider(e.target.value)}
                          required
                        >
                          <option value="">Select provider…</option>
                          {providers.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="reference">Payment reference</Label>
                        <Input
                          id="reference"
                          value={reference}
                          onChange={(e) => setReference(e.target.value)}
                          required
                        />
                      </div>
                      {needsSuffix && (
                        <div className="space-y-2">
                          <Label htmlFor="suffix">Account suffix (last digits paid to)</Label>
                          <Input
                            id="suffix"
                            value={suffix}
                            onChange={(e) => setSuffix(e.target.value)}
                          />
                        </div>
                      )}
                      <div className="space-y-2">
                        <Label htmlFor="name">Your name</Label>
                        <Input
                          id="name"
                          value={buyerName}
                          onChange={(e) => setBuyerName(e.target.value)}
                          required
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="email">Email (receipt goes here)</Label>
                        <Input
                          id="email"
                          type="email"
                          value={buyerEmail}
                          onChange={(e) => setBuyerEmail(e.target.value)}
                          required
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="phone">Phone (optional)</Label>
                        <Input
                          id="phone"
                          value={buyerPhone}
                          onChange={(e) => setBuyerPhone(e.target.value)}
                          placeholder="09… or 251…"
                        />
                      </div>
                      {error && (
                        <div className="flex items-center gap-2 text-sm text-destructive">
                          <AlertCircle className="w-4 h-4" /> {error}
                        </div>
                      )}
                      <Button type="submit" className="w-full" disabled={busy}>
                        {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                        Confirm payment
                      </Button>
                    </form>
                  </CardContent>
                </Card>
              )}
            </>
          )
        )}
      </main>
    </div>
  );
}

export default function PlPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center text-muted-foreground">
          Loading…
        </div>
      }
    >
      <Checkout />
    </Suspense>
  );
}
