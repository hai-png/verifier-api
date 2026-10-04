// /verify-image is the weak path by construction: twenty-one Ethiopian providers
// have no public API, so a screenshot of the receipt *is* the verification, and a
// model reads the pixels. That makes the controls around it the only controls.
//
// Three of them were broken while reading as present:
//
//  1. A `payoutAccountId` sent as a JSON number (or a blank string) collapsed to
//     the same `null` as "not supplied", which made enforceRecipient return true.
//     The recipient check AND the provider-allow-list check were both skipped and
//     the response was still `verified: true` — a caller who believed the control
//     was on had it off. A supplied-but-invalid id must be a 400.
//
//  2. The amount check read the OCR payload through extractPaymentDetails(), which
//     is keyed on provider *API* field names. Two of twenty-one OCR providers
//     happened to line up; the other nineteen returned AMOUNT_NOT_VERIFIABLE on a
//     receipt whose amount was right there in `details.amount`.
//
//  3. Replay was never recorded. noteSuccessfulVerification had one non-test
//     caller — the reference pipeline — so the same receipt produced an identical
//     `verified: true` forever, with nothing to tell a first sighting from the
//     hundredth.
//
// Driven through the real handler with multer and Prisma recorded, because the
// defect in each case is what the handler *does*, not what the source says.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import multer from 'multer';
import { AddressInfo } from 'node:net';
import { prisma } from '../utils/prisma';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A provider slug the model returned, plus the fields a Dashen receipt carries. */
const DASHEN_OCR = {
  type: 'dashen',
  transaction_id: '3123456789012345',
  payer_name: 'Abebe Kebede',
  payer_account: '0911223344',
  receiver_name: 'Course Shop PLC',
  receiver_account: '0911000000',
  amount: 500,
};

async function post(url: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(PNG_1PX)], { type: 'image/png' }), 'receipt.png');
  for (const [key, value] of Object.entries(body)) form.append(key, String(value));
  const response = await fetch(url, { method: 'POST', body: form });
  const text = await response.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
  return { status: response.status, body: parsed };
}

