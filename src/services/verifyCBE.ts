import axios, { AxiosResponse } from 'axios';
import pdf from 'pdf-parse';
import fs from 'fs';
import puppeteer, { Browser, HTTPResponse, Page } from 'puppeteer';
import logger from '../utils/logger';
import { extractLegacyCbeUrlData, extractNewCbeToken } from '../utils/cbeReference';

export interface VerifyResult {
    success: boolean;
    payer?: string;
    payerAccount?: string;
    receiver?: string;
    receiverAccount?: string;
    amount?: number;
    date?: Date;
    reference?: string;
    reason?: string | null;
    error?: string;
    statusCode?: number;
}

function titleCase(str: string): string {
    return str.toLowerCase().replace(/\b\w/g, char => char.toUpperCase());
}

interface CBETransactionResponse {
    success?: boolean;
    id?: string;
    debitAccountHolder?: string;
    debitAccountNo?: string;
    creditAccountHolder?: string;
    creditAccountNo?: string;
    amountCredited?: string | number;
    dateTimes?: string[];
    paymentDetails?: string[];
    data?: CBETransactionResponse;
    message?: string;
}

function parseAmount(value?: string | number): number | undefined {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }

    const parsed = value ? Number.parseFloat(value.replace(/,/g, '')) : NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
}

function validDate(value?: string): Date | undefined {
    if (!value) return undefined;

    // Node does not consistently parse the DD/MM/YYYY format printed in CBE
    // PDFs, especially when the day is greater than 12. Parse it explicitly
    // before falling back to the built-in parser for ISO responses.
    const cbeDate = value.match(
        /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})[,\s]+(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)$/i
    );
    if (cbeDate) {
        const [, day, month, year, hour, minute, second, meridiem] = cbeDate;
        let hour24 = Number(hour) % 12;
        if (meridiem.toUpperCase() === 'PM') hour24 += 12;
        const date = new Date(
            Number(year),
            Number(month) - 1,
            Number(day),
            hour24,
            Number(minute),
            Number(second)
        );
        return Number.isNaN(date.getTime()) ? undefined : date;
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
}

function mapNewCBEReceipt(responseData: CBETransactionResponse): VerifyResult {
    const data = responseData.data && typeof responseData.data === 'object'
        ? responseData.data
        : responseData;

    if (responseData.success === false || data.success === false) {
        return {
            success: false,
            error: responseData.message || 'CBE receipt token was rejected.',
            statusCode: 404
        };
    }

    const amount = parseAmount(data.amountCredited);
    const date = validDate(data.dateTimes?.[0]);

    if (!data.id || !data.debitAccountHolder || !data.creditAccountHolder || amount === undefined || !date) {
        return {
            success: false,
            error: 'CBE returned an incomplete receipt.',
            statusCode: 502
        };
    }

    return {
        success: true,
        payer: data.debitAccountHolder,
        payerAccount: data.debitAccountNo,
        receiver: data.creditAccountHolder,
        receiverAccount: data.creditAccountNo,
        amount,
        date,
        reference: data.id,
        reason: data.paymentDetails?.join(' ') || null
    };
}

let browser: Browser | null = null;

class CBEReceiptNotFoundError extends Error {
    readonly statusCode = 404;

    constructor() {
        super('CBE did not find a receipt for that reference and account suffix.');
        this.name = 'CBEReceiptNotFoundError';
    }
}

function isCBEReceiptNotFoundResponse(status: number, buffer: Buffer | Uint8Array): boolean {
    if (status === 404) return true;

    const body = Buffer.from(buffer).toString('utf8').toLowerCase();
    return body.includes('you are not allowed to see this data')
        || body.includes('please check your link');
}

function notFoundResult(): VerifyResult {
    return {
        success: false,
        error: 'CBE receipt not found. Check the FT reference and use the last 8 digits of the payer account as the suffix.',
        statusCode: 404
    };
}

