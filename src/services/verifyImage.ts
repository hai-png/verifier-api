import { Mistral } from "@mistralai/mistralai";
import fs from "fs";
import { Request, Response, NextFunction } from "express";
import multer from "multer";
import logger from "../utils/logger";
import { redactReceiptRecord, receiptTextDigest } from "../utils/redactPii";
import {
    compareAgainstExpectations,
    ocrOnlyTypes,
    ocrTrustEnabled,
    providerForOcrType,
} from "../utils/ocrVerification";
import { runSmartVerify } from "./verifyUniversal";
import { prisma } from "../utils/prisma";
import dotenv from "dotenv";

dotenv.config();

// ─── Credit refund helper ─────────────────────────────────────────────────────

type ResolvedAccount = { creditHolder: 'workspace'; creditHolderId: string } | undefined;

async function refundCredit(account: ResolvedAccount): Promise<void> {
    if (!account?.creditHolderId) return;
    await prisma.workspace.update({
        where: { id: account.creditHolderId },
        data: { imageCredits: { increment: 1 } },
    });
}

// ─────────────────────────────────────────────────────────────────────────────

// A receipt image is a few hundred KB. Without limits, express.json()'s 100 kB
// cap does not apply to multipart/form-data, so multer streamed an arbitrarily
// large body to disk and readFileSync then held it (plus its 1.33x base64
// expansion) in memory — an instant OOM on the 512 MB instance, taking every
// in-flight verification with it.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const upload = multer({
    dest: "uploads/",
    limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: 1,
        fields: 8,
        parts: 12,
    },
    fileFilter: (_req, file, cb) => {
        if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
            cb(new Error(`Unsupported image type. Allowed: ${[...ALLOWED_IMAGE_TYPES].join(', ')}.`));
            return;
        }
        cb(null, true);
    },
});

const client = new Mistral({
    apiKey: process.env.MISTRAL_API_KEY!,
});

