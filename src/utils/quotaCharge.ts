/**
 * quotaCharge.ts
 *
 * Monthly verification credits are deducted in `verifyQuotaGate` — before the
 * request is validated, because that is the only point where the workspace row
 * can be decremented atomically. That ordering meant a malformed request (400),
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

async function refund(charge: QuotaCharge): Promise<void> {
    try {
        // Imported lazily so the policy helpers in this module stay unit
        // testable without a generated Prisma client.
        const { prisma } = await import('./prisma');
        await prisma.workspace.update({
            where: { id: charge.workspaceId },
            data: { verificationCredits: { increment: charge.units } },
        });
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
