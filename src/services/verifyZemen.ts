import axios, { AxiosResponse } from 'axios';
import pdf from 'pdf-parse';
import https from 'https';
import logger from '../utils/logger';

export interface ZemenVerifyResult {
    success: boolean;
    senderName?: string;
    senderAccount?: string;
    recipientName?: string;
    recipientAccount?: string;
    referenceNo?: string;
    transactionStatus?: string;
    amount?: number;
    serviceCharge?: number;
    vat?: number;
    totalAmount?: number;
    transactionDate?: string;
    invoiceNo?: string;
    error?: string;
}

/**
 * Verify a Zemen Bank transaction receipt.
 *
 * Zemen Bank receipt URL: https://share.zemenbank.com/rt/<reference>/pdf
 * Returns a PDF file parsed with pdf-parse (same pattern as Dashen).
 *
 * Reference: github.com/NahomAl/ethiobank_receipts (zemen.py extractor)
 */
export async function verifyZemen(
    transactionReference: string
): Promise<ZemenVerifyResult> {
    const url = `https://share.zemenbank.com/rt/${transactionReference}/pdf`;
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });
    const maxRetries = 3;
    const retryDelay = 2000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            logger.info(`🔎 Fetching Zemen receipt (Attempt ${attempt}/${maxRetries}): ${url}`);
            const response: AxiosResponse<ArrayBuffer> = await axios.get(url, {
                httpsAgent,
                responseType: 'arraybuffer',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                    'Accept': 'application/pdf',
                },
                timeout: 30000,
            });

            logger.info('✅ Zemen receipt fetch success, parsing PDF');
            return await parseZemenReceipt(response.data, transactionReference);
        } catch (error: any) {
            const isLastAttempt = attempt === maxRetries;
            const status = error.response?.status;

            logger.warn(`⚠️ Zemen receipt fetch failed (Attempt ${attempt}/${maxRetries}): ${error.message}`);

            if (isLastAttempt) {
                if (status === 404) {
                    return { success: false, error: 'Receipt not found. Check the reference and try again.' };
                }
                return { success: false, error: `Failed to fetch receipt after ${maxRetries} attempts: ${error.message}` };
            }

            logger.info(`⏳ Waiting ${retryDelay}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }

    return { success: false, error: 'Unknown error in retry loop' };
}

async function parseZemenReceipt(buffer: ArrayBuffer, reference: string): Promise<ZemenVerifyResult> {
    try {
        const parsed = await pdf(Buffer.from(buffer));
        const text = parsed.text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

        logger.info(`📄 Zemen PDF parsed, text length: ${text.length} chars`);

        const extract = (pattern: RegExp): string | undefined => {
            const match = text.match(pattern);
            return match ? match[1].trim() : undefined;
        };

        const parseAmount = (val: string | undefined): number | undefined => {
            if (!val) return undefined;
            const num = parseFloat(val.replace(/[^\d.]/g, ''));
            return isNaN(num) ? undefined : num;
        };

        const invoiceNo = extract(/Invoice No\.?:\s*(\d+)/);
        const date = extract(/Date[:\s]+([0-9]{1,2}-[A-Za-z]{3}-[0-9]{4})/);
        const payerName = extract(/Payer name:\s*([A-Z\s]+)/);
        const payerAccount = extract(/Payer account no\.?:\s*([\d*()X]+)/);
        const recipientName = extract(/Recipient name:\s*([A-Za-z\s.]+)/);
        const recipientAccount = extract(/Recipient account no\.?:\s*([\d*]+)/);
        const refNo = extract(/Reference No:\s*([A-Z0-9]+)/) || reference;
        const txnStatus = extract(/Transaction status:\s*(\w+)/);
        const settledAmount = extract(/ETB\s*([\d,]+\.\d{2})/);
        const serviceCharge = extract(/Service Charge ETB\s*([\d,]+\.\d{2})/);
        const vat = extract(/VAT 15% ETB\s*([\d,]+\.\d{2})/);
        const totalAmount = extract(/Total Amount Paid ETB\s*([\d,]+\.\d{2})/);

        const result: ZemenVerifyResult = {
            success: true,
            senderName: payerName,
            senderAccount: payerAccount,
            recipientName,
            recipientAccount,
            referenceNo: refNo,
            transactionStatus: txnStatus,
            amount: parseAmount(settledAmount),
            serviceCharge: parseAmount(serviceCharge),
            vat: parseAmount(vat),
            totalAmount: parseAmount(totalAmount),
            transactionDate: date,
            invoiceNo,
        };

        logger.info(`✅ Zemen receipt parsed: ${result.senderName} → ${result.recipientName}, ${result.amount} ETB`);

        if (!result.amount && !result.senderName) {
            return { success: false, error: 'Could not extract required fields from receipt.' };
        }

        return result;
    } catch (error: any) {
        logger.error('❌ Zemen PDF parsing failed:', error.message);
        return { success: false, error: 'Error parsing PDF data' };
    }
}