export function getChromeExecutablePath(): string | undefined {
    // Render's native Node runtime does not provide Chrome. Prefer an explicit
    // path, then Puppeteer's configured cache, and finally common system paths.
    const possiblePaths = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        process.env.CHROME_BIN,
        process.env.CHROMIUM_PATH,
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
    ];

    try {
        const puppeteerPath = puppeteer.executablePath();
        if (puppeteerPath) possiblePaths.push(puppeteerPath);
    } catch {
        // Puppeteer throws when its browser cache is not configured.
    }

    const cacheDirs = [
        process.env.PUPPETEER_CACHE_DIR,
        '/opt/render/.cache/puppeteer',
        '/root/.cache/puppeteer',
        `${process.cwd()}/.cache/puppeteer`,
    ].filter((value): value is string => Boolean(value));

    for (const cacheDir of cacheDirs) {
        try {
            if (!fs.existsSync(cacheDir)) continue;
            const chromeDirs = fs.readdirSync(cacheDir, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory() && dirent.name.startsWith('chrome'))
                .map(dirent => dirent.name)
                .sort()
                .reverse();

            for (const chromeDir of chromeDirs) {
                const candidates = [
                    `${cacheDir}/${chromeDir}/chrome-linux64/chrome`,
                    `${cacheDir}/${chromeDir}/chrome-linux/chrome`,
                ];
                possiblePaths.push(...candidates);
            }
        } catch {
            // Ignore an unreadable cache directory and continue with the other paths.
        }
    }

    for (const path of possiblePaths) {
        if (path && fs.existsSync(path)) {
            logger.info(`🔍 Found Chrome/Chromium at: ${path}`);
            return path;
        }
    }

    logger.warn(
        '⚠️ Chrome/Chromium not found. Checked: ' +
        possiblePaths.filter(Boolean).join(', ')
    );
    return undefined;
}

// ─── Browser concurrency guard ────────────────────────────────────────────────
// Legacy CBE verification drives headless Chromium. Each in-flight verification
// opens its own page, and a Render free instance has 512 MB of RAM, so a burst
// of legacy receipts could take the whole service down. Serialise browser work
// (configurable) and give queued requests a deadline instead of piling up.
const MAX_CONCURRENT_BROWSER_OPS = Math.max(
    1,
    Number(process.env.CBE_MAX_CONCURRENT_BROWSER_OPS ?? 1)
);
const BROWSER_QUEUE_TIMEOUT_MS = Math.max(
    1_000,
    Number(process.env.CBE_BROWSER_QUEUE_TIMEOUT_MS ?? 20_000)
);

let activeBrowserOps = 0;
const browserQueue: Array<{ resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];

export function browserQueueState() {
    return { active: activeBrowserOps, queued: browserQueue.length, maxConcurrent: MAX_CONCURRENT_BROWSER_OPS };
}

async function acquireBrowserSlot(): Promise<void> {
    if (activeBrowserOps < MAX_CONCURRENT_BROWSER_OPS) {
        activeBrowserOps += 1;
        return;
    }

    await new Promise<void>((resolve, reject) => {
        const entry = {
            resolve: () => {
                clearTimeout(entry.timer);
                activeBrowserOps += 1;
                resolve();
            },
            reject: (error: Error) => {
                clearTimeout(entry.timer);
                reject(error);
            },
            timer: setTimeout(() => {
                const index = browserQueue.indexOf(entry);
                if (index >= 0) browserQueue.splice(index, 1);
                reject(new Error('Legacy CBE verification is busy. Please retry in a moment.'));
            }, BROWSER_QUEUE_TIMEOUT_MS),
        };
        entry.timer.unref?.();
        browserQueue.push(entry);
    });
}

function releaseBrowserSlot(): void {
    activeBrowserOps = Math.max(0, activeBrowserOps - 1);
    const next = browserQueue.shift();
    if (next) next.resolve();
}

/**
 * Chromium launch options for the legacy CBE fallback.
 *
 * Exported so the arguments are assertable without a browser present. The
 * security-relevant part is the absence of `--ignore-certificate-errors`: the
 * page this drives serves the receipt, and that receipt is the verification, so
 * ignoring certificate errors would let anyone with a network position against
 * apps.cbe.com.et serve a forged one.
 *
 * `--no-sandbox` is still required — the Dockerfile installs Debian Chromium in
 * a container with no user namespace — and does not weaken TLS.
 */
export function cbeChromeLaunchOptions(executablePath: string): Record<string, unknown> {
    return {
        headless: true,
        executablePath,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-default-apps',
            '--disable-sync',
            '--disable-translate',
            '--hide-scrollbars',
            '--mute-audio',
        ],
    };
}

