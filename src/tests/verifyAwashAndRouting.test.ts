import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAwashReceipt } from '../services/verifyAwash';
import { extractNewCbeToken, isNewCbeReference } from '../utils/cbeReference';

const NEW_STYLE_AWASH_HTML = `<!doctype html><html><body>
    <table class="info-table">
        <tr><td>Company Name</td><td>:</td><td>Awash Bank Share company</td></tr>
        <tr><td>Customer Name</td><td>:</td><td>ESKINDER ZINABE  TAKLE</td></tr>
    </table>
    <table class="info-table">
        <tr>
            <td><tt><span>Transaction Date </span></tt></td>
            <td><tt><span>: </span></tt></td>
            <td><tt><span>2026-09-14</span></tt></td>
        </tr>
        <tr>
            <td><tt><span>Transaction Type </span></tt></td>
            <td><tt><span>: </span></tt></td>
            <td><tt><span>Telebirr Transfer</span></tt></td>
        </tr>
        <tr>
            <td><tt><span>Phone Number </span></tt></td>
            <td><tt><span>: </span></tt></td>
            <td><tt><span>251906422230</span></tt></td>
        </tr>
        <tr>
            <td><tt><span>Customer Name </span></tt></td>
            <td><tt><span>: </span></tt></td>
            <td><tt><span>eskndre zinabe takle </span></tt></td>
        </tr>
        <tr>
            <td><tt><span>Source Account </span></tt></td>
            <td><tt><span>: </span></tt></td>
            <td><tt><span>01320******6600/BANK</span></tt></td>
        </tr>
        <tr>
            <td><tt><span>Amount </span></tt></td>
            <td><tt><span>: </span></tt></td>
            <td><tt><span>11,000.00</span></tt></td>
        </tr>
        <tr>
            <td><tt><span>Charge </span></tt></td>
            <td><tt><span>: </span></tt></td>
            <td><tt><span>15.00</span></tt></td>
        </tr>
        <tr>
            <td><tt><span>VAT </span></tt></td>
            <td><tt><span>: </span></tt></td>
            <td><tt><span>2.25</span></tt></td>
        </tr>
        <tr>
            <td><tt><span>Reason </span></tt></td>
            <td><tt><span>: </span></tt></td>
            <td><tt><span>xjvi</span></tt></td>
        </tr>
        <tr>
            <td><tt><span>Transaction ID </span></tt></td>
            <td><tt><span>: </span></tt></td>
            <td><tt><span>260914133075649</span></tt></td>
        </tr>
    </table>
</body></html>`;

const LEGACY_STYLE_AWASH_HTML = `<html><body>
    <table class="info-table">
        <tr><td>Sender Name</td><td>:</td><td>Abebe Kebede</td></tr>
        <tr><td>Sender Account</td><td>:</td><td>0123456789</td></tr>
        <tr><td>Beneficiary name</td><td>:</td><td>FitLife Hub</td></tr>
        <tr><td>Transaction Type</td><td>:</td><td>Transfer</td></tr>
        <tr><td>Transaction ID</td><td>:</td><td>TX0001</td></tr>
        <tr><td>Transaction Time</td><td>:</td><td>01/02/2026 10:00:00 AM</td></tr>
        <tr><td>Amount</td><td>:</td><td>500.00</td></tr>
        <tr><td>Charge</td><td>:</td><td>2.50</td></tr>
        <tr><td>VAT</td><td>:</td><td>0.50</td></tr>
        <tr><td>Reason</td><td>:</td><td>order</td></tr>
    </table>
</body></html>`;

test('parseAwashReceipt parses the new Telebirr-style (tt/span-wrapped) receipt', () => {
    const result = parseAwashReceipt(NEW_STYLE_AWASH_HTML, '2KHIAQ8A0X-5VER3P');

    assert.equal(result.success, true);
    assert.equal(result.senderName, 'eskndre zinabe takle');
    assert.equal(result.senderAccount, '01320******6600/BANK');
    assert.equal(result.amount, 11000);
    assert.equal(result.charge, 15);
    assert.equal(result.vat, 2.25);
    assert.equal(result.transactionType, 'Telebirr Transfer');
    assert.equal(result.transactionDate, '2026-09-14');
    assert.equal(result.reason, 'xjvi');
    assert.equal(result.transactionId, '260914133075649');
});

test('parseAwashReceipt still parses the legacy flat-cell receipt', () => {
    const result = parseAwashReceipt(LEGACY_STYLE_AWASH_HTML, 'LEGACY');

    assert.equal(result.success, true);
    assert.equal(result.senderName, 'Abebe Kebede');
    assert.equal(result.senderAccount, '0123456789');
    assert.equal(result.beneficiaryName, 'FitLife Hub');
    assert.equal(result.amount, 500);
    assert.equal(result.transactionDate, '01/02/2026 10:00:00 AM');
});

test('parseAwashReceipt rejects a page that is not a receipt', () => {
    const result = parseAwashReceipt('<html><body><div>Not found</div></body></html>', 'NOPE');
    assert.equal(result.success, false);
});

test('Awash references with a dash are no longer mistaken for new-CBE tokens', () => {
    assert.equal(extractNewCbeToken('2KHIAQ8A0X-5VER3P'), null);
    assert.equal(isNewCbeReference('2KHIAQ8A0X-5VER3P'), false);
});

test('genuine new-CBE tokens (alphanumeric, 15-40 chars) still detect', () => {
    assert.equal(extractNewCbeToken('fHCxyUdnBt2PA0H8ge'), 'fHCxyUdnBt2PA0H8ge');
    assert.equal(isNewCbeReference('fHCxyUdnBt2PA0H8ge'), true);
    assert.equal(isNewCbeReference('https://mbreciept.cbe.com.et/fHCxyUdnBt2PA0H8ge'), true);
});

test('FT-prefixed legacy references never detect as new-CBE tokens', () => {
    assert.equal(isNewCbeReference('FT12345678'), false);
});