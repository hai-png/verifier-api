import axios, { AxiosResponse } from 'axios';
import https from 'https';
import logger from '../utils/logger';

export interface AwashVerifyResult {
    success: boolean;
    senderName?: string;
    senderAccount?: string;
    beneficiaryName?: string;
    beneficiaryAccount?: string;
    beneficiaryBank?: string;
    transactionType?: string;
    transactionId?: string;
    transactionDate?: string;
    amount?: number;
    charge?: number;
    vat?: number;
    reason?: string;
    error?: string;
}

/**
 * Verify an Awash Bank transaction receipt.
 *
 * Awash Bank receipt URL: https://awashpay.awashbank.com:8225/-<reference>
 * Returns an HTML page with a <table class="info-table"> containing transaction details.
 *
 * Reference: github.com/NahomAl/ethiobank_receipts (awash.py extractor)
 */
export async function verifyAwash(
    transactionReference: string
): Promise<AwashVerifyResult> {
    const url = `https://awashpay.awashbank.com:8225/-${transactionReference}`;
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });
    const maxRetries = 3;
    const retryDelay = 2000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            logger.info(`🔎 Fetching Awash receipt (Attempt ${attempt}/${maxRetries}): ${url}`);
            const response: AxiosResponse<string> = await axios.get(url, {
                httpsAgent,
                responseType: 'text',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                    'Accept': 'text/html',
                },
                timeout: 30000,
            });

            logger.info('✅ Awash receipt fetch success, parsing HTML');
            return parseAwashReceipt(response.data, transactionReference);
        } catch (error: any) {
            const isLastAttempt = attempt === maxRetries;
            const status = error.response?.status;

            logger.warn(`⚠️ Awash receipt fetch failed (Attempt ${attempt}/${maxRetries}): ${error.message}`);

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

function parseAwashReceipt(html: string, reference: string): AwashVerifyResult {
    try {
        // Awash Bank receipts use <table class="info-table"> with <tr> rows.
        // Each row has 3 <td> cells: label, spacer, value.
        const data: Record<string, string> = {};
        const rowRegex = /<tr>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]+)<\/td>\s*<\/tr>/gi;
        let match: RegExpExecArray | null;

        while ((match = rowRegex.exec(html)) !== null) {
            const key = match[1].trim().replace(/:$/, '');
            const value = match[3].trim();
            if (key && value) data[key] = value;
        }

        if (Object.keys(data).length === 0) {
            return { success: false, error: 'No receipt data found. The reference may be invalid.' };
        }

        const parseAmount = (val: string | undefined): number | undefined => {
            if (!val) return undefined;
            const num = parseFloat(val.replace(/[^\d.]/g, ''));
            return isNaN(num) ? undefined : num;
        };

        const result: AwashVerifyResult = {
            success: true,
            senderName: data['Sender Name'],
            senderAccount: data['Sender Account'],
            beneficiaryName: data['Beneficiary name'],
            beneficiaryAccount: data['Beneficiary Account'],
            beneficiaryBank: data['Beneficiary Bank'],
            transactionType: data['Transaction Type'],
            transactionId: data['Transaction ID'] || reference,
            transactionDate: data['Transaction Time'],
            amount: parseAmount(data['Amount']),
            charge: parseAmount(data['Charge']),
            vat: parseAmount(data['VAT']),
            reason: data['Reason'],
        };

        logger.info(`✅ Awash receipt parsed: ${result.senderName} → ${result.beneficiaryName}, ${result.amount} ETB`);

        if (!result.amount && !result.senderName) {
            return { success: false, error: 'Could not extract required fields from receipt.' };
        }

        return result;
    } catch (error: any) {
        logger.error('❌ Awash receipt parsing failed:', error.message);
        return { success: false, error: 'Error parsing receipt data' };
    }
}
