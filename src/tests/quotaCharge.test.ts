import test from 'node:test';
import assert from 'node:assert/strict';
import { isRefundableStatus, markQuotaCharged, getQuotaCharge } from '../utils/quotaCharge';

test('refunds credits when no provider lookup happened', () => {
    // Malformed request, missing permission, protocol errors, our own failures.
    for (const status of [400, 403, 405, 413, 415, 429, 500, 503]) {
        assert.equal(isRefundableStatus(status), true, `status ${status} should refund`);
    }
});

test('does not refund provider-facing outcomes', () => {
    // These mean the bank/telecom was actually queried (and may bill us).
    for (const status of [200, 201, 402, 404, 422, 502]) {
        assert.equal(isRefundableStatus(status), false, `status ${status} must not refund`);
    }
});

test('charges are tracked per request', () => {
    const req = {} as any;
    assert.equal(getQuotaCharge(req), undefined);

    markQuotaCharged(req, { workspaceId: 'ws_1', units: 3 });
    assert.deepEqual(getQuotaCharge(req), { workspaceId: 'ws_1', units: 3 });
});
