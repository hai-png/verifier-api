"use client"

import { useCallback, useEffect, useState } from "react"
import { AlertCircle, CheckCircle2, ImageUp, Loader2, ShieldCheck } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { API_URL as API_BASE } from "@/lib/api"

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
  reason?: string
  expectedAccount?: string
  recipientChecked?: boolean
  amountChecked?: boolean
  matchedOn?: string
  payoutAccountId?: string
  payoutAccountLabel?: string
}

/** Shape of GET /dashboard/:workspaceId/payouts */
interface PayoutOption {
  id: string
  label: string
  account: string
  type: string
  providersAllowed: string[]
  isDefault: boolean
}

/** The extra fields /verify-image adds when a payout account was enforced. */
interface ImageResult {
  verified?: boolean
  verified_success?: boolean
  type?: string
  reference?: string
  error?: string
  reason?: string
  expectedAccount?: string
  foundAccount?: string | null
  recipientChecked?: boolean
  amountChecked?: boolean
  payoutAccountId?: string
  payoutAccountLabel?: string
  note?: string
  forward_to?: string
  /** Echoed back on a rejection so a failed check can be adjudicated. */
  details?: {
    payerName?: string | null
    payerAccount?: string | null
    payerPhone?: string | null
    receiverName?: string | null
    receiverAccount?: string | null
    amount?: number | null
    date?: string | null
    reference?: string | null
  }
}

const RECIPIENT_REASON_COPY: Record<string, string> = {
  RECIPIENT_MISMATCH: "Paid to a different account than the one selected.",
  RECIPIENT_UNREADABLE:
    "This receipt shows no destination account or receiver name we can match. Some banks don't print one — set the account holder name on your payout account to allow a name check.",
  RECIPIENT_NOT_VERIFIABLE:
    "This receipt shows no destination account or receiver name we can match. Some banks don't print one — set the account holder name on your payout account to allow a name check.",
  PROVIDER_NOT_ALLOWED: "The selected payout account does not accept this provider.",
}

interface VerifyFormProps {
  workspaceId: string
  token: string
}

/**
 * Shared by both tabs. "Do not check the recipient" is the first option and is
 * never preselected away — an account is a deliberate choice, so leaving it to
 * the default account silently would enable a check the operator never asked for
 * and could start refusing receipts.
 */
