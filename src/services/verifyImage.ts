import { Mistral } from "@mistralai/mistralai";
import fs from "fs";
import { Request, Response } from "express";
import multer from "multer";
import logger from "../utils/logger";
import { verifyTelebirr } from "./verifyTelebirr";
import { verifyCBE } from "./verifyCBE";
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

const upload = multer({ dest: "uploads/" });

const client = new Mistral({
    apiKey: process.env.MISTRAL_API_KEY!,
});

export const verifyImageHandler = [
    upload.single("file"),

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
                        const data = await verifyTelebirr(result.transaction_number);
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

                if (!accountSuffix) {
                    res.status(400).json({
                        error: "Account suffix is required for CBE verification in autoVerify mode",
                    });
                    return;
                }

                try {
                    const data = await verifyCBE(result.transaction_id, accountSuffix);
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
                res.json({
                    verified: true,
                    type: result.type,
                    reference: result.transaction_id || result.transaction_number || result.reference,
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
                    note: "OCR-verified receipt (no public API available for this provider). Verify amount + payer against expected values before issuing subscription.",
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
