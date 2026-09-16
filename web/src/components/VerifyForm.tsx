"use client"

import { useState } from "react"
import { AlertCircle, CheckCircle2, Loader2, ShieldCheck } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "https://verifier-api-selfhosted.onrender.com"

export const VERIFICATION_PROVIDERS = [
  { id: "auto", label: "Auto-detect", help: "Let the reference format choose the provider." },
  { id: "telebirr", label: "Telebirr", help: "Receipt number." },
  { id: "cbe", label: "CBE Bank", help: "FT reference plus the payer account suffix." },
  { id: "cbebirr", label: "CBE Birr", help: "Receipt number plus buyer phone number." },
  { id: "dashen", label: "Dashen Bank", help: "Dashen transaction reference." },
  { id: "abyssinia", label: "Bank of Abyssinia", help: "Reference plus five-digit account suffix." },
  { id: "mpesa", label: "M-Pesa", help: "Safaricom transaction ID." },
  { id: "awash", label: "Awash Bank", help: "Awash receipt reference." },
  { id: "zemen", label: "Zemen Bank", help: "Zemen receipt reference." },
] as const

interface VerifyResult {
  success: boolean
  provider?: string
  error?: string
  details?: unknown
  data?: unknown
}

interface VerifyFormProps {
  workspaceId: string
  token: string
}

export default function VerifyForm({ workspaceId, token }: VerifyFormProps) {
  const [provider, setProvider] = useState("auto")
  const [reference, setReference] = useState("")
  const [suffix, setSuffix] = useState("")
  const [phoneNumber, setPhoneNumber] = useState("")
  const [result, setResult] = useState<VerifyResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const selectedProvider = VERIFICATION_PROVIDERS.find(item => item.id === provider)
  const showSuffix = provider === "auto" || provider === "cbe" || provider === "abyssinia"
  const showPhone = provider === "auto" || provider === "cbebirr"

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setResult(null)
    setBusy(true)

    try {
      const response = await fetch(`${API_BASE}/dashboard/${workspaceId}/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          reference: reference.trim(),
          provider: provider === "auto" ? undefined : provider,
          suffix: suffix.trim() || undefined,
          phoneNumber: phoneNumber.trim() || undefined,
        }),
      })
      const body = (await response.json()) as VerifyResult
      setResult(body)
      if (!response.ok && !body.error) setError(`Verification request failed (${response.status}).`)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Verification request failed.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary rounded-xl flex items-center justify-center text-primary-foreground">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Verify a payment</h1>
            <p className="text-sm text-muted-foreground">Authenticated workspace verification across all supported providers.</p>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Payment verification</CardTitle>
          <CardDescription>
            Select a bank when the reference format overlaps with another provider. Verification uses one workspace credit.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="verify-provider">Provider</Label>
              <select
                id="verify-provider"
                value={provider}
                onChange={event => setProvider(event.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm outline-none focus:ring-2 focus:ring-ring"
              >
                {VERIFICATION_PROVIDERS.map(item => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{selectedProvider?.help}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="verify-reference">Payment reference</Label>
              <Input
                id="verify-reference"
                value={reference}
                onChange={event => setReference(event.target.value)}
                placeholder="Enter the receipt or transaction reference"
                required
              />
            </div>

            {showSuffix && (
              <div className="space-y-2">
                <Label htmlFor="verify-suffix">Account suffix</Label>
                <Input
                  id="verify-suffix"
                  value={suffix}
                  onChange={event => setSuffix(event.target.value)}
                  placeholder={provider === "abyssinia" ? "Last 5 digits of the account" : "CBE payer tail: 8 digits after 1000"}
                />
              </div>
            )}

            {showPhone && (
              <div className="space-y-2">
                <Label htmlFor="verify-phone">Phone number</Label>
                <Input
                  id="verify-phone"
                  value={phoneNumber}
                  onChange={event => setPhoneNumber(event.target.value)}
                  placeholder="251… or 09…"
                />
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="w-4 h-4" />
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={busy || !reference.trim()}>
              {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Verify Transaction
            </Button>
          </form>
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 flex-wrap">
              Result
              {result.provider && <Badge variant="secondary">{result.provider}</Badge>}
              <Badge variant={result.success ? "default" : "destructive"}>
                {result.success ? (
                  <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> VERIFIED</span>
                ) : "FAILED"}
              </Badge>
            </CardTitle>
            {!result.success && result.error && <CardDescription>{result.error}</CardDescription>}
          </CardHeader>
          <CardContent>
            <pre className="bg-muted rounded-md p-4 overflow-auto text-xs max-h-96 whitespace-pre-wrap break-words">
              {JSON.stringify(result.data ?? result.details ?? result, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
