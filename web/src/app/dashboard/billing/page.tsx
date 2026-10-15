"use client";

/**
 * Plan & billing page.
 *
 * Every 402 the API returns — quota exhausted, image credits exhausted, batch
 * not included in the plan — links here (`{APP_URL}/dashboard/billing`). That
 * URL 404'd until this page existed, so the one moment a customer is told to
 * upgrade led nowhere. There is no self-serve checkout: upgrades and unlimited
 * grants are performed by the operator through the admin API, so this page's
 * job is to show the current state precisely and say exactly what to send.
 */

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertCircle, ArrowLeft, Check, Copy, Loader2, Sparkles } from "lucide-react";
import { API_URL } from "@/lib/api";

interface WorkspacePlan {
  id: string;
  name: string;
  tier: string;
  verificationCredits: number;
  verificationCreditsMonthly: number;
  verificationCreditsUnlimited: boolean;
  imageCredits: number;
  imageCreditsMonthly: number;
  imageCreditsUnlimited: boolean;
  paidUntil?: string | null;
  role?: string;
}

interface MeResponse {
  success: boolean;
  user: { id: string; email: string | null; name: string | null };
  workspaces: WorkspacePlan[];
}

const PLAN_ROWS: { label: string; free: string; pro: string; business: string }[] = [
  { label: "Monthly verifications", free: "100", pro: "2,000", business: "50,000" },
  { label: "Rate limit (req/min)", free: "10", pro: "60", business: "300" },
  { label: "Image verifications / month", free: "0", pro: "100", business: "300" },
  { label: "Batch max references", free: "—", pro: "20", business: "100" },
  { label: "Webhooks", free: "—", pro: "20", business: "50" },
  { label: "Notification channels", free: "—", pro: "—", business: "20" },
];

const TIER_RANK: Record<string, number> = { FREE: 0, PRO: 1, BUSINESS: 2 };

function creditLine(
  unlimited: boolean,
  remaining: number,
  monthly: number,
): string {
  if (unlimited) return "Unlimited";
  if (monthly > 0) return `${remaining.toLocaleString()} of ${monthly.toLocaleString()} / month left`;
  return `${remaining.toLocaleString()} remaining`;
}

export default function BillingPage() {
  const [state, setState] = useState<"loading" | "signed-out" | "error" | "ready">("loading");
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(() => {
    const token = typeof window !== "undefined" ? localStorage.getItem("noveld_token") : null;
    if (!token) {
      setState("signed-out");
      return;
    }
    setState("loading");
    setError(null);
    fetch(`${API_URL}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (res) => {
        if (res.status === 401) {
          localStorage.removeItem("noveld_token");
          setState("signed-out");
          return null;
        }
        if (!res.ok) throw new Error(`Could not load your plan (HTTP ${res.status}).`);
        return (await res.json()) as MeResponse;
      })
      .then((data) => {
        if (!data) return;
        if (!data.success) throw new Error("Could not load your plan.");
        setMe(data);
        setState("ready");
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Could not load your plan.");
        setState("error");
      });
  }, []);

  useEffect(() => { load(); }, [load]);

  const copyWorkspaceId = (id: string) => {
    navigator.clipboard.writeText(id);
    setCopied(id);
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-muted">
      <div className="max-w-3xl mx-auto p-4 md:p-8 space-y-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => { window.location.href = "/"; }}>
            <ArrowLeft className="w-4 h-4 mr-1" />
            Dashboard
          </Button>
          <h1 className="text-2xl font-bold">Plans &amp; billing</h1>
        </div>

        {state === "loading" && (
          <div className="flex justify-center py-16">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        )}

        {state === "signed-out" && (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center space-y-3">
              <AlertCircle className="w-10 h-10 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Sign in to see your plan and usage.
              </p>
              <Button onClick={() => { window.location.href = "/"; }}>Sign in</Button>
            </CardContent>
          </Card>
        )}

        {state === "error" && (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center space-y-3">
              <AlertCircle className="w-10 h-10 text-destructive" />
              <p className="text-sm text-destructive">{error}</p>
              <Button variant="outline" size="sm" onClick={load}>Try again</Button>
            </CardContent>
          </Card>
        )}

        {state === "ready" && me && (
          <>
            <div className="space-y-3">
              <h2 className="text-lg font-semibold">Your workspaces</h2>
              {me.workspaces.length === 0 && (
                <Card>
                  <CardContent className="py-8 text-center text-sm text-muted-foreground">
                    You do not belong to any workspace yet.
                  </CardContent>
                </Card>
              )}
              {me.workspaces.map((ws) => (
                <Card key={ws.id}>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <CardTitle className="text-base">{ws.name}</CardTitle>
                      <div className="flex items-center gap-1">
                        <Badge variant="secondary">{ws.tier}</Badge>
                        {ws.verificationCreditsUnlimited && (
                          <Badge variant="outline" className="border-green-600 text-green-700">
                            unlimited verifications
                          </Badge>
                        )}
                        {ws.imageCreditsUnlimited && (
                          <Badge variant="outline" className="border-green-600 text-green-700">
                            unlimited images
                          </Badge>
                        )}
                      </div>
                    </div>
                    <CardDescription className="flex items-center gap-2">
                      <code className="text-xs">{ws.id}</code>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        title="Copy workspace ID"
                        onClick={() => copyWorkspaceId(ws.id)}
                      >
                        {copied === ws.id
                          ? <Check className="w-3.5 h-3.5" />
                          : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Verifications</span>
                      <span className="font-medium">
                        {creditLine(ws.verificationCreditsUnlimited, ws.verificationCredits, ws.verificationCreditsMonthly)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Image verifications</span>
                      <span className="font-medium">
                        {creditLine(ws.imageCreditsUnlimited, ws.imageCredits, ws.imageCreditsMonthly)}
                      </span>
                    </div>
                    {ws.paidUntil && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Paid until</span>
                        <span className="font-medium">{new Date(ws.paidUntil).toLocaleDateString()}</span>
                      </div>
                    )}
                    {(TIER_RANK[ws.tier] ?? 0) < TIER_RANK.PRO && (
                      <div className="flex items-center gap-1.5 pt-2 text-sm text-amber-600">
                        <Sparkles className="w-4 h-4" />
                        Upgrade to PRO for 2,000 verifications and 100 image verifications per month.
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>

            <div>
              <h2 className="text-lg font-semibold mb-3">Plan comparison</h2>
              <div className="border rounded-md overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted text-left">
                      <th className="p-2">Quota</th>
                      <th className="p-2">FREE</th>
                      <th className="p-2">PRO</th>
                      <th className="p-2">BUSINESS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {PLAN_ROWS.map((row) => (
                      <tr key={row.label} className="border-t">
                        <td className="p-2">{row.label}</td>
                        <td className="p-2">{row.free}</td>
                        <td className="p-2">{row.pro}</td>
                        <td className="p-2">{row.business}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Limits are operator-configurable and may differ on this install. Exceeding the
                monthly quota returns HTTP 402 with this page as the upgrade link.
              </p>
            </div>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">How to upgrade</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground space-y-2">
                <p>
                  Upgrades, term extensions and unlimited grants are applied by the operator — there
                  is no self-serve checkout on this install.
                </p>
                <p>
                  Send the workspace ID above (the copy button is next to it) to your account
                  contact, and say which plan and term you want. The change is applied to the
                  workspace immediately; new allowances appear on this page on the next load.
                </p>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
