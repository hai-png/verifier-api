import axios, { AxiosResponse } from 'axios';
import pdf from 'pdf-parse';
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
    const url = `https://share.zemenbank.com/rt/${encodeURIComponent(transactionReference)}/pdf`;
    // No `rejectUnauthorized: false`, and deliberately none. The PDF below is
    // regex-parsed and a successful parse reaches the merchant as a real
    // receipt, so disabling certificate validation would let anyone with a
    // network position against this host forge one. A receipt is one page and a
    // few tens of kilobytes; these bounds stop a hostile 500 MB body or a
    // thousand-page document from being buffered and rendered on a 512 MB
    // instance.
    const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
    const MAX_PDF_PAGES = 3;
    const maxRetries = 3;
    const retryDelay = 2000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            logger.info(`ðŸ”Ž Fetching Zemen receipt (Attempt ${attempt}/${maxRetries}): ${url}`);
            const response: AxiosResponse<ArrayBuffer> = await axios.get(url, {
                responseType: 'arraybuffer',
                maxContentLength: MAX_RESPONSE_BYTES,
                maxBodyLength: MAX_RESPONSE_BYTES,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                    'Accept': 'application/pdf',
                },
                timeout: 30000,
            });

            logger.info('âœ… Zemen receipt fetch success, parsing PDF');
            return await parseZemenReceipt(response.data, transactionReference);
        } catch (error: any) {
            const isLastAttempt = attempt === maxRetries;
            const status = error.response?.status;

            logger.warn(`âš ï¸ Zemen receipt fetch failed (Attempt ${attempt}/${maxRetries}): ${error.message}`);

            if (isLastAttempt) {
                if (status === 404) {
                    return { success: false, error: 'Receipt not found. Check the reference and try again.' };
                }
                return { success: false, error: `Failed to fetch receipt after ${maxRetries} attempts: ${error.message}` };
            }

            logger.info(`â³ Waiting ${retryDelay}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }

    return { success: false, error: 'Unknown error in retry loop' };
}

async function parseZemenReceipt(buffer: ArrayBuffer, reference: string): Promise<ZemenVerifyResult> {
    try {
        // `max` bounds the render. Without it a crafted document with thousands
        // of pages is fully rasterised in-process on the instance that is also
        // serving customer traffic.
        const parsed = await pdf(Buffer.from(buffer), { max: 3 });
        const text = parsed.text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

        logger.info(`ðŸ“„ Zemen PDF parsed, text length: ${text.length} chars`);

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

        logger.info(`âœ… Zemen receipt parsed: ${result.senderName} â†’ ${result.recipientName}, ${result.amount} ETB`);

        if (!result.amount && !result.senderName) {
            return { success: false, error: 'Could not extract required fields from receipt.' };
        }

        return result;
    } catch (error: any) {
        logger.error('âŒ Zemen PDF parsing failed:', error.message);
        return { success: false, error: 'Error parsing PDF data' };
    }
}