async function mount(t: any, options: any) {
  const originals: Array<() => void> = [];
  const replace = (object: any, key: string, value: any) => {
    const original = object[key];
    object[key] = value;
    originals.push(() => { object[key] = original; });
  };
  const calls = { payoutAccountLookups: [] as any[] };

  replace(prisma.payoutAccount, 'findFirst', async (args: any) => {
    calls.payoutAccountLookups.push(args);
    return options.payoutAccount ?? null;
  });
  replace(prisma.workspace, 'updateMany', async () => ({ count: 1 }));
  replace(prisma.verifiedTransaction, 'findUnique', async () => options.seenBefore ?? null);
  replace(prisma.verifiedTransaction, 'create', async () => ({}));
  replace(prisma.verifiedTransaction, 'update', async () => ({}));

  const mistral = require('@mistralai/mistralai');
  // `Mistral.prototype.chat` is a getter that builds a Chat object; the handler
  // calls `.complete()` on it. Redefining the getter is the seam.
  const chatDescriptor = Object.getOwnPropertyDescriptor(mistral.Mistral.prototype, 'chat');
  Object.defineProperty(mistral.Mistral.prototype, 'chat', {
    configurable: true,
    get() { return { complete: async () => ({ choices: [{ message: { content: JSON.stringify(options.ocr) } }] }) }; },
  });
  originals.push(() => {
    Object.defineProperty(mistral.Mistral.prototype, 'chat', chatDescriptor!);
  });

  const { verifyImageHandler } = require('../services/verifyImage');
  const app = express();
  // The handler brings its own multer. Adding another one here would consume the
  // request stream first and leave the handler's parser with a truncated body.
  app.post('/verify-image',
    (req: any, _res: any, next: any) => {
      if (options.workspaceId) {
        req.apiKeyData = { id: 'key-1' };
        req.resolvedAccount = { creditHolder: 'workspace', creditHolderId: options.workspaceId };
      }
      next();
    },
    verifyImageHandler);

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/verify-image`;
  t.after(async () => {
    originals.reverse().forEach((restore) => restore());
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => setImmediate(r));
  });
  return { url, calls };
}

const PAYOUT_ACCOUNT = {
  id: 'pa-1',
  label: 'Main',
  account: '0911000000',
  accountHolderName: 'Course Shop PLC',
  providersAllowed: ['dashen'],
};

test('a blank payoutAccountId is a 400, not a silently disabled recipient check', async (t) => {
  // The reachable form of this defect. multipart/form-data coerces every field to
  // a string, so a JSON number cannot reach the handler here — but an empty or
  // whitespace-only field can, and it used to take the same path as "not
  // supplied": resolvePayoutAccount returned null, enforceRecipient returned true,
  // payoutAccountAllowsProvider was never consulted, and the response was still
  // `verified: true`. A caller whose form posted an empty id believed the
  // recipient check was on. It was off.
  const { url, calls } = await mount(t, { workspaceId: 'ws-1', ocr: DASHEN_OCR, payoutAccount: PAYOUT_ACCOUNT });

  for (const value of ['', '   ']) {
    const response = await post(url, { payoutAccountId: value });
    assert.equal(response.status, 400, `payoutAccountId=${JSON.stringify(value)}`);
    assert.equal(response.body.verified, false);
    assert.match(response.body.error, /payoutAccountId must be a non-empty string/);
  }
  assert.equal(calls.payoutAccountLookups.length, 0);
});

test('an omitted payoutAccountId still means "no check", and says so in the response', async (t) => {
  const { url } = await mount(t, { workspaceId: 'ws-1', ocr: DASHEN_OCR });
  const response = await post(url, {});
  assert.equal(response.status, 200);
  assert.equal(response.body.verified, true);
  assert.equal(response.body.recipientChecked, false);
  assert.match(response.body.note, /Neither the recipient nor the amount was checked/);
});

test('a payout account that cannot receive this provider is refused before comparing', async (t) => {
  // The allow-list was enforced on the OCR branch but not on the API-backed
  // Telebirr and CBE branches, so an account restricted to ['dashen'] would still
  // accept a CBE receipt and be compared against it.
  const { url } = await mount(t, {
    workspaceId: 'ws-1',
    payoutAccount: { ...PAYOUT_ACCOUNT, providersAllowed: ['telebirr'] },
    ocr: { ...DASHEN_OCR, type: 'dashen' },
  });
  const response = await post(url, { payoutAccountId: 'pa-1' });
  assert.equal(response.status, 422);
  assert.equal(response.body.reason, 'PROVIDER_NOT_ALLOWED');
});

test('a receipt paid to someone else is refused even though the amount matches', async (t) => {
  const { url } = await mount(t, {
    workspaceId: 'ws-1',
    payoutAccount: PAYOUT_ACCOUNT,
    ocr: { ...DASHEN_OCR, receiver_account: '0909999999', receiver_name: 'Someone Else PLC' },
  });
  const response = await post(url, { payoutAccountId: 'pa-1', expectedAmount: '500' });
  assert.equal(response.status, 422);
  assert.equal(response.body.verified, false);
  assert.equal(response.body.reason, 'RECIPIENT_MISMATCH');
});

test('the amount check runs on the OCR payload, which is where the amount actually is', async (t) => {
  // Dashen reports no amount to extractPaymentDetails (it returns receiverName
  // only), so routing the OCR payload through it produced
  // AMOUNT_NOT_VERIFIABLE on a receipt whose `details.amount` was 500.
  const { url } = await mount(t, { workspaceId: 'ws-1', ocr: DASHEN_OCR });
  const response = await post(url, { expectedAmount: '500' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.verified, true);
  assert.equal(response.body.amountChecked, true);
  assert.equal(response.body.details.amount, 500);
});

// Every provider in `ocrVerifiedTypes`, not just the handful whose field names
// happen to match extractPaymentDetails. `checkAmount` derives the amount through
// a provider-keyed extractor that knows 8 of these 21, so 13 of them returned
// AMOUNT_NOT_VERIFIABLE on a correct receipt. One representative per provider,
// because the point is the *count*, not any individual provider.
const OCR_VERIFIED_TYPES = [
  'cbe-birr', 'dashen', 'abyssinia', 'awash', 'zemen', 'mpesa',
  'coop-oromia', 'oromia-bank', 'hijra', 'amhara', 'wegagen',
  'berhan', 'abay', 'lion', 'bunna', 'enat', 'gadaa', 'tsehay',
  'orbit', 'shabelle', 'sinqee',
];

for (const type of OCR_VERIFIED_TYPES) {
  test(`the amount check is live for ${type}`, async (t) => {
    const { url } = await mount(t, {
      workspaceId: 'ws-1',
      ocr: { ...DASHEN_OCR, type },
    });
    const good = await post(url, { expectedAmount: '500' });
    assert.equal(good.status, 200, `${type}: ${JSON.stringify(good.body)}`);
    assert.equal(good.body.amountChecked, true, `${type} did not check the amount`);

    const bad = await post(url, { expectedAmount: '999' });
    assert.equal(bad.status, 422, `${type} must refuse a wrong amount`);
    assert.equal(bad.body.reason, 'AMOUNT_MISMATCH', `${type} gave ${bad.body.reason}`);
    assert.equal(bad.body.foundAmount, 500);
  });
}

test('a wrong amount is refused with the figure the receipt showed', async (t) => {
  const { url } = await mount(t, { workspaceId: 'ws-1', ocr: DASHEN_OCR });
  const response = await post(url, { expectedAmount: '5000' });
  assert.equal(response.status, 422);
  assert.equal(response.body.reason, 'AMOUNT_MISMATCH');
  assert.equal(response.body.foundAmount, 500);
});

test('an amount the model returned as a string is still compared', async (t) => {
  const { url } = await mount(t, { workspaceId: 'ws-1', ocr: { ...DASHEN_OCR, amount: '500.00' } });
  const response = await post(url, { expectedAmount: '500' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.verified, true);
});

test('a replayed receipt is flagged, with when it was first seen', async (t) => {
  const { url } = await mount(t, {
    workspaceId: 'ws-1',
    ocr: DASHEN_OCR,
    seenBefore: { firstSeenAt: new Date('2026-01-02T03:04:05Z'), seenCount: 1 },
  });
  const response = await post(url, {});
  assert.equal(response.status, 200);
  assert.equal(response.body.replayed, true);
  assert.equal(response.body.firstVerifiedAt, new Date('2026-01-02T03:04:05Z').toISOString());
  assert.equal(response.body.timesSeen, 2);
});

test('a first sighting is not flagged as a replay', async (t) => {
  const { url } = await mount(t, { workspaceId: 'ws-1', ocr: DASHEN_OCR });
  const response = await post(url, {});
  assert.equal(response.status, 200);
  assert.equal(response.body.replayed, undefined);
});

test('a provider type the allow-list does not contain is refused, not routed', async (t) => {
  // A crafted receipt steering the model to an arbitrary type must not reach the
  // 21-provider `ocrVerifiedTypes.includes(...)` branch and come back verified.
  const { url } = await mount(t, {
    workspaceId: 'ws-1',
    ocr: { ...DASHEN_OCR, type: 'not-a-bank' },
  });
  const response = await post(url, {});
  assert.equal(response.status, 422);
  assert.equal(response.body.verified, false);
  assert.match(response.body.error, /Unknown or unrecognized receipt type/);
  // Coerced to `unknown`, not passed through to the routing below.
  assert.equal(response.body.ocr_result.type, 'unknown');
});

test('an unrecognised provider type is refused even with no workspace context', async (t) => {
  // No apiKeyData means no payout account, so the recipient check is legitimately
  // skipped — the type allow-list is what has to hold here.
  const { url } = await mount(t, { ocr: { ...DASHEN_OCR, type: 'evil-bank' } });
  const response = await post(url, {});
  assert.equal(response.status, 422);
  assert.equal(response.body.verified, false);
});

test('an oversized string field from the model is dropped rather than stored', async (t) => {
  // A model that echoes the image back as one field must not be able to push
  // megabytes into a response body, a log line or a database column.
  const { url } = await mount(t, {
    workspaceId: 'ws-1',
    ocr: { ...DASHEN_OCR, receiver_name: 'A'.repeat(50_000), receiver_account: '0911000000' },
  });
  const response = await post(url, {});
  assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 200));
  assert.equal(response.body.details.receiverName, undefined);
});
