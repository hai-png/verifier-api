import axios, { AxiosResponse } from 'axios';
import logger from '../utils/logger';

export interface DashenVerifyResult {
    success: boolean;
    senderName?: string;
    senderAccountNumber?: string;
    transactionChannel?: string;
    serviceType?: string;
    narrative?: string;
    receiverName?: string;
    phoneNo?: string;
    institutionName?: string;
    transactionReference?: string;
    transferReference?: string;
    transactionDate?: Date;
    transactionAmount?: number;
    serviceCharge?: number;
    exciseTax?: number;
    vat?: number;
    penaltyFee?: number;
    incomeTaxFee?: number;
    interestFee?: number;
    stampDuty?: number;
    discountAmount?: number;
    total?: number;
    error?: string;
}

function titleCase(str: string): string {
    return str.toLowerCase().replace(/\b\w/g, char => char.toUpperCase());
}

/**
 * Verify a Dashen Bank transaction receipt.
 *
 * Receipt URL: https://receipts.dashenbanksc.com/receipt/<reference>
 * Returns an HTML receipt page (label/value layout). Unknown references get
 * HTTP 400 + {"message":"Transaction not found"}.
 */
export async function verifyDashen(
    transactionReference: string
): Promise<DashenVerifyResult> {
    const url = `https://receipts.dashenbanksc.com/receipt/${transactionReference}`;
    const maxRetries = 5;
    const retryDelay = 2000; // 2 seconds

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            logger.info(`🔎 Fetching Dashen receipt (Attempt ${attempt}/${maxRetries}): ${url}`);
            const response: AxiosResponse<string> = await axios.get(url, {
                responseType: 'text',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                    'Accept': 'text/html,application/xhtml+xml',
                },
                timeout: 30000,
            });

            logger.info('✅ Dashen receipt fetch success, parsing HTML');
            return parseDashenReceipt(response.data, transactionReference);
        } catch (error: any) {
            const isLastAttempt = attempt === maxRetries;
            const status = error.response?.status;

            logger.warn(`⚠️ Dashen receipt fetch failed (Attempt ${attempt}/${maxRetries}): ${error.message}`);

            // Unknown/expired references — the host answers 400, no point retrying.
            if (status === 400) {
                return { success: false, error: 'Receipt not found. Check the reference and try again.' };
            }

            // If it's the last attempt, return failure
            if (isLastAttempt) {
                logger.error('❌ All retry attempts failed for Dashen receipt.');
                return {
                    success: false,
                    error: `Failed to fetch receipt after ${maxRetries} attempts: ${error.message}`
                };
            }

            // Wait before retrying
            logger.info(`⏳ Waiting ${retryDelay}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }

    // Should theoretically not reach here due to the return in loop
    return {
        success: false,
        error: 'Unknown error in retry loop'
    };
}

function decodeEntities(value: string): string {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

/** Extract label → value pairs from the receipt HTML. */
function extractFields(html: string): Record<string, string> {
    const withoutScripts = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ');
    const text = withoutScripts.replace(/<[^>]+>/g, '|');
    const parts = text.split('|').map(p => decodeEntities(p).trim()).filter(Boolean);
    const fields: Record<string, string> = {};
    for (let i = 0; i + 1 < parts.length; i += 1) {
        const label = parts[i].replace(/:$/, '').trim();
        const value = parts[i + 1].trim();
        if (label && value && !(label in fields)) {
            fields[label] = value;
        }
    }
    return fields;
}

function parseAmount(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const num = parseFloat(value.replace(/[^0-9.]/g, ''));
    return isNaN(num) ? undefined : num;
}

function parseReceiptDate(value: string | undefined): Date | undefined {
    if (!value) return undefined;
    // "Sep 5, 2026, 05:56:21 pm" → drop the comma after the year for Date.parse
    const normalized = value.replace(/(\d{4}),/, '$1');
    const time = Date.parse(normalized);
    return isNaN(time) ? undefined : new Date(time);
}

function parseDashenReceipt(html: string, reference: string): DashenVerifyResult {
    try {
        const data = extractFields(html);

        const transactionReference = data['Transaction Reference'] || reference;
        if (!data['Transaction Reference'] && Object.keys(data).length < 5) {
            return { success: false, error: 'No receipt data found. The reference may be invalid.' };
        }

        return {
            success: true,
            senderName: data['Sender Name'] ? titleCase(data['Sender Name']) : undefined,
            senderAccountNumber: data['Sender Account Number'] || data['Sender Account'],
            transactionChannel: data['Transaction Channel'],
            serviceType: data['Service Type'],
            narrative: data['Narrative'],
            receiverName: data['Receiver Name'] ? titleCase(data['Receiver Name']) : undefined,
            phoneNo: data['Phone No.'] || data['Phone No'],
            institutionName: data['Institution Name'],
            transactionReference,
            transferReference: data['Transfer Reference'],
            transactionDate: parseReceiptDate(data['Transaction Date']),
            transactionAmount: parseAmount(data['Transaction Amount']),
            serviceCharge: parseAmount(data['Service Charge']),
            exciseTax: parseAmount(data['Excise Tax (15%)'] ?? data['Excise Tax']),
            vat: parseAmount(data['VAT (15%)'] ?? data['VAT']),
            penaltyFee: parseAmount(data['Penalty Fee']),
            incomeTaxFee: parseAmount(data['Income Tax Fee']),
            interestFee: parseAmount(data['Interest Fee']),
            stampDuty: parseAmount(data['Stamp Duty']),
            discountAmount: parseAmount(data['Discount Amount']),
            total: parseAmount(data['Total']),
        };
    } catch (parseErr: any) {
        logger.error('❌ Dashen HTML parsing failed:', parseErr.message);
        return {
            success: false,
            error: 'Error parsing receipt data'
        };
    }
}
