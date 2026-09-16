import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTelebirrProxyUrl } from '../services/verifyTelebirr';

test('buildTelebirrProxyUrl supports a configured reference placeholder', () => {
    const result = new URL(buildTelebirrProxyUrl(
        'https://proxy.example/verify.php?reference=',
        'ABC 123',
        'proxy secret'
    ));

    assert.equal(result.searchParams.get('reference'), 'ABC 123');
    assert.equal(result.searchParams.get('key'), 'proxy secret');
});

test('buildTelebirrProxyUrl also supports a bare proxy endpoint', () => {
    const result = new URL(buildTelebirrProxyUrl(
        'https://proxy.example/verify.php',
        'ABC123',
        'secret'
    ));

    assert.equal(result.pathname, '/verify.php');
    assert.equal(result.searchParams.get('reference'), 'ABC123');
    assert.equal(result.searchParams.get('key'), 'secret');
});

test('buildTelebirrProxyUrl rejects malformed relay configuration', () => {
    assert.throws(
        () => buildTelebirrProxyUrl('not-a-url', 'ABC123', 'secret'),
        /invalid relay URL/i
    );
});
