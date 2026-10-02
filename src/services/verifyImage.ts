import { Mistral } from "@mistralai/mistralai";
import fs from "fs";
import { Request, Response, NextFunction } from "express";
import multer from "multer";
import logger from "../utils/logger";
import { runSmartVerify } from "./verifyUniversal";
import { prisma } from "../utils/prisma";
import dotenv from "dotenv";
import {
    checkReceiptRecipient,
    payoutAccountAllowsProvider,
} from "../utils/recipientCheck";
import { checkAmount } from "../utils/verificationGuards";

dotenv.config();

// ─── Credit refund helper ─────────────────────────────────────────────────────

type ResolvedAccount = {
    creditHolder: 'workspace';
    creditHolderId: string;
    imageCreditsUnlimited?: boolean;
} | undefined;

async function refundCredit(account: ResolvedAccount): Promise<void> {
    // Nothing was taken from an unlimited workspace, so there is nothing to
    // give back. Crediting it anyway would inflate a balance nothing reads.
    if (!account?.creditHolderId || account.imageCreditsUnlimited) return;
    await prisma.workspace.update({
        where: { id: account.creditHolderId },
        data: { imageCredits: { increment: 1 } },
    });
}

// ─── Payout account enforcement ───────────────────────────────────────────────

interface PayoutAccountLike {
    id: string;
    label: string;
    account: string;
    accountHolderName: string | null;
    providersAllowed: unknown;
}

/**
 * The OCR vocabulary and the payout vocabulary disagree in one place: Mistral is
 * asked for `cbe-birr`, while a payout account stores `cbebirr`. Everything else
 * (`dashen`, `abyssinia`, `awash`, `zemen`, `mpesa`, ...) is spelled the same.
 */
function normaliseProviderForPayout(providerType: string): string {
    return providerType === "cbe-birr" ? "cbebirr" : providerType;
}

/**
 * The workspace whose credits this request spends. verifyImageGate sets it
 * before the handler runs, so it is available from the first line.
 */
function resolvedWorkspaceId(req: Request): string | undefined {
    return (req as any).resolvedAccount?.creditHolderId;
}

/**
 * Load the payout account the caller expects the payment to have reached.
 *
 * Scoped to the workspace that owns the credits, so a caller cannot name another
 * tenant's account id and have their receipts checked against it. Unknown and
 * inactive ids are rejected the same way, so this does not confirm that an id
 * exists in some other workspace.
 */
async function resolvePayoutAccount(
    workspaceId: string | undefined,
    payoutAccountId: unknown,
): Promise<PayoutAccountLike | null> {
    if (typeof payoutAccountId !== 'string' || payoutAccountId.trim() === '') return null;
    if (!workspaceId) {
        throw Object.assign(new Error('A payout account requires workspace-scoped credentials.'), { status: 400 });
    }

    const account = await prisma.payoutAccount.findFirst({
        where: { id: payoutAccountId.trim(), workspaceId, active: true },
        select: { id: true, label: true, account: true, accountHolderName: true, providersAllowed: true },
    });

    if (!account) {
        throw Object.assign(new Error('Payout account not found for this workspace.'), { status: 404 });
    }
    return account;
}

/**
 * Providers differ in which field carries the credited account, and they are not
 * interchangeable: extractPaymentDetails names the real ones per provider
 * (creditedPartyAccountNo for Telebirr, receiverAccount for CBE and Abyssinia,
 * creditAccount for CBE Birr). A generic `account` or `accountNo` is deliberately
 * NOT accepted — where a provider returns one it is usually the *payer's*
 * account, and matching that against the merchant's would reject correct
 * receipts while proving nothing about who was paid.
 */
function extractCreditedAccount(data: unknown): string | null {
    if (!data || typeof data !== 'object') return null;
    const record = data as Record<string, unknown>;
    const candidates = [
        'creditedPartyAccountNo',
        'receiverAccount',
        'creditAccount',
        'creditedPartyAccount',
        'creditedAccount',
    ];
    for (const key of candidates) {
        const value = record[key];
        if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    return null;
}

/**
 * The credited party's name, for the same reason: it is the only identifier
 * Dashen-style providers give when there is no account number, so the recipient
 * check can still fall back to a name comparison on the API-backed path.
 */
function extractCreditedName(data: unknown): string | null {
    if (!data || typeof data !== 'object') return null;
    const record = data as Record<string, unknown>;
    for (const key of ['creditedPartyName', 'receiverName', 'accountHolderName']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    return null;
}

/**
 * Apply the recipient check and, on failure, write the response. Returns true
 * when the caller may continue with a success response.
 *
 * A mismatch does not refund the credit: the OCR ran and the answer is
 * definitive, so the merchant got what they paid for. Refunds stay reserved for
 * the case where we could not produce an answer at all.
 *
 * `details` is echoed back on failure. Without it a RECIPIENT_UNREADABLE is
 * indistinguishable from a receipt that genuinely has no account printed on it:
 * both look like "no account", and the operator cannot tell whether the receipt
 * is at fault or the OCR is. The extracted amount, names and reference are what
 * make that call.
 */
// Amount arrives from the OCR, and a receipt can be reused: the same payer,
// receiver and amount twice. Both guards apply here for the same reason and in
// the same order as the reference path.
async function enforceAmount(params: {
    res: Response;
    result: Record<string, unknown>;
    providerType: string;
    expectedAmount: unknown;
}): Promise<boolean> {
    const { res, result, providerType, expectedAmount } = params;
    const outcome = checkAmount({ result: { success: true, data: result }, expectedAmount, provider: providerType });
    if (!outcome.checked || outcome.ok) return true;

    logger.warn('Image verification amount check failed', { providerType, reason: outcome.reason });
    res.status(422).json({
        verified: false,
        error: outcome.error,
        reason: outcome.reason,
        type: providerType,
        expectedAmount: outcome.expectedAmount,
        foundAmount: outcome.foundAmount,
    });
    return false;
}

function enforceRecipient(params: {
    res: Response;
    payoutAccount: PayoutAccountLike | null;
    providerType: string;
    foundAccount: string | null;
    useCbeAccountRule?: boolean;
    foundName?: string | null;
    details?: Record<string, unknown>;
}): boolean {
    const { res, payoutAccount, providerType, foundAccount, useCbeAccountRule = false, foundName, details } = params;
    if (!payoutAccount) return true;

    const outcome = checkReceiptRecipient({
        foundAccount,
        expectedAccount: payoutAccount.account,
        expectedHolderName: payoutAccount.accountHolderName,
        foundName,
        useCbeAccountRule,
    });
    if (outcome.ok) return true;

    logger.warn('Image verification recipient check failed', {
        payoutAccountId: payoutAccount.id,
        providerType,
        reason: outcome.reason,
    });

    res.status(422).json({
        verified: false,
        error: outcome.error,
        reason: outcome.reason,
        type: providerType,
        expectedAccount: outcome.expectedAccount,
        foundAccount: outcome.foundAccount,
        ...(details ? { details } : {}),
    });
    return false;
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
            const payoutAccountId = req.body?.payoutAccountId ?? null;

            // ── 1. File must be present before we consume a credit ────────────
            if (!req.file) {
                logger.warn("No file uploaded");
                res.status(400).json({ error: "No file uploaded" });
                return;
            }

            // ── 2. Resolve the expected payout account, before any work ────────
            // Still ahead of the credit decrement: a bad account id is a caller
            // mistake, not a verification result, and must not cost an image
            // credit. Behind the file check, so a request with neither gets the
            // more useful 400.
            let payoutAccount: PayoutAccountLike | null;
            try {
                payoutAccount = await resolvePayoutAccount(resolvedWorkspaceId(req), payoutAccountId);
            } catch (err) {
                const status = (err as { status?: number }).status ?? 400;
                if (req.file?.path) {
                    try { fs.unlinkSync(req.file.path); } catch { /* best effort */ }
                }
                res.status(status).json({
                    verified: false,
                    error: err instanceof Error ? err.message : 'Invalid payout account.',
                });
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

            if (resolvedAccount?.creditHolderId && !resolvedAccount.imageCreditsUnlimited) {
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
4. **Dashen Bank** — 16-char reference starting with 3 digits. Extract transaction_id + payer_name + payer_account + receiver_name + receiver_account + amount + date.
5. **Bank of Abyssinia** — 12-char reference starting with 'FT' + 5-digit suffix. Extract transaction_id + account_suffix + payer_name + payer_account + receiver_name + receiver_account + amount + date.
6. **Awash Bank** — receipt from awashpay.awashbank.com. Extract transaction_id + payer_name + payer_account + receiver_name + receiver_account + amount + date.
7. **Zemen Bank** — receipt from share.zemenbank.com. Extract transaction_id + payer_name + payer_account + receiver_name + receiver_account + amount + date.
8. **M-Pesa** (Safaricom ET) — receipt from m-pesabusiness.safaricom.et. Extract transaction_id + payer_name + payer_phone + receiver_name + receiver_account + amount + date.
9. **Cooperative Bank of Oromia** — receipt from CoopApp or coopbankoromia.com.et. Extract transaction_id + payer_name + payer_account + receiver_name + receiver_account + amount + date.
10. **Oromia Bank** — receipt from oromiabank.com.et. Extract transaction_id + payer_name + payer_account + receiver_name + receiver_account + amount + date.
11. **Hijra Bank** (formerly ZamZam) — receipt from hijrabank.com. Extract transaction_id + payer_name + payer_account + receiver_name + receiver_account + amount + date.
12. **Amhara Bank** — receipt from amharabank.com.et. Extract transaction_id + payer_name + payer_account + receiver_name + receiver_account + amount + date.
13. **Wegagen Bank** — receipt from wegagenbank.com.et. Extract transaction_id + payer_name + payer_account + receiver_name + receiver_account + amount + date.
14. **Berhan Bank** — receipt from berhanbank.com. Extract transaction_id + payer_name + payer_account + receiver_name + receiver_account + amount + date.
15. **Abay Bank** — receipt from abaybank.com. Extract transaction_id + payer_name + payer_account + receiver_name + receiver_account + amount + date.
16. **Lion Bank** — receipt from lionbank.com.et. Extract transaction_id + payer_name + payer_account + receiver_name + receiver_account + amount + date.
17. **Bunna Bank** — receipt from bunnabank.com. Extract transaction_id + payer_name + payer_account + receiver_name + receiver_account + amount + date.
18. **Enat Bank** — receipt from enatbank.com.et. Extract transaction_id + payer_name + payer_account + receiver_name + receiver_account + amount + date.
19. **Gadaa Bank** — receipt from gadaabank.com. Extract transaction_id + payer_name + payer_account + receiver_name + receiver_account + amount + date.
20. **Tsehay Bank** — receipt from tsehaybank.com. Extract transaction_id + payer_name + payer_account + receiver_name + receiver_account + amount + date.
21. **Orbit Bank** — receipt from orbitbank.com.et. Extract transaction_id + payer_name + payer_account + receiver_name + receiver_account + amount + date.
22. **Shabelle Bank** — receipt from shabellebank.com. Extract transaction_id + payer_name + payer_account + receiver_name + receiver_account + amount + date.
23. **Sinqee Bank** — receipt from sinqeebank.com. Extract transaction_id + payer_name + payer_account + receiver_name + receiver_account + amount + date.

Rules:
- Identify the bank/provider from the receipt header, logo, URL, or text content.
- For Telebirr and CBE (providers 1-2), extract only the reference fields (these can be auto-verified via the bank's API).
- For all other banks (providers 3-23), extract ALL available fields: transaction_id, payer_name, payer_account, receiver_name, receiver_account, amount (number, in ETB), date (ISO 8601 if possible, else raw string), reference, payment_reason.
- If the receipt is unreadable or doesn't match any known provider, return type "unknown".
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
            const result = JSON.parse(messageContent);
            logger.info("OCR Result", result);

            if (result.type === "telebirr" && result.transaction_number) {
                if (autoVerify) {
                    try {
                        const verification = await runSmartVerify({ reference: result.transaction_number, provider: 'telebirr' });
                        if (!verification.success) {
                            res.status(verification.httpStatus).json({ verified: false, error: verification.error });
                            return;
                        }
                        const data = verification.data;
                        // The provider already told us who was credited, so the
                        // check needs no OCR.
                        if (!enforceRecipient({
                            res,
                            payoutAccount,
                            providerType: 'telebirr',
                            foundAccount: extractCreditedAccount(data),
                            foundName: extractCreditedName(data),
                        })) {
                            return;
                        }
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
                    if (!enforceRecipient({
                        res,
                        payoutAccount,
                        providerType: 'cbe',
                        foundAccount: extractCreditedAccount(data),
                        foundName: extractCreditedName(data),
                        useCbeAccountRule: true,
                    })) {
                        return;
                    }
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

            // ── OCR-verified banks (no public API — receipt image IS the verification) ──
            // For these banks, the OCR result itself is the verification. The receipt
            // image was analyzed by Mistral Vision, and the extracted fields are
            // returned directly. The caller (e.g. the FitLife Hub Worker) can then
            // match the amount + payer against expected values.
            const ocrVerifiedTypes = [
                "cbe-birr", "dashen", "abyssinia", "awash", "zemen", "mpesa",
                "coop-oromia", "oromia-bank", "hijra", "amhara", "wegagen",
                "berhan", "abay", "lion", "bunna", "enat", "gadaa", "tsehay",
                "orbit", "shabelle", "sinqee",
            ];

            if (ocrVerifiedTypes.includes(result.type)) {
                // Built once and reused by both outcomes, so a rejected receipt
                // reports exactly the fields a successful one would have.
                const ocrDetails = {
                    payerName: result.payer_name,
                    payerAccount: result.payer_account,
                    payerPhone: result.payer_phone,
                    receiverName: result.receiver_name,
                    receiverAccount: result.receiver_account,
                    amount: result.amount,
                    date: result.date,
                    reference: result.reference || result.transaction_id || result.transaction_number,
                    paymentReason: result.payment_reason,
                };

                // A payout account is optional, but when one is supplied the
                // platform can finally enforce what the note below used to
                // delegate to the caller. Reject up front if this account cannot
                // even receive this provider, otherwise the comparison below
                // would be between two unrelated things.
                if (payoutAccount && !payoutAccountAllowsProvider(payoutAccount.providersAllowed, normaliseProviderForPayout(result.type))) {
                    logger.warn('Image verification payout account cannot receive provider', {
                        payoutAccountId: payoutAccount.id,
                        providerType: result.type,
                    });
                    res.status(422).json({
                        verified: false,
                        error: `The selected payout account does not accept ${result.type} payments. Choose an account that accepts this provider, or omit the account.`,
                        reason: 'PROVIDER_NOT_ALLOWED',
                        type: result.type,
                        details: ocrDetails,
                    });
                    return;
                }

                if (!enforceRecipient({
                    res,
                    payoutAccount,
                    providerType: result.type,
                    foundAccount: result.receiver_account,
                    foundName: result.receiver_name,
                    details: ocrDetails,
                })) {
                    return;
                }

                if (!await enforceAmount({
                    res,
                    result: ocrDetails,
                    providerType: result.type,
                    expectedAmount: req.body?.expectedAmount,
                })) {
                    return;
                }

                res.json({
                    verified: true,
                    type: result.type,
                    reference: result.transaction_id || result.transaction_number || result.reference,
                    details: ocrDetails,
                    // The recipient check says who was paid. It says nothing about
                    // how much, and the previous wording dropped that caution
                    // entirely once a payout account was supplied — a receipt for
                    // 100 Birr to the right account passed as readily as 5,000.
                    // So state the limit explicitly instead of implying the
                    // receipt is fully checked.
                    amountChecked: false,
                    note: payoutAccount
                        ? 'The destination account was checked against the selected payout account. The amount was NOT checked — compare it against what the customer owes before issuing anything.'
                        : 'OCR-verified receipt (no public API available for this provider). Neither the recipient nor the amount was checked — compare both against expected values before issuing a subscription.',
                    ...(payoutAccount
                        ? {
                            recipientChecked: true,
                            payoutAccountId: payoutAccount.id,
                            payoutAccountLabel: payoutAccount.label,
                        }
                        : {}),
                });
                return;
            }

            res.status(422).json({ error: "Unknown or unrecognized receipt type", ocr_result: result });

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