async function getBrowser(): Promise<Browser> {
    if (browser && browser.isConnected()) {
        return browser;
    }

    const executablePath = getChromeExecutablePath();
    if (!executablePath) {
        throw new Error(
            'Chrome/Chromium is not installed. Deploy the Dockerfile or run "npx puppeteer browsers install chrome" during the Render build.'
        );
    }

    const launchOptions = cbeChromeLaunchOptions(executablePath);

    logger.info(`🔧 Using Chrome at: ${executablePath}`);
    // @types/puppeteer 5 is also installed for legacy imports in this project
    // and conflicts with Puppeteer 22's LaunchOptions type.
    browser = await puppeteer.launch(launchOptions as any);
    return browser;
}

function isPdfBuffer(buffer: Buffer | Uint8Array): boolean {
    return Buffer.from(buffer).subarray(0, 5).toString('ascii') === '%PDF-';
}

function responseContentType(response: HTTPResponse): string {
    return response.headers()['content-type']?.toLowerCase() || '';
}

function validatePdfBuffer(
    buffer: Buffer | Uint8Array,
    status: number,
    contentType: string,
    source: string
): Buffer {
    const normalizedBuffer = Buffer.from(buffer);
    if (isCBEReceiptNotFoundResponse(status, normalizedBuffer)) {
        throw new CBEReceiptNotFoundError();
    }
    if (status >= 400) {
        throw new Error(`CBE receipt endpoint returned HTTP ${status}`);
    }

    // Do not trust Content-Type alone. CBE sometimes returns an HTML error page
    // with HTTP 200, which used to be passed to pdf-parse as if it were a PDF.
    //
    // The upstream body is logged, never returned. This function's message
    // travels all the way out to the API caller (via verifyResult.error), and an
    // HTML error page from a bank carries internal hostnames, request ids and
    // sometimes infrastructure detail. The caller only needs to know it was not
    // a PDF; an operator has the log.
    if (!isPdfBuffer(normalizedBuffer)) {
        const preview = normalizedBuffer
            .toString('utf8')
            .replace(/\s+/g, ' ')
            .slice(0, 180);
        logger.warn(`CBE ${source} returned a non-PDF body (HTTP ${status}, ${contentType || 'unknown content type'}): ${preview}`);
        throw new Error(
            `CBE ${source} response was not a PDF (HTTP ${status}, ${contentType || 'unknown content type'})`
        );
    }

    return normalizedBuffer;
}

async function waitForPdfResponse(page: Page, timeoutMs: number): Promise<HTTPResponse | null> {
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            page.off('response', onResponse);
            resolve(null);
        }, timeoutMs);

        const onResponse = (response: HTTPResponse) => {
            // Pinned to CBE's own receipt host. Without this the listener
            // accepted a PDF from *any* origin the page happened to contact, so
            // a third-party resource on CBE's page — or anything the page was
            // redirected to — could supply the document that parseCBEReceipt
            // then reports as a verified payment.
            let origin = '';
            try {
                origin = new URL(response.url()).hostname.toLowerCase();
            } catch {
                return;
            }
            if (origin !== 'apps.cbe.com.et') return;
            if (responseContentType(response).includes('pdf')) {
                clearTimeout(timer);
                page.off('response', onResponse);
                resolve(response);
            }
        };

        page.on('response', onResponse);
    });
}

async function fetchCBEReceiptWithPuppeteer(fullId: string): Promise<ArrayBuffer> {
    const url = `https://apps.cbe.com.et:100/?id=${encodeURIComponent(fullId)}`;
    // Bound concurrent Chromium work so a burst cannot exhaust the instance.
    await acquireBrowserSlot();
    try {
        const b = await getBrowser();
        const page: Page = await b.newPage();
        const result = await renderCBEReceiptPage(page, url);
        // Armed after the page closes, and re-armed by the next caller, so an
        // idle Chromium is released without losing the warm-start benefit.
        scheduleBrowserIdleClose();
        return result;
    } finally {
        releaseBrowserSlot();
    }
}