function PayoutSelect({
  id,
  payouts,
  value,
  onChange,
}: {
  id: string
  payouts: PayoutOption[]
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Expected payout account</Label>
      <select
        id={id}
        value={value}
        onChange={event => onChange(event.target.value)}
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm outline-none focus:ring-2 focus:ring-ring"
      >
        <option value="">Do not check the recipient</option>
        {payouts.map(account => (
          <option key={account.id} value={account.id}>
            {account.label} — {account.account}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">
        {value
          ? "The receipt must name this account. The amount is still not checked."
          : "With no account selected the receipt is verified on the provider's word alone, including for whom it was paid."}
        {payouts.length === 0 ? " No payout accounts yet — add one under Payouts." : ""}
      </p>
    </div>
  )
}

export default function VerifyForm({ workspaceId, token }: VerifyFormProps) {
  const [provider, setProvider] = useState("auto")
  const [reference, setReference] = useState("")
  const [suffix, setSuffix] = useState("")
  const [phoneNumber, setPhoneNumber] = useState("")
  const [result, setResult] = useState<VerifyResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [measurement, setMeasurement] = useState<{ seconds: string; cache: string | null; timing: string | null } | null>(null)

  // Receipt-image mode.
  const [mode, setMode] = useState<"reference" | "image">("reference")
  const [file, setFile] = useState<File | null>(null)
  const [autoVerify, setAutoVerify] = useState(true)
  const [payouts, setPayouts] = useState<PayoutOption[]>([])
const [payoutAccountId, setPayoutAccountId] = useState("")
const [imageResult, setImageResult] = useState<ImageResult | null>(null)

  const selectedProvider = VERIFICATION_PROVIDERS.find(item => item.id === provider)
  const showSuffix = provider === "auto" || provider === "cbe" || provider === "abyssinia"
  const showPhone = provider === "auto" || provider === "cbebirr"

  // Needed by both tabs now: the reference form can name a payout account too,
  // and the image form always offers the selector.
  useEffect(() => {
    if (payouts.length > 0) return
    let cancelled = false
    fetch(`${API_BASE}/dashboard/${workspaceId}/payouts`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(response => response.json())
      .then((body: { success?: boolean; payouts?: PayoutOption[] }) => {
        if (cancelled) return
        const rows = body.payouts ?? []
        setPayouts(rows)
        const preferred = rows.find(row => row.isDefault) ?? rows[0]
        if (preferred) setPayoutAccountId(preferred.id)
      })
      .catch(() => {
        if (!cancelled) setPayouts([])
      })
    return () => { cancelled = true }
  }, [payouts.length, workspaceId, token])

  const resetOutcome = useCallback(() => {
    setError(null)
    setResult(null)
    setImageResult(null)
    setMeasurement(null)
  }, [])

  function switchMode(next: "reference" | "image") {
    setMode(next)
    resetOutcome()
  }

  async function onSubmitImage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    resetOutcome()
    if (!file) return
    setBusy(true)
    const startedAt = performance.now()

    try {
      const body = new FormData()
      body.append("file", file)
      if (payoutAccountId) body.append("payoutAccountId", payoutAccountId)
      if (suffix.trim()) body.append("suffix", suffix.trim())

      const response = await fetch(
        `${API_BASE}/dashboard/${workspaceId}/verify-image?autoVerify=${autoVerify ? "true" : "false"}`,
        { method: "POST", headers: { Authorization: `Bearer ${token}` }, body },
      )
      const parsed = (await response.json()) as ImageResult
      setMeasurement({
        seconds: ((performance.now() - startedAt) / 1000).toFixed(2),
        cache: response.headers.get("x-verify-cache"),
        timing: response.headers.get("server-timing"),
      })
      setImageResult(parsed)
      if (!response.ok && !parsed.error) setError(`Image verification failed (${response.status}).`)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Image verification failed.")
    } finally {
      setBusy(false)
    }
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setResult(null)
    setBusy(true)
    setMeasurement(null)
    const startedAt = performance.now()

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
          suffix: showSuffix ? suffix.trim() || undefined : undefined,
          phoneNumber: showPhone ? phoneNumber.trim() || undefined : undefined,
          payoutAccountId: payoutAccountId || undefined,
        }),
      })
      const body = (await response.json()) as VerifyResult
      setMeasurement({
        seconds: ((performance.now() - startedAt) / 1000).toFixed(2),
        cache: response.headers.get("x-verify-cache"),
        timing: response.headers.get("server-timing"),
      })
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

      <div className="inline-flex rounded-md border border-input p-1">
        <button
          type="button"
          onClick={() => switchMode("reference")}
          aria-pressed={mode === "reference"}
          className={`rounded px-3 py-1 text-sm ${mode === "reference" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
        >
          Reference
        </button>
        <button
          type="button"
          onClick={() => switchMode("image")}
          aria-pressed={mode === "image"}
          className={`inline-flex items-center gap-1.5 rounded px-3 py-1 text-sm ${mode === "image" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
        >
          <ImageUp className="w-3.5 h-3.5" /> Receipt image
        </button>
      </div>

      {mode === "reference" ? (
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
                  placeholder="251911123456"
                />
              </div>
            )}

            <PayoutSelect
              id="verify-payout"
              payouts={payouts}
              value={payoutAccountId}
              onChange={setPayoutAccountId}
            />

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
      ) : (
      <Card>
        <CardHeader>
          <CardTitle>Receipt image verification</CardTitle>
          <CardDescription>
            Uploads the receipt, reads it with vision, and checks it against the payout account you select.
            Uses one image credit.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmitImage} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="verify-image-file">Receipt image</Label>
              <Input
                id="verify-image-file"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={event => setFile(event.target.files?.[0] ?? null)}
                required
              />
              <p className="text-xs text-muted-foreground">JPEG, PNG or WebP, up to 8 MB.</p>
            </div>

            <PayoutSelect
              id="verify-image-payout"
              payouts={payouts}
              value={payoutAccountId}
              onChange={setPayoutAccountId}
            />

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoVerify}
                onChange={event => setAutoVerify(event.target.checked)}
              />
              Look the receipt up with the provider
              <span className="text-xs text-muted-foreground">
                (Telebirr and CBE are checked against the live provider; other banks are read from the image alone)
              </span>
            </label>

            <div className="space-y-2">
              <Label htmlFor="verify-image-suffix">Account suffix (CBE only, optional)</Label>
              <Input
                id="verify-image-suffix"
                value={suffix}
                onChange={event => setSuffix(event.target.value)}
                placeholder="Payer account tail used as the CBE lookup key"
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="w-4 h-4" />
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={busy || !file}>
              {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Verify receipt
            </Button>
          </form>
        </CardContent>
      </Card>
      )}

      {imageResult && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 flex-wrap">
              Result
              {imageResult.type && <Badge variant="secondary">{imageResult.type}</Badge>}
              <Badge variant={imageResult.verified ? "default" : "destructive"}>
                {imageResult.verified ? (
                  <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> VERIFIED</span>
                ) : "FAILED"}
              </Badge>
              {imageResult.recipientChecked && <Badge variant="outline">recipient checked</Badge>}
              {!imageResult.amountChecked && imageResult.verified && (
                <Badge variant="outline" className="border-amber-500 text-amber-600">amount not checked</Badge>
              )}
            </CardTitle>
            {measurement && (
              <div className="text-sm text-muted-foreground" aria-live="polite">
                Completed in {measurement.seconds}s
                {measurement.timing && (
                  <details className="mt-2 text-xs">
                    <summary>Server timing (milliseconds)</summary>
                    <code className="break-words">{measurement.timing}</code>
                  </details>
                )}
              </div>
            )}
            {imageResult.reason && (
              <CardDescription>
                {RECIPIENT_REASON_COPY[imageResult.reason] ?? imageResult.error}
              </CardDescription>
            )}
            {/* A rejection with no extracted fields is a dead end: you cannot tell
                a receipt that prints no account from one the OCR misread. */}
            {imageResult.reason && imageResult.details && (
              <div className="rounded-md border border-border p-3 text-sm">
                <p className="font-medium mb-1">What was read from the receipt</p>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  {imageResult.details.amount != null && (
                    <><dt className="text-muted-foreground">Amount</dt><dd>{imageResult.details.amount} ETB</dd></>
                  )}
                  {imageResult.details.reference && (
                    <><dt className="text-muted-foreground">Reference</dt><dd className="break-all">{imageResult.details.reference}</dd></>
                  )}
                  {imageResult.details.receiverName && (
                    <><dt className="text-muted-foreground">Receiver</dt><dd>{imageResult.details.receiverName}</dd></>
                  )}
                  {imageResult.details.receiverAccount && (
                    <><dt className="text-muted-foreground">Receiver account</dt><dd className="break-all">{imageResult.details.receiverAccount}</dd></>
                  )}
                  {imageResult.details.payerName && (
                    <><dt className="text-muted-foreground">Payer</dt><dd>{imageResult.details.payerName}</dd></>
                  )}
                  {imageResult.details.date && (
                    <><dt className="text-muted-foreground">Date</dt><dd>{imageResult.details.date}</dd></>
                  )}
                </dl>
              </div>
            )}
            {!imageResult.reason && !imageResult.verified && imageResult.error && (
              <CardDescription>{imageResult.error}</CardDescription>
            )}
            {imageResult.forward_to && (
              <CardDescription>
                Recognised as {imageResult.type}. Continue at <code>{imageResult.forward_to}</code>.
              </CardDescription>
            )}
            {imageResult.note && <CardDescription>{imageResult.note}</CardDescription>}
          </CardHeader>
          <CardContent>
            <pre className="bg-muted rounded-md p-4 overflow-auto text-xs max-h-96 whitespace-pre-wrap break-words">
              {JSON.stringify(imageResult, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}

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
              {result.recipientChecked && <Badge variant="outline">recipient checked</Badge>}
              {result.recipientChecked && result.success && (
                <Badge variant="outline" className="border-amber-500 text-amber-600">amount not checked</Badge>
              )}
            </CardTitle>
            {measurement && (
              <div className="text-sm text-muted-foreground" aria-live="polite">
                Completed in {measurement.seconds}s
                {measurement.cache === "hit" ? " · Recent successful result (short-lived cache)" : null}
                {measurement.cache === "coalesced" ? " · Shared in-flight verification" : null}
                {measurement.timing && (
                  <details className="mt-2 text-xs">
                    <summary>Server timing (milliseconds)</summary>
                    <code className="break-words">{measurement.timing}</code>
                  </details>
                )}
              </div>
            )}
            {!result.success && result.error && (
              <CardDescription>
                {result.reason
                  ? `${RECIPIENT_REASON_COPY[result.reason] ?? result.error} Expected ${result.expectedAccount}.`
                  : result.error}
              </CardDescription>
            )}
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
