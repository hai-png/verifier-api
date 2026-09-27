/**
 * secretVault.ts
 *
 * Encryption at rest for the webhook signing secrets.
 *
 * `Webhook.signingSecret` is stored raw — in a column still named `secretHash`
 * from a design that used to hash it. It cannot be hashed and still work: the
 * service has to reproduce the secret to compute `X-Veritas-Signature` on every
 * delivery. But storing it in plaintext means a database read — a dump, a backup,
 * a replica, a compromised admin console — yields the signing key for every
 * merchant's webhook, which is enough to POST a forged `payment_link.paid` event
 * that the merchant's own endpoint will accept as authentic. That is the same
 * exposure `hashSessionToken` closes for sessions, and it was the last credential
 * in the schema stored in the clear.
 *
 * So: AES-256-GCM under a key held outside the database.
 *
 *   WEBHOOK_SECRET_KEY=<64+ chars of random>
 *
 * Without it the service keeps working exactly as before and says so loudly at
 * startup and on /status/summary — the same shape as tlsPolicy, so enabling
 * protection is a deployment decision rather than a code change, and the state of
 * that decision is visible from outside the source tree.
 *
 * Values are versioned (`v2.`) so a future re-key or algorithm change can be
 * rolled out without a flag day, and so legacy plaintext rows are distinguishable
 * from encrypted ones and can be migrated in place.
 */

import crypto from 'node:crypto';
import { prisma } from './prisma';
import logger from './logger';

const KEY_ENV = 'WEBHOOK_SECRET_KEY';
const PREFIX = 'v2.';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * The encryption key, derived rather than used verbatim so any length of
 * configured secret works and a low-entropy value is not used directly as an
 * AES key.
 */
function keyMaterial(env: NodeJS.ProcessEnv = process.env): Buffer | null {
    const configured = env[KEY_ENV];
    if (!configured || configured.trim().length < 16) return null;
    return crypto.createHash('sha256').update(configured).digest();
}

export function secretVaultEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return keyMaterial(env) !== null;
}

export function secretVaultState(env: NodeJS.ProcessEnv = process.env): {
    encryptionEnabled: boolean;
    keyEnvVar: string;
} {
    return { encryptionEnabled: secretVaultEnabled(env), keyEnvVar: KEY_ENV };
}

export function isEncryptedSecret(stored: string | null | undefined): boolean {
    return typeof stored === 'string' && stored.startsWith(PREFIX);
}

/**
 * Encrypt a secret for storage. Returns the input unchanged when no key is
 * configured, so a deployment without WEBHOOK_SECRET_KEY behaves exactly as it
 * does today instead of silently storing values it could never read back.
 */
export function encryptSecret(plain: string, env: NodeJS.ProcessEnv = process.env): string {
    const key = keyMaterial(env);
    if (!key) return plain;

    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`;
}

/**
 * Recover a secret for signing.
 *
 * Accepts both the encrypted form and legacy plaintext, so turning encryption on
 * does not break the webhooks already in the table — they are migrated by
 * `migrateLegacyWebhookSecrets()` instead.
 *
 * A GCM tag failure is treated as "no secret": signing with a corrupted key would
 * produce signatures the merchant cannot verify, which is indistinguishable from
 * an attack. Failing closed means the delivery goes out unsigned and the merchant
 * rejects it, which is loud and correct.
 */
export function decryptSecret(stored: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
    if (!stored) return null;
    if (!isEncryptedSecret(stored)) return stored;

    const key = keyMaterial(env);
    if (!key) {
        logger.error('A webhook secret is encrypted but WEBHOOK_SECRET_KEY is not configured; delivering unsigned.');
        return null;
    }
    try {
        const blob = Buffer.from(stored.slice(PREFIX.length), 'base64');
        if (blob.length <= IV_BYTES + TAG_BYTES) throw new Error('ciphertext too short');
        const iv = blob.subarray(0, IV_BYTES);
        const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
        const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (error) {
        logger.error(
            'Failed to decrypt a webhook signing secret (wrong WEBHOOK_SECRET_KEY, or the row was tampered with); delivering unsigned.',
            error instanceof Error ? { message: error.message } : error,
        );
        return null;
    }
}

/**
 * Re-encrypt webhook secrets that are still stored as plaintext.
 *
 * Idempotent and bounded: it only touches rows that lack the version prefix, so
 * re-running it is a single SELECT. Called once at startup, after the vault key is
 * known, so flipping WEBHOOK_SECRET_KEY on migrates the table without a script.
 */
export async function migrateLegacyWebhookSecrets(): Promise<number> {
    if (!secretVaultEnabled()) return 0;
    try {
        const rows = await prisma.webhook.findMany({
            where: { signingSecret: { not: null } },
            select: { id: true, signingSecret: true },
            take: 1_000,
        });
        const legacy = rows.filter((row) => row.signingSecret && !isEncryptedSecret(row.signingSecret));
        for (const row of legacy) {
            await prisma.webhook.update({
                where: { id: row.id },
                data: { signingSecret: encryptSecret(row.signingSecret as string) },
            });
        }
        if (legacy.length > 0) {
            logger.info(`Encrypted ${legacy.length} webhook signing secret(s) that were stored in plaintext.`);
        }
        return legacy.length;
    } catch (error) {
        // Not fatal: plaintext secrets still sign correctly, this is hardening.
        logger.error('Could not migrate legacy webhook signing secrets:', error);
        return 0;
    }
}

/** Log the exposure once, loudly, at startup. */
export function logSecretVaultState(env: NodeJS.ProcessEnv = process.env): void {
    if (secretVaultEnabled(env)) {
        logger.info('Webhook signing secrets are encrypted at rest (WEBHOOK_SECRET_KEY is set).');
        return;
    }
    logger.warn(
        `⚠️ Webhook signing secrets are stored in PLAINTEXT: ${KEY_ENV} is not set. A database read yields the ` +
        'signing key for every merchant webhook, which is enough to forge delivery signatures they would accept.',
    );
}