async function renderCBEReceiptPage(page: Page, url: string): Promise<ArrayBuffer> {
    try {
        logger.info(`🔎 Puppeteer fetching CBE receipt: ${url}`);
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        // Install the listener before navigation. If CBE serves the PDF through
        // a redirect or a small client-side request, this still captures it.
        const pdfResponsePromise = waitForPdfResponse(page, 15_000);
        const navigationResponse = await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
        });

        if (navigationResponse) {
            const navigationBuffer = await navigationResponse.buffer();
            if (isCBEReceiptNotFoundResponse(navigationResponse.status(), navigationBuffer)) {
                throw new CBEReceiptNotFoundError();
            }
            if (isPdfBuffer(navigationBuffer)) {
                const buffer = validatePdfBuffer(
                    navigationBuffer,
                    navigationResponse.status(),
                    responseContentType(navigationResponse),
                    'Puppeteer navigation'
                );
                return buffer.buffer.slice(
                    buffer.byteOffset,
                    buffer.byteOffset + buffer.byteLength
                ) as ArrayBuffer;
            }
        }

        const pdfResponse = await pdfResponsePromise;
        if (pdfResponse) {
            const buffer = validatePdfBuffer(
                await pdfResponse.buffer(),
                pdfResponse.status(),
                responseContentType(pdfResponse),
                'Puppeteer response'
            );
            return buffer.buffer.slice(
                buffer.byteOffset,
                buffer.byteOffset + buffer.byteLength
            ) as ArrayBuffer;
        }

        const contentType = navigationResponse
            ? responseContentType(navigationResponse)
            : 'no response';
        // page.content() is the live DOM of CBE's error page. Logged, never
        // returned — this message is surfaced to the API caller verbatim.
        const htmlPreview = (await page.content())
            .replace(/\s+/g, ' ')
            .slice(0, 180);
        logger.warn(`CBE Puppeteer response was not a PDF (${contentType}). Page: ${htmlPreview}`);
        throw new Error(`CBE Puppeteer response was not a PDF (${contentType})`);
    } finally {
        await page.close();
    }
}

export async function verifyCBELegacy(
    reference: string,
    accountSuffix: string
): Promise<VerifyResult> {
    const fullId = `${reference}${accountSuffix}`;
    const url = `https://apps.cbe.com.et:100/?id=${encodeURIComponent(fullId)}`;
    // Certificate validation stays on. This endpoint serves the receipt itself,
    // so `rejectUnauthorized: false` here means anyone able to intercept the
    // connection can serve a forged PDF that parseCBEReceipt reports as a
    // verified payment. If CBE's certificate chain is genuinely broken, pin
    // its CA instead of turning the check off. The body bound stops a hostile
    // or broken endpoint from buffering an unbounded response on a 512 MB
    // instance; a CBE receipt is one page and tens of kilobytes.
    const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

    try {
        logger.info(`🔎 Attempting direct CBE PDF fetch: ${url}`);
        const response: AxiosResponse<ArrayBuffer> = await axios.get(url, {
            responseType: 'arraybuffer',
            maxContentLength: MAX_RESPONSE_BYTES,
            maxBodyLength: MAX_RESPONSE_BYTES,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.1'
            },
            timeout: 30_000,
            validateStatus: status => status >= 200 && status < 500,
        });

        const pdfBuffer = validatePdfBuffer(
            Buffer.from(response.data),
            response.status,
            String(response.headers['content-type'] || ''),
            'direct'
        );
        logger.info('✅ Direct CBE fetch returned a PDF, parsing receipt');
        return await parseCBEReceipt(pdfBuffer);
    } catch (directErr: any) {
        const directMessage = directErr instanceof Error ? directErr.message : String(directErr);
        if (directErr instanceof CBEReceiptNotFoundError) {
            logger.warn(`⚠️ CBE rejected the legacy receipt link: ${directMessage}`);
            return notFoundResult();
        }

        logger.warn(`⚠️ Direct CBE fetch failed, trying Puppeteer fallback: ${directMessage}`);

        try {
            const pdfBuffer = await fetchCBEReceiptWithPuppeteer(fullId);
            logger.info('✅ Puppeteer CBE fallback returned a PDF, parsing receipt');
            return await parseCBEReceipt(pdfBuffer);
        } catch (puppeteerErr: any) {
            if (puppeteerErr instanceof CBEReceiptNotFoundError) {
                logger.warn(`⚠️ CBE rejected the legacy receipt link in Puppeteer: ${puppeteerErr.message}`);
                return notFoundResult();
            }

            const puppeteerMessage = puppeteerErr instanceof Error
                ? puppeteerErr.message
                : String(puppeteerErr);
            logger.error(`❌ CBE direct and Puppeteer fetches failed. Direct: ${directMessage}. Puppeteer: ${puppeteerMessage}`);
            // Both underlying messages stay in the log. Concatenated into the
            // response they exposed the upstream host (`getaddrinfo ENOTFOUND
            // apps.cbe.com.et`), the local Chrome path from getChromeExecutablePath()
            // and whatever HTML the bank returned. The caller learns that the
            // fetch failed and can retry; an operator has everything else.
            return {
                success: false,
                error: 'CBE receipt could not be fetched. Please retry in a few seconds.',
                statusCode: 502
            };
        }
    }
}

