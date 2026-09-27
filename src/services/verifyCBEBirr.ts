import axios from 'axios';
import pdfParse from 'pdf-parse';
import { VerifyResult } from './verifyCBE';
import logger from '../utils/logger';
import { receiptTextDigest, redactReceiptRecord } from '../utils/redactPii';

export interface CBEBirrReceipt {
  customerName: string;
  debitAccount: string;
  creditAccount: string;
  receiverName: string;
  orderId: string;
  transactionStatus: string;
  reference: string;
  receiptNumber: string;
  transactionDate: string;
  amount: string;
  paidAmount: string;
  serviceCharge: string;
  vat: string;
  totalPaidAmount: string;
  paymentReason: string;
  paymentChannel: string;
}

/**
 * Every other provider adapter returns `{ success: boolean, ...fields }`. This one
 * used to return a bare receipt object on success and `{ success: false }` on
 * failure, which forced every caller to special-case it — and forced
 * `executeVerification` to treat "no `success` field at all" as success, because
 * that was the only way a CBE Birr receipt could pass. That is a fail-open
 * contract: any adapter returning an unrecognised shape would be reported as a
 * confirmed payment. The envelope is now consistent, so the dispatcher can demand
 * positive proof.
 */
export async function verifyCBEBirr(
  receiptNumber: string,
  phoneNumber: string
): Promise<(CBEBirrReceipt & { success: true }) | { success: false; error: string }> {
  try {
    logger.info(`[CBEBirr] Starting verification for receipt ${receiptNumber.length} chars, phone ${phoneNumber.replace(/\d(?=\d{2})/g, '*')}`);

    // Construct the CBE Birr URL
    // Both values are caller-supplied and land in a query string, so both are
    // encoded. Interpolated raw, a receipt number of `X&PH=2519...` appended a
    // second parameter and changed whose receipt the bank was asked for.
    const url = `https://cbepay1.cbe.com.et/aureceipt?TID=${encodeURIComponent(receiptNumber)}&PH=${encodeURIComponent(phoneNumber)}`;
    logger.info(`[CBEBirr] Fetching PDF from: ${url}`);

    // Fetch the PDF
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 30000
    });

    logger.info(`[CBEBirr] PDF response status: ${response.status}`);
    logger.info(`[CBEBirr] PDF content length: ${response.data.length} bytes`);

    if (response.status !== 200) {
      logger.error(`[CBEBirr] Failed to fetch PDF: HTTP ${response.status}`);
      return { success: false, error: `Failed to fetch receipt: HTTP ${response.status}` };
    }

    // Unknown references answer HTTP 200 with an HTML error page instead of a
    // PDF — bail out before PDF parsing with a clear message.
    const contentType = String(response.headers?.['content-type'] ?? '');
    const firstBytes = Buffer.from(response.data).subarray(0, 5).toString('utf8');
    if (!/pdf/i.test(contentType) && firstBytes.trimStart().startsWith('<')) {
      logger.info('[CBEBirr] Receipt endpoint returned an HTML page — reference not found.');
      return { success: false, error: 'Receipt not found. Check the receipt number and phone.' };
    }

    // Parse the PDF
    const pdfBuffer = Buffer.from(response.data);
    const pdfData = await pdfParse(pdfBuffer);
    const pdfText = pdfData.text;

    // A CBE Birr receipt is a bank statement: payer name, phone, account. It used
    // to be written to the log three times over at INFO, which turned the log
    // directory into an unencrypted copy of customer banking data. The digest
    // below carries every fact needed to diagnose a parse failure (empty? HTML?
    // which labels present?) without any value.
    logger.info('[CBEBirr] PDF text extracted:', receiptTextDigest(pdfText));
    logger.debug('[CBEBirr] Raw PDF text (debug only, contains PII):', pdfText);

    // Parse the receipt data
    const receiptData = parseCBEBirrReceipt(pdfText);

    if (!receiptData) {
      logger.error('[CBEBirr] Failed to parse receipt data from PDF');
      return { success: false, error: 'Failed to parse receipt data from PDF' };
    }

    logger.info('[CBEBirr] Successfully parsed receipt data:', redactReceiptRecord(receiptData));
    // Receipt fields stay top-level: `extractPaymentDetails` and API consumers
    // read `paidAmount` / `creditAccount` straight off the payload.
    return { success: true, ...receiptData };

  } catch (error) {
    logger.error('[CBEBirr] Error during verification:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

function parseCBEBirrReceipt(pdfText: string): CBEBirrReceipt | null {
  try {
    logger.debug('[CBEBirr] Starting PDF text parsing...', receiptTextDigest(pdfText));

    const extractValue = (text: string, pattern: RegExp): string => {
      const match = text.match(pattern);
      const result = match && match[1] ? match[1].trim() : '';
      // Optional: Clean up messy newlines inside the captured result
      return result.replace(/\n/g, ' ').replace(/\s{2,}/g, ' ');
    };

    // 1. Customer Name (Trapped between 'Sub city:' and 'Wereda/kebele:')
    const customerName = extractValue(pdfText, /Sub city:[\s\n]+([A-Z\s]+?)[\s\n]+Wereda\/kebele:/i);

    // 2. Account Details (Using [\s\S]*? to safely capture across newlines before the next label)
    const debitAccountMatch = pdfText.match(/Debit Account\s*(Org Account|[\s\S]*?)(?=\s*Credit Account)/i);
    const debitAccount = debitAccountMatch ? debitAccountMatch[1].replace(/\n/g, ' ').trim() : '';
    const creditAccount = extractValue(pdfText, /Credit Account\s*([\s\S]*?)(?=\s*Receiver Name)/i);
    const receiverName = extractValue(pdfText, /Receiver Name\s*([\s\S]*?)(?=\s*Order ID)/i);

    // 3. Status and IDs
    const orderId = extractValue(pdfText, /Order ID\s*([A-Z0-9]+)/i);
    const transactionStatus = extractValue(pdfText, /Transaction Status\s*([a-zA-Z]+)/i);

    // Reference (Captures ANY text after "Reference" until the next known section header)
    const refMatch = pdfText.match(/Reference[\s:]*([\s\S]*?)(?=\s*(?:Transaction Details|Receipt Number|የኢትዮጵያ|Commercial Bank))/i);
    let reference = refMatch ? refMatch[1].replace(/\n/g, ' ').trim() : '';

    // Aggressively strip any leading or trailing spaces and colons caused by the PDF parser
    reference = reference.replace(/^[\s:]+|[\s:]+$/g, '');

    // 4. Receipt Data
    const receiptDataMatch = pdfText.match(/([A-Z0-9]{10})(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})([\d.]+)/);
    const receiptNumber = receiptDataMatch ? receiptDataMatch[1] : '';
    const transactionDate = receiptDataMatch ? receiptDataMatch[2] : '';
    const amount = receiptDataMatch ? receiptDataMatch[3] : '';

    // 5. Financial Details Block (Values are dumped *before* the labels)
    const financialMatch = pdfText.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+Paid amount/i);
    const paidAmount = financialMatch ? financialMatch[1] : '';
    const serviceCharge = financialMatch ? financialMatch[2] : '';
    const vat = financialMatch ? financialMatch[3] : '';
    const totalPaidAmount = financialMatch ? financialMatch[4] : '';

    // 6. Payment Details Block (Labels are dumped *before* the values)
    // Matches: Payment Channel \n Seventy... \n Transfer... \n USSD
    const paymentMatch = pdfText.match(/Payment Channel[\s\n]+([^\n]+)[\s\n]+([^\n]+)[\s\n]+([^\n]+)/i);
    const paymentReason = paymentMatch ? paymentMatch[2].trim() : '';
    const paymentChannel = paymentMatch ? paymentMatch[3].trim() : '';

    const receiptData: CBEBirrReceipt = {
      customerName,
      debitAccount,
      creditAccount,
      receiverName,
      orderId,
      transactionStatus,
      reference,
      receiptNumber,
      transactionDate,
      amount,
      paidAmount,
      serviceCharge,
      vat,
      totalPaidAmount,
      paymentReason,
      paymentChannel
    };

    logger.debug('[CBEBirr] Extracted receipt data:', redactReceiptRecord(receiptData));

    // Validate that we have at least some essential fields
    if (!customerName && !receiptNumber && !amount) {
      logger.warn('[CBEBirr] No essential fields found in PDF');
      return null;
    }

    return receiptData;

  } catch (error) {
    logger.error('[CBEBirr] Error parsing PDF text:', error);
    return null;
  }
}
