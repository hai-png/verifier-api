"use client";

import { useEffect, useState } from "react";
import SiteNav from "@/components/SiteNav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "https://verifier-api-selfhosted.onrender.com";

interface Summary {
  status: string;
  timestamp: string;
  uptimeSeconds: number;
  providers: string[];
  capabilities: {
    batchVerification: boolean;
    imageVerification: boolean;
    hostedCommerce: boolean;
  };
}

export default function StatusPage() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/status/summary`)
      .then((res) => {
        if (!res.ok) throw new Error(`API responded ${res.status}`);
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Unreachable"));
  }, []);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <SiteNav />
      <main className="flex-1 container mx-auto px-4 max-w-2xl py-10">
        <h1 className="text-3xl font-bold mb-2">Status</h1>
        <p className="text-muted-foreground mb-6">Live service summary, refreshed on each visit.</p>

        {error && (
          <Card>
            <CardContent className="py-8 flex items-center gap-2 text-destructive">
              <XCircle className="w-5 h-5" />
              API unreachable: {error}
            </CardContent>
          </Card>
        )}

        {!data && !error && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" /> Checking…
          </div>
        )}

        {data && (
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle2 className="w-5 h-5 text-green-600" />
                  API {data.status}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                Uptime {Math.floor(data.uptimeSeconds / 3600)}h{" "}
                {Math.floor((data.uptimeSeconds % 3600) / 60)}m · checked{" "}
                {new Date(data.timestamp).toLocaleString()}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Providers</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {data.providers.map((p) => (
                  <Badge key={p} variant="secondary" className="capitalize">
                    {p}
                  </Badge>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Capabilities</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {(
                  [
                    ["Batch verification", data.capabilities.batchVerification],
                    ["Receipt image OCR", data.capabilities.imageVerification],
                    ["Hosted commerce", data.capabilities.hostedCommerce],
                  ] as const
                ).map(([label, on]) => (
                  <div key={label} className="flex items-center justify-between">
                    <span>{label}</span>
                    <Badge variant={on ? "default" : "secondary"}>
                      {on ? "enabled" : "disabled"}
                    </Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