export async function verifyCBENew(token: string): Promise<VerifyResult> {
    const url = `https://mb.cbe.com.et/api/v1/transactions/public/transaction-detail/${encodeURIComponent(token)}`;
    const MAX_RESPONSE_BYTES = 1024 * 1024;
    const maxRetries = 4;
    const retryDelayMs = 1_800;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            logger.info(`🔎 Attempting new CBE JSON fetch (${attempt}/${maxRetries}): ${url}`);
            const response = await axios.get<CBETransactionResponse>(url, {
                maxContentLength: MAX_RESPONSE_BYTES,
                maxBodyLength: MAX_RESPONSE_BYTES,
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'Origin': 'https://mbreciept.cbe.com.et',
                    'Referer': 'https://mbreciept.cbe.com.et/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                    'x-app-id': process.env.CBE_APP_ID || 'd1292e42-7400-49de-a2d3-9731caa4c819',
                    'x-app-version': process.env.CBE_APP_VERSION || '0a01980b-9859-1369-8198-59f403820000'
                },
                timeout: 15_000
            });

            return mapNewCBEReceipt(response.data);
        } catch (err: any) {
            const statusCode = err.response?.status;
            const isLastAttempt = attempt === maxRetries;
            const isRetryable =
                !statusCode ||
                statusCode === 429 ||
                statusCode === 502 ||
                statusCode === 503 ||
                statusCode === 504;

            logger.warn(`⚠️ New CBE verification attempt ${attempt}/${maxRetries} failed: ${err.message}`);

            if (statusCode === 400 || statusCode === 404) {
                return {
                    success: false,
                    error: 'Invalid or expired CBE receipt token.',
                    statusCode: 404
                };
            }

            if (!isRetryable || isLastAttempt) {
                return {
                    success: false,
                    error: 'CBE receipt service is temporarily unavailable. Please try again.',
                    statusCode: 502
                };
            }

            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        }
    }

    return {
        success: false,
        error: 'CBE receipt service is temporarily unavailable. Please try again.',
        statusCode: 502
    };
}

export async function verifyCBE(reference: string, accountSuffix?: string): Promise<VerifyResult> {
    const legacyLink = extractLegacyCbeUrlData(reference);
    if (legacyLink) {
        // The suffix embedded in a CBE legacy receipt URL belongs to the
        // payer's account and is part of the receipt lookup key. Do not let a
        // separately supplied merchant/payout suffix override it.
        return verifyCBELegacy(legacyLink.reference, legacyLink.suffix);
    }

    const token = extractNewCbeToken(reference);
    if (token) return verifyCBENew(token);
    if (!accountSuffix?.trim()) {
        return {
            success: false,
            error: 'Missing accountSuffix for legacy CBE verification.',
            statusCode: 400
        };
    }
    return verifyCBELegacy(reference.trim(), accountSuffix.trim());
}

async function parseCBEReceipt(buffer: ArrayBuffer | Buffer): Promise<VerifyResult> {
    try {
        const pdfBuffer = Buffer.isBuffer(buffer)
            ? buffer
            : Buffer.from(new Uint8Array(buffer));
        // `max` bounds the render. A crafted document with thousands of pages
        // would otherwise be fully rasterised in-process, on the instance that
        // is also serving customer traffic. A CBE receipt is one page.
        const parsed = await pdf(pdfBuffer, { max: 3 });
        const rawText = parsed.text.replace(/\s+/g, ' ').trim();

        // Every field is matched against its own label. The accounts used to be
        // collected by an unanchored /Account.../g and then assigned by document
        // position — payer = [0], receiver = [1] — which meant any layout change
        // could silently swap them, and a receipt reading "Account No: 1000123456"
        // matched the word "Number" as the account. Swapping payer and receiver is
        // not a cosmetic bug: receiverAccount is what the recipient check reads,
        // so a swapped pair verifies a payment that went somewhere else.
        const payerName = rawText.match(/Payer\s*:?\s*(.*?)\s+Account/i)?.[1]?.trim();
        const receiverName = rawText.match(/Receiver\s*:?\s*(.*?)\s+Account/i)?.[1]?.trim();
        const accountValue = '(?:[A-Z0-9]?\\*{4}\\s*\\d{4}|\\d[\\d*\\-]{5,29}|[A-Z0-9][A-Z0-9*]{5,29})';
        const payerAccount = rawText
            .match(new RegExp(`Payer\\s*:?\\s*(?:name\\s*:?\\s*.*?\\s*)?Account\\s*(?:no\\.?|number)?\\s*:?\\s*(${accountValue})`, 'i'))?.[1]
            ?.replace(/\s+/g, '')
            .trim();
        const receiverAccount = rawText
            .match(new RegExp(`Receiver\\s*:?\\s*(?:name\\s*:?\\s*.*?\\s*)?Account\\s*(?:no\\.?|number)?\\s*:?\\s*(${accountValue})`, 'i'))?.[1]
            ?.replace(/\s+/g, '')
            .trim();

        const reason = rawText.match(/Reason\s*\/\s*Type of service\s*:?\s*(.*?)\s+Transferred Amount/i)?.[1]?.trim();
        const amountText = rawText.match(/Transferred Amount\s*:?\s*([\d,]+(?:\.\d+)?)\s*ETB/i)?.[1];
        const referenceMatch = rawText.match(/Reference\s*No\.?\s*(?:\(\s*VAT\s+Invoice\s+No\s*\))?\s*:?\s*([A-Z0-9-]+)/i)?.[1]?.trim();
        const dateRaw = rawText.match(/Payment Date\s*&\s*Time\s*:?\s*([\d\/,: -]+[APM]{2})/i)?.[1]?.trim();

        const amount = parseAmount(amountText);
        const date = dateRaw ? validDate(dateRaw) : undefined;

        const payerNameTitled = payerName ? titleCase(payerName) : undefined;
        const receiverNameTitled = receiverName ? titleCase(receiverName) : undefined;

        if (payerNameTitled && payerAccount && receiverNameTitled && receiverAccount && amount !== undefined && date && referenceMatch) {
            return {
                success: true,
                payer: payerNameTitled,
                payerAccount,
                receiver: receiverNameTitled,
                receiverAccount,
                amount,
                date,
                reference: referenceMatch,
                reason: reason || null
            };
        }

        return {
            success: false,
            error: 'Could not extract all required fields from the CBE PDF.'
        };
    } catch (parseErr: any) {
        logger.error(`❌ CBE PDF parsing failed: ${parseErr.message}`);
        return { success: false, error: 'Error parsing CBE PDF data' };
    }
}

/**
 * Chromium holds 150–300 MB once launched, on a 512 MB instance that is also
 * serving every other request. It was previously closed only at process
 * shutdown, so one legacy CBE verification pinned that memory for the lifetime
 * of the deploy. Close it after an idle period instead: the fallback path is
 * rare, so paying the launch cost again is cheaper than holding the browser.
 */
const BROWSER_IDLE_TIMEOUT_MS = Number(process.env.CBE_BROWSER_IDLE_MS ?? 120_000);
let browserIdleTimer: NodeJS.Timeout | null = null;

function scheduleBrowserIdleClose(): void {
    if (browserIdleTimer) clearTimeout(browserIdleTimer);
    browserIdleTimer = setTimeout(() => {
        browserIdleTimer = null;
        if (activeBrowserOps > 0) return;
        void closeCBEBrowser().catch((error) =>
            logger.warn(`Failed to close the idle CBE browser: ${error instanceof Error ? error.message : error}`));
    }, BROWSER_IDLE_TIMEOUT_MS);
    browserIdleTimer.unref?.();
}

export async function closeCBEBrowser(): Promise<void> {
    if (browserIdleTimer) {
        clearTimeout(browserIdleTimer);
        browserIdleTimer = null;
    }
    if (browser && browser.isConnected()) {
        await browser.close();
        browser = null;
        logger.info('🔒 Puppeteer browser closed');
    }
}
