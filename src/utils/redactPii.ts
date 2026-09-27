/**
 * redactPii.ts
 *
 * Payment verification is, by definition, the processing of someone else's bank
 * receipt. The provider adapters used to log that receipt verbatim at INFO —
 * the full extracted PDF text, the parsed record with the payer's name and phone
 * number, the raw OCR result of an uploaded screenshot. Winston writes those to
 * files and to whatever shipper is attached, so a debug habit turned the log
 * directory into an unencrypted archive of customer banking data, with none of
 * the access controls the database has.
 *
 * The fix is not "log less by hand at every call site" — that regresses the
 * moment someone adds a new adapter. These helpers make the safe form the easy
 * form: pass the real value through them and the log line still tells an
 * operator everything needed to diagnose a parse failure.
 */

const NAME_KEYS = /(name|holder|customer|payer|payee|sender|receiver|recipient|merchant|beneficiary|owner)/i;
const DIGIT_KEYS = /(phone|mobile|msisdn|account|acc(?:oun)?t|card|iban|tin|vat|vatNo|nationalId|id)/i;
const EMAIL_KEYS = /(email|e_mail|mail)/i;

/** Everything worth keeping in a log: identifiers, amounts, timestamps, status. */
const SAFE_KEYS =
  /^(success|error|errorCode|message|reference|receiptNo|receiptNumber|transactionId|txnId|amount|paidAmount|serviceCharge|vat|totalPaidAmount|total|currency|status|responseCode|responseDescription|transactionDate|date|time|timestamp|paymentReason|paymentChannel|channel|provider|type|source|found|matched|ok|verified|attempts?|durationMs|elapsedMs|length|count)$/i;

/** `Abel Tesfaye` → `A*** T*****`. Keeps enough to spot a wrong-field parse. */
export function maskName(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + '*'.repeat(Math.max(part.length - 1, 2)))
    .join(' ');
}

/** `251911223344` → `2519*******44`. Keeps the prefix that identifies the carrier. */
export function maskDigits(value: string, keepPrefix = 4, keepSuffix = 2): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length <= keepPrefix + keepSuffix) return '*'.repeat(value.length);
  return (
    digits.slice(0, keepPrefix) +
    '*'.repeat(Math.max(digits.length - keepPrefix - keepSuffix, 3)) +
    digits.slice(-keepSuffix)
  );
}

export function maskEmail(value: string): string {
  const [local, domain] = value.split('@');
  if (!domain) return maskDigits(value);
  return `${(local[0] ?? '*')}${'*'.repeat(Math.max(local.length - 1, 2))}@${domain}`;
}

/**
 * Replace the value of every PII-looking key in a parsed receipt with a mask,
 * leaving amounts, references and statuses intact. Unknown keys are dropped
 * rather than passed through: an adapter that adds a `payerAddress` field should
 * not silently start logging addresses.
 */
export function redactReceiptRecord<T>(record: T): T | Record<string, unknown> {
  if (record === null || record === undefined) return record;
  if (Array.isArray(record)) return record.map((item) => redactReceiptRecord(item)) as unknown as T;
  if (typeof record !== 'object') return record;

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(record as Record<string, unknown>)) {
    if (raw === null || raw === undefined) {
      out[key] = raw;
      continue;
    }
    // Recurse before the key checks so a nested `details` or a list of parties is
    // redacted by the same rules instead of being dropped wholesale.
    if (typeof raw === 'object') {
      out[key] = redactReceiptRecord(raw);
      continue;
    }
    // Order matters. `payerAccount` contains "payer", so a name-first test would
    // route it through the name masker; the value is still masked either way, but
    // the digit masker is the one that keeps the right part of an account number
    // visible for correlation.
    if (SAFE_KEYS.test(key)) {
      out[key] = raw;
    } else if (EMAIL_KEYS.test(key)) {
      out[key] = typeof raw === 'string' && raw.includes('@') ? maskEmail(raw) : '[redacted]';
    } else if (DIGIT_KEYS.test(key)) {
      out[key] = typeof raw === 'string' && raw.trim() ? maskDigits(raw) : '[redacted]';
    } else if (NAME_KEYS.test(key)) {
      out[key] = typeof raw === 'string' && raw.trim() ? maskName(raw) : '[redacted]';
    } else if (typeof raw === 'number' || typeof raw === 'boolean') {
      out[key] = raw;
    } else {
      out[key] = '[omitted]';
    }
  }
  return out;
}

/**
 * A diagnostic fingerprint of raw provider text instead of the text itself.
 *
 * When a receipt fails to parse, what an operator needs is "was it empty, was it
 * HTML, which labels were present" — not the values next to those labels. This
 * produces that, bounded in size, with no payer data.
 */
const RECEIPT_FIELD_LABELS = [
  'Receipt',
  'Transaction',
  'Date',
  'Time',
  'Amount',
  'Total',
  'Charge',
  'VAT',
  'Name',
  'Account',
  'Phone',
  'Merchant',
  'Reason',
  'Channel',
  'Sender',
  'Receiver',
  'Beneficiary',
  'Status',
  'Reference',
];

export interface ReceiptTextDigest {
  characters: number;
  lines: number;
  looksLikeHtml: boolean;
  startsWith: string;
  labelsPresent: string[];
}

export function receiptTextDigest(text: string): ReceiptTextDigest {
  const body = typeof text === 'string' ? text : '';
  const trimmed = body.trim();
  return {
    characters: body.length,
    lines: body.split('\n').length,
    // Enough of the leading bytes to tell "HTML error page" from "PDF text"
    // from "empty" without ever including a field value.
    looksLikeHtml: /^<\s*(html|!doctype|\?xml)/i.test(trimmed),
    startsWith: trimmed.slice(0, 12).replace(/\s+/g, ' '),
    labelsPresent: RECEIPT_FIELD_LABELS.filter((label) => new RegExp(label, 'i').test(body)),
  };
}