export const verifyImageHandler = [
    upload.single("file"),

    // multer reports limit violations and rejected MIME types as errors. Without
    // this they surface as a generic 500 from the global handler.
    (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
        if (!err) {
            next();
            return;
        }
        const code = (err as { code?: string }).code;
        const message = err instanceof Error ? err.message : 'Upload rejected.';
        if (code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({ error: `Image is too large. Maximum size is ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.` });
            return;
        }
        if (code === 'LIMIT_FILE_COUNT' || code === 'LIMIT_PART_COUNT' || code === 'LIMIT_FIELD_COUNT') {
            res.status(400).json({ error: 'Too many files or form fields in the upload.' });
            return;
        }
        if (code === 'LIMIT_UNEXPECTED_FILE') {
            res.status(400).json({ error: 'Unexpected file field. Use the "file" field.' });
            return;
        }
        if (/Unsupported image type/.test(message)) {
            res.status(415).json({ error: message });
            return;
        }
        next(err);
    },

    async (req: Request, res: Response): Promise<void> => {
        // ── Resolve API key identity (set by apiKeyAuth) ──────────────────────
        const apiKeyData = (req as any).apiKeyData as { id: string } | undefined;

        try {
            const autoVerify = req.query.autoVerify === "true";
            const accountSuffix = req.body?.suffix || null;

            // ── 1. File must be present before we consume a credit ────────────
            if (!req.file) {
                logger.warn("No file uploaded");
                res.status(400).json({ error: "No file uploaded" });
                return;
            }

            // ── 2. Atomic credit decrement ────────────────────────────────────
            // Uses updateMany with gt:0 guard so concurrent requests can never
            // overdraft below zero.  If count === 0 the balance was exhausted
            // by a concurrent request since the gate ran — return 402.
            //
            // resolvedAccount is set by verifyImageGate and points at the
            // owning workspace where image credits now live.
            const resolvedAccount = (req as any).resolvedAccount as ResolvedAccount;

            if (resolvedAccount?.creditHolderId) {
                const result = await prisma.workspace.updateMany({
                    where: { id: resolvedAccount.creditHolderId, imageCredits: { gt: 0 } },
                    data: { imageCredits: { decrement: 1 } },
                });
                const decrementCount = result.count;

                if (decrementCount === 0) {
                    if (req.file?.path) fs.unlinkSync(req.file.path);
                    res.status(402).json({
                        error: "Out of image credits. Top up at veritas.et/dashboard/billing",
                        topUp: "https://verify.noveld.com.et/dashboard/billing",
                    });
                    return;
                }
            }

            // ── 3. Call Mistral Vision ────────────────────────────────────────
            const filePath = req.file.path;
            const imageBuffer = fs.readFileSync(filePath);
            const base64Image = imageBuffer.toString("base64");

            const prompt = `
You are a payment receipt analyzer for Ethiopian payment systems. Based on the uploaded image, determine which bank or payment provider issued the receipt, and extract the key transaction details.

Recognized providers:
1. **Telebirr** (Ethio Telecom) — green receipt, 10-char alphanumeric reference. Extract transaction_number.
2. **CBE** (Commercial Bank of Ethiopia) — purple header, reference starts with 'FT'. Extract transaction_id (FTxxxx) + account_suffix (8 digits for legacy, or token for new format).
3. **CBE Birr** — mobile money receipt, 10-char alphanumeric + phone number. Extract transaction_number + payer_phone (251xxxxxxxxx).
4. **Dashen Bank** — 16-char reference starting with 3 digits. Extract transaction_id.
5. **Bank of Abyssinia** — 12-char reference starting with 'FT' + 5-digit suffix. Extract transaction_id + account_suffix.
6. **Awash Bank** — receipt from awashpay.awashbank.com. Extract transaction_id.
7. **Zemen Bank** — receipt from share.zemenbank.com. Extract transaction_id.
8. **M-Pesa** (Safaricom ET) — receipt from m-pesabusiness.safaricom.et. Extract transaction_id.
9. **Cooperative Bank of Oromia** — receipt from CoopApp or coopbankoromia.com.et. Extract transaction_id + payer_name + amount + date.
10. **Oromia Bank** — receipt from oromiabank.com.et. Extract transaction_id + payer_name + amount + date.
11. **Hijra Bank** (formerly ZamZam) — receipt from hijrabank.com. Extract transaction_id + payer_name + amount + date.
12. **Amhara Bank** — receipt from amharabank.com.et. Extract transaction_id + payer_name + amount + date.
13. **Wegagen Bank** — receipt from wegagenbank.com.et. Extract transaction_id + payer_name + amount + date.
14. **Berhan Bank** — receipt from berhanbank.com. Extract transaction_id + payer_name + amount + date.
15. **Abay Bank** — receipt from abaybank.com. Extract transaction_id + payer_name + amount + date.
16. **Lion Bank** — receipt from lionbank.com.et. Extract transaction_id + payer_name + amount + date.
17. **Bunna Bank** — receipt from bunnabank.com. Extract transaction_id + payer_name + amount + date.
18. **Enat Bank** — receipt from enatbank.com.et. Extract transaction_id + payer_name + amount + date.
19. **Gadaa Bank** — receipt from gadaabank.com. Extract transaction_id + payer_name + amount + date.
20. **Tsehay Bank** — receipt from tsehaybank.com. Extract transaction_id + payer_name + amount + date.
21. **Orbit Bank** — receipt from orbitbank.com.et. Extract transaction_id + payer_name + amount + date.
22. **Shabelle Bank** — receipt from shabellebank.com. Extract transaction_id + payer_name + amount + date.
23. **Sinqee Bank** — receipt from sinqeebank.com. Extract transaction_id + payer_name + amount + date.

Rules:
- Identify the bank/provider from the receipt header, logo, URL, or text content.
- For Telebirr, CBE, CBE Birr, Dashen, Abyssinia, Awash, Zemen and M-Pesa (providers 1-8) the reference is the critical field: this service confirms the payment by asking that provider's own API, so extract the reference exactly as printed, even if other fields are illegible. Never guess or reformat a reference.
- For all providers, extract ALL available fields: transaction_id, payer_name, payer_account, receiver_name, receiver_account, amount (number, in ETB), date (ISO 8601 if possible, else raw string), reference, payment_reason.
- If the receipt is unreadable or doesn't match any known provider, return type "unknown".
- If a field is not legible, omit it. An omitted field is recoverable; an invented one is not.
- Amount should be a number (e.g. 299.00, not "299 Birr").

Return this JSON format exactly, with no extra prose:
{
  "type": "telebirr" | "cbe" | "cbe-birr" | "dashen" | "abyssinia" | "awash" | "zemen" | "mpesa" | "coop-oromia" | "oromia-bank" | "hijra" | "amhara" | "wegagen" | "berhan" | "abay" | "lion" | "bunna" | "enat" | "gadaa" | "tsehay" | "orbit" | "shabelle" | "sinqee" | "unknown",
  "transaction_id"?: "string",
  "transaction_number"?: "string",
  "account_suffix"?: "string" (for CBE legacy / Abyssinia),
  "payer_phone"?: "string" (for CBE Birr, 251xxxxxxxxx format),
  "payer_name"?: "string",
  "payer_account"?: "string",
  "receiver_name"?: "string",
  "receiver_account"?: "string",
  "amount"?: number (in ETB),
  "date"?: "string",
  "reference"?: "string",
  "payment_reason"?: "string"
}
            `.trim();

            logger.info("Sending image to Mistral Vision (ministral-14b-2512)...");

            let chatResponse;
            try {
                chatResponse = await client.chat.complete({
                    model: "ministral-14b-2512",
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: prompt },
                                {
                                    type: "image_url",
                                    imageUrl: `data:image/jpeg;base64,${base64Image}`,
                                },
                            ],
                        },
                    ],
                    responseFormat: { type: "json_object" },
                });
            } catch (mistralErr) {
                // Mistral itself is unavailable — refund the credit (not the user's fault)
                logger.error("Mistral API call failed, refunding credit:", mistralErr);
                await refundCredit(resolvedAccount).catch((e) => logger.error("Failed to refund credit:", e));
                res.status(503).json({ error: "OCR service temporarily unavailable. Your credit has been refunded." });
                return;
            }

            const rawMessage = chatResponse.choices?.[0]?.message as
                | { content?: string | Array<{ type: string; text?: string }> }
                | undefined;
            const rawContent = rawMessage?.content;

            // The newer Mistral SDK may return content as a string OR as an array
            // of content chunks. Normalize both into a single text string.
            let messageContent: string | null = null;
            if (typeof rawContent === "string") {
                messageContent = rawContent;
            } else if (Array.isArray(rawContent)) {
                messageContent = rawContent
                    .filter((chunk) => chunk?.type === "text" && typeof chunk.text === "string")
                    .map((chunk) => chunk.text as string)
                    .join("\n")
                    .trim();
                if (!messageContent) messageContent = null;
            }

            if (!messageContent) {
                // Unexpected Mistral response — refund (our infrastructure fault)
                logger.error("Invalid Mistral response", { rawContent });
                await refundCredit(resolvedAccount).catch((e) => logger.error("Failed to refund credit:", e));
                res.status(500).json({ error: "Invalid OCR response. Your credit has been refunded." });
                return;
            }

            // ── 4. Parse and route result (credit already consumed) ───────────
            // This parse was unguarded. Every other model-side failure above
            // refunds the credit before responding, but a malformed or non-object
            // JSON body threw straight out to the outer `catch (err)`, which does
            // not refund — so the one failure mode most likely to happen (an LLM
            // returning prose, a fenced block, or `null`) was also the one that
            // charged the user for our infrastructure fault. It also surfaced as a
            // bare 500 with no indication the credit was lost.
            let result: any;
            try {
                result = JSON.parse(messageContent);
            } catch (parseErr) {
                logger.error("OCR returned unparseable JSON, refunding credit:", parseErr, {
                    ...receiptTextDigest(messageContent),
                });
                await refundCredit(resolvedAccount).catch((e) => logger.error("Failed to refund credit:", e));
                res.status(502).json({ error: "OCR service returned an unreadable result. Your credit has been refunded." });
                return;
            }
            if (result === null || typeof result !== "object" || Array.isArray(result)) {
                logger.error("OCR returned JSON that is not a receipt object, refunding credit:", {
                    parsedType: Array.isArray(result) ? "array" : typeof result,
                });
                await refundCredit(resolvedAccount).catch((e) => logger.error("Failed to refund credit:", e));
                res.status(502).json({ error: "OCR service returned an unusable result. Your credit has been refunded." });
                return;
            }

            // The OCR result names the payer and their phone number, so it is
            // redacted rather than written to the log verbatim.
            logger.info("OCR Result", redactReceiptRecord(result));

            if (result.type === "telebirr" && result.transaction_number) {
                if (autoVerify) {
                    try {
                        const verification = await runSmartVerify({ reference: result.transaction_number, provider: 'telebirr' });
                        if (!verification.success) {
                            res.status(verification.httpStatus).json({ verified: false, error: verification.error });
                            return;
                        }
                        const data = verification.data;
                        res.json({
                            verified: true,
                            type: "telebirr",
                            reference: result.transaction_number,
                            details: data,
                        });
                    } catch (verifyErr: any) {
                        logger.error("Telebirr verification failed", { verifyErr });
                        if (verifyErr.name === "TelebirrVerificationError") {
                            res.status(502).json({ error: verifyErr.message, details: verifyErr.details });
                        } else {
                            res.status(500).json({ error: "Verification failed for Telebirr" });
                        }
                    }
                } else {
                    res.json({
                        type: "telebirr",
                        reference: result.transaction_number,
                        forward_to: "/verify-telebirr",
                    });
                }
                return;
            }

            if (result.type === "cbe" && result.transaction_id) {
                if (!autoVerify) {
                    res.json({
                        type: "cbe",
                        reference: result.transaction_id,
                        forward_to: "/verify-cbe",
                        accountSuffix: "required_from_user",
                    });
                    return;
                }

                try {
                    const verification = await runSmartVerify({ reference: result.transaction_id, suffix: accountSuffix, provider: 'cbe' });
                    if (!verification.success) {
                        res.status(verification.httpStatus).json({ verified: false, error: verification.error });
                        return;
                    }
                    const data = verification.data;
                    res.json({
                        verified: true,
                        type: "cbe",
                        reference: result.transaction_id,
                        details: data,
                    });
                } catch (verifyErr) {
                    logger.error("CBE verification failed", { verifyErr });
                    res.status(500).json({ error: "Verification failed for CBE" });
                }
                return;
            }

            // ── Banks this service has a real adapter for ────────────────────
            // cbe-birr, dashen, abyssinia, awash, zemen and mpesa all have an
            // upstream API. For those the image is only a way of *reading the
            // reference*; the payment itself is confirmed by asking the bank. That
            // used not to happen — these six were in the "trust the image" list
            // below, so a real ground truth was available and was ignored.
            const adapter = providerForOcrType(result.type);
            const ocrReference = result.transaction_id || result.transaction_number || result.reference;

            if (adapter && ocrReference && String(ocrReference).trim()) {
                const phone = result.payer_phone || req.body?.phoneNumber || undefined;
                const suffix = result.account_suffix || accountSuffix || undefined;
                const missingInput =
                    (adapter.needsPhone && !phone) || (adapter.needsSuffix && !suffix);

                if (!autoVerify || missingInput) {
                    res.json({
                        verified: false,
                        type: result.type,
                        reference: ocrReference,
                        forward_to: `/verify-${adapter.provider}`,
                        verification: {
                            method: "none",
                            authoritative: false,
                            outcome: "not_attempted",
                            reason: !autoVerify
                                ? "autoVerify was not requested; the reference can be checked against the bank's API"
                                : `the receipt did not legibly include the ${adapter.needsPhone ? "payer phone number" : "account suffix"} this adapter requires`,
                        },
                    });
                    return;
                }

                try {
                    const verification = await runSmartVerify({
                        reference: String(ocrReference).trim(),
                        suffix,
                        phoneNumber: phone,
                        provider: adapter.provider,
                    });
                    if (!verification.success) {
                        // A 400 means the reference we read was unusable, which is
                        // an extraction problem, not the bank saying "no". Only a
                        // genuine rejection is reported as one. Either way the bank's
                        // answer overrides the image: there is no OCR fallback here,
                        // because falling back would let a forged picture win
                        // whenever the real check failed.
                        const unusableReference = verification.httpStatus === 400;
                        res.status(unusableReference ? 422 : verification.httpStatus).json({
                            verified: false,
                            type: result.type,
                            reference: ocrReference,
                            verification: {
                                method: "provider_api",
                                authoritative: !unusableReference,
                                outcome: unusableReference ? "not_attempted" : "rejected",
                                reason: unusableReference
                                    ? "the reference read from the image is not a valid reference for this provider"
                                    : undefined,
                            },
                            error: verification.error,
                        });
                        return;
                    }
                    res.json({
                        verified: true,
                        type: result.type,
                        reference: ocrReference,
                        details: verification.data,
                        verification: {
                            method: "provider_api",
                            authoritative: true,
                            outcome: "confirmed",
                        },
                    });
                    return;
                } catch (verifyErr) {
                    logger.error(`${result.type} verification failed for OCR-supplied reference`, {
                        verifyErr: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
                    });
                    res.status(502).json({
                        verified: false,
                        type: result.type,
                        reference: ocrReference,
                        verification: { method: "provider_api", authoritative: false, outcome: "error" },
                        error: `Verification against ${result.type} failed. No credit for the image read is refunded because the read succeeded.`,
                    });
                    return;
                }
            }

            // ── OCR-only receipts: no upstream API exists for these banks ──────
            // Reading a picture is extraction, not verification. The pixels can say
            // anything, because anyone can produce the picture — so the response
            // never claims `verified: true` on the strength of the image alone. It
            // reports what was read, whether it matches what *this order* expected,
            // and says plainly that a human or a real provider check is still needed.
            if (ocrOnlyTypes().includes(result.type) || (adapter && !ocrReference)) {
                const comparison = compareAgainstExpectations(result, {
                    amount: req.body?.expectedAmount ?? req.query.expectedAmount,
                    payerName: req.body?.expectedPayerName ?? req.query.expectedPayerName,
                    payerPhone: req.body?.expectedPayerPhone ?? req.query.expectedPayerPhone,
                    receiverName: req.body?.expectedReceiverName ?? req.query.expectedReceiverName,
                    receiverAccount: req.body?.expectedReceiverAccount ?? req.query.expectedReceiverAccount,
                    reference: req.body?.expectedReference ?? req.query.expectedReference,
                });

                // Opt-in escape hatch for integrations that do their own matching
                // and depend on the old response shape. Logged, because it is the
                // difference between "we checked" and "we read a picture".
                const trustImage = ocrTrustEnabled({ query: req.query as Record<string, unknown> });
                if (trustImage) {
                    logger.warn("OCR-only receipt accepted with trustOcr; no upstream confirmation was performed.", {
                        type: result.type,
                        expectationsProvided: comparison.expectationsProvided,
                        satisfied: comparison.satisfied,
                    });
                }

                res.json({
                    // `verified` reflects whether anything authoritative confirmed
                    // the payment. For an OCR-only receipt the answer is no, unless
                    // the deployment has explicitly opted into the legacy shorthand.
                    verified: trustImage,
                    type: result.type,
                    reference: ocrReference || null,
                    details: {
                        payerName: result.payer_name,
                        payerAccount: result.payer_account,
                        payerPhone: result.payer_phone,
                        receiverName: result.receiver_name,
                        receiverAccount: result.receiver_account,
                        amount: result.amount,
                        date: result.date,
                        reference: result.reference || result.transaction_id || result.transaction_number,
                        paymentReason: result.payment_reason,
                    },
                    verification: {
                        method: "ocr_only",
                        authoritative: false,
                        outcome: comparison.expectationsProvided
                            ? (comparison.satisfied ? "matches_expectations" : "does_not_match_expectations")
                            : "unverified",
                        // Machine-readable, so a caller can act on it instead of
                        // having to notice a prose `note`.
                        expectationsProvided: comparison.expectationsProvided,
                        satisfied: comparison.satisfied,
                        checks: comparison.checks,
                        extractedAmount: comparison.extractedAmount,
                        requiresManualReview: !trustImage && !comparison.satisfied,
                    },
                    note: trustImage
                        ? "OCR-verified receipt (no public API available for this provider). trustOcr is enabled, so `verified` reflects the image read only — nothing upstream confirmed this payment."
                        : "Receipt read by OCR only; no provider API exists for this bank, so nothing confirmed the payment actually happened. `verified` is false by design. Pass expectedAmount / expectedPayerName / expectedPayerPhone to have them compared server-side, and do not issue goods on this response alone.",
                });
                return;
            }

            // The model's own output may contain a payer name it read off an
            // arbitrary image, so it is redacted before going back or into a log.
            res.status(422).json({ error: "Unknown or unrecognized receipt type", ocr_result: redactReceiptRecord(result) });

        } catch (err) {
            logger.error(
                `Unexpected error in /verify-image: ${err instanceof Error ? err.message : String(err)}`,
                { stack: err instanceof Error ? err.stack : undefined },
            );
            res.status(500).json({ error: "Something went wrong processing the image." });
        } finally {
            if (req.file?.path) {
                try { fs.unlinkSync(req.file.path); } catch { /* already deleted */ }
                logger.debug("Temp file deleted", { path: req.file.path });
            }
        }
    },
];
