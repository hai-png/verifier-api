/**
 * quotaCharge.ts
 *
 * Monthly verification credits are deducted in `verifyQuotaGate` — before the
 * provider is called. Single-receipt inputs are now validated first in the
 * shared pipeline. Previously a malformed request (400),
 * a permission rejection (403) or an internal error (500) still consumed the
 * customer's credit even though nothing was ever asked of the provider.
 *
 * This module records the charge on the request and refunds it when the
 * response is one of those "no provider work happened" statuses.
 */

import { Request, RequestHandler, Response } from 'express';
import logger from './logger';

/**
 * Provider-facing outcomes (404 receipt not found, 422 invalid reference,
 * 502 provider unreachable) are deliberately NOT refunded: the provider lookup
 * was attempted and is billable upstream.
 */
const REFUNDABLE_STATUSES = new Set<number>([400, 403, 405, 413, 415, 429, 500, 503]);

export interface QuotaCharge {
    workspaceId: string;
    units: number;
}

const state = { refunds: 0, failures: 0, refundedUnits: 0 };

export function isRefundableStatus(statusCode: number): boolean {
    return REFUNDABLE_STATUSES.has(statusCode);
}

export function markQuotaCharged(req: Request, charge: QuotaCharge): void {
    (req as any).quotaCharge = charge;
}

export function getQuotaCharge(req: Request): QuotaCharge | undefined {
    return (req as any).quotaCharge as QuotaCharge | undefined;
}

export function quotaRefundState(): { refunds: number; failures: number; refundedUnits: number } {
    return { ...state };
}

/**
 * Credit writes as ONE autocommit statement.
 *
 * Prisma runs `workspace.updateMany` as BEGIN / UPDATE / COMMIT — three round
 * trips (lab timeline: 183 ms at a 60 ms RTT) — and holds the workspace row
 * lock across two of them. Every verification for a workspace serializes on
 * that row, so the lock hold time directly caps per-workspace throughput and
 * inflated quota p95 under load. A single conditional UPDATE is equally atomic
 * (`verificationCredits >= units` is checked under the row lock) and holds the
 * lock only for the statement itself.
 *
 * Falls back to Prisma's updateMany if the raw statement ever fails.
 */
let rawCreditWritesDisabled = process.env.QUOTA_SINGLE_STATEMENT === 'false';

type CreditDb = {
    $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
    workspace: { updateMany: (args: any) => Promise<{ count: number }> };
};

async function creditDb(db?: CreditDb): Promise<CreditDb> {
    if (db) return db;
    // Imported lazily so the policy helpers in this module stay unit
    // testable without a generated Prisma client.
    const { prisma } = await import('./prisma');
    return prisma as unknown as CreditDb;
}

function disableRaw(error: unknown): void {
    rawCreditWritesDisabled = true;
    logger.error('Single-statement credit write failed; falling back to Prisma updateMany for this process.', {
        error: (error as Error)?.message,
    });
}

/** Deduct `units` if the balance covers them. Returns true when charged. */
export async function chargeVerificationCredits(workspaceId: string, units: number, db?: CreditDb): Promise<boolean> {
    const client = await creditDb(db);
    if (!rawCreditWritesDisabled) {
        try {
            const affected = await client.$executeRaw`UPDATE \`Workspace\` SET \`verificationCredits\` = \`verificationCredits\` - ${units} WHERE \`id\` = ${workspaceId} AND \`verificationCredits\` >= ${units}`;
            return Number(affected) > 0;
        } catch (error) {
            disableRaw(error);
        }
    }
    const updated = await client.workspace.updateMany({
        where: { id: workspaceId, verificationCredits: { gte: units } },
        data: { verificationCredits: { decrement: units } },
    });
    return updated.count > 0;
}

export async function refundVerificationCredits(workspaceId: string, units: number, db?: CreditDb): Promise<void> {
    const client = await creditDb(db);
    if (!rawCreditWritesDisabled) {
        try {
            await client.$executeRaw`UPDATE \`Workspace\` SET \`verificationCredits\` = \`verificationCredits\` + ${units} WHERE \`id\` = ${workspaceId}`;
            return;
        } catch (error) {
            disableRaw(error);
        }
    }
    await client.workspace.updateMany({
        where: { id: workspaceId },
        data: { verificationCredits: { increment: units } },
    });
}

async function refund(charge: QuotaCharge): Promise<void> {
    try {
        await refundVerificationCredits(charge.workspaceId, charge.units);
        state.refunds += 1;
        state.refundedUnits += charge.units;
        logger.info(`Refunded ${charge.units} verification credit(s) to workspace ${charge.workspaceId}`);
    } catch (error) {
        state.failures += 1;
        logger.error(`Failed to refund ${charge.units} credit(s) to workspace ${charge.workspaceId}:`, error);
    }
}

/**
 * Refund the quota deducted for this request when the response shows the
 * verification never reached the provider. Fire-and-forget: the customer's
 * response is never delayed by bookkeeping.
 */
export const quotaRefundHook: RequestHandler = (req: Request, res: Response, next) => {
    res.on('finish', () => {
        const charge = getQuotaCharge(req);
        if (!charge || charge.units <= 0) return;
        if (!isRefundableStatus(res.statusCode)) return;
        delete (req as any).quotaCharge;
        void refund(charge);
    });
    next();
};
