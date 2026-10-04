/**
 * fieldLimits.ts
 *
 * Length caps for free-text fields that reach MySQL.
 *
 * Prisma's `String` maps to `VARCHAR(191)` under this schema. An over-length
 * value is not a validation error at that layer — it is a `Data too long for
 * column` from the driver, which the route's catch-all turns into a 500. So an
 * uncapped field turns a client mistake into a server error, and on the
 * unauthenticated routes into a cheap way to fill the error log.
 *
 * The dashboard router had this cap for `PaymentLink.name` and a comment
 * claiming it covered "the common free-text fields". It covered exactly one, and
 * the API routers had none. The caps live here so every write path applies the
 * same number.
 */

/**
 * 191 matches the column width in schema.prisma. Going over the column is a 500;
 * going over a byte boundary in a multi-byte script (Amharic names are common in
 * this product) is the same error one character earlier, so the limit is on
 * UTF-8 *bytes* rather than characters.
 */
export const MYSQL_VARCHAR_BYTES = 191;

export class FieldTooLongError extends Error {
    constructor(readonly field: string, readonly maxBytes: number, readonly actualBytes: number) {
        super(`${field} must be at most ${maxBytes} bytes (received ${actualBytes}).`);
        this.name = 'FieldTooLongError';
    }
}

/**
 * Throw FieldTooLongError when `value` is longer than `maxBytes` UTF-8 bytes.
 *
 * Returns the value so it can wrap an assignment inline. Non-strings pass
 * through: type validation is a separate concern, and a number in a string field
 * is already a 400 elsewhere.
 */
export function assertMaxBytes(field: string, value: unknown, maxBytes: number = MYSQL_VARCHAR_BYTES): unknown {
    if (typeof value !== 'string') return value;
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > maxBytes) throw new FieldTooLongError(field, maxBytes, bytes);
    return value;
}

/** Non-throwing form, for call sites that would rather branch. */
export function isWithinByteLimit(value: unknown, maxBytes: number = MYSQL_VARCHAR_BYTES): boolean {
    if (typeof value !== 'string') return true;
    return Buffer.byteLength(value, 'utf8') <= maxBytes;
}

/**
 * Money bounds.
 *
 * `price` and `fixedAmount` are unconstrained Floats. The amount comparison on
 * the confirm path is a bare `<` with no epsilon, so a link priced at 1e-300 is
 * satisfied by any positive payment, and `1e400` parses to `Infinity` and is
 * accepted by a `> 0` check. One birr is the smallest real amount here and a
 * million is far above anything a single receipt link is for.
 */
export const MIN_PAYMENT_AMOUNT_ETB = 1;
export const MAX_PAYMENT_AMOUNT_ETB = 1_000_000;

export class InvalidAmountError extends Error {
    constructor(readonly min: number, readonly max: number) {
        super(`Amount must be a finite number between ${min} and ${max}.`);
        this.name = 'InvalidAmountError';
    }
}

export function assertPaymentAmount(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_PAYMENT_AMOUNT_ETB || value > MAX_PAYMENT_AMOUNT_ETB) {
        throw new InvalidAmountError(MIN_PAYMENT_AMOUNT_ETB, MAX_PAYMENT_AMOUNT_ETB);
    }
    return value;
}

export function isValidPaymentAmount(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isFinite(value)
        && value >= MIN_PAYMENT_AMOUNT_ETB
        && value <= MAX_PAYMENT_AMOUNT_ETB;
}

/**
 * Runtime membership check for a TypeScript enum union on a request body.
 *
 * A declared type is erased at runtime, so `status?: 'ACTIVE' | 'INACTIVE'`
 * happily accepts `{status: 'EXPIRED'}` at runtime — and EXPIRED is a real
 * PaymentLinkStatus, so it reaches Prisma while bypassing a guard written as
 * `status === 'INACTIVE'`. Anything else 500s instead of 400ing.
 */
export function isEnumValue<T extends string>(allowed: readonly T[], value: unknown): value is T {
    return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}
