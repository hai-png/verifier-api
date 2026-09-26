import test from 'node:test';
import assert from 'node:assert/strict';

import {
    classifyStatement,
    dbMetricsSnapshot,
    recordDbStatement,
    recordHttpRequest,
    resetDbMetrics,
} from '../utils/dbMetrics';

test('classifyStatement finds the verb and the table', () => {
    assert.deepEqual(
        classifyStatement('SELECT `t0`.`id` FROM `api_keys` AS `t0` WHERE `t0`.`keyHash` = ? LIMIT ?'),
        { verb: 'SELECT', table: 'api_keys' },
    );
    assert.deepEqual(
        classifyStatement('UPDATE `workspaces` SET `verificationCredits` = ? WHERE `id` = ?'),
        { verb: 'UPDATE', table: 'workspaces' },
    );
    assert.deepEqual(
        classifyStatement('INSERT INTO `usage_logs` (`id`, `createdAt`) VALUES (?, ?)'),
        { verb: 'INSERT', table: 'usage_logs' },
    );
    assert.deepEqual(classifyStatement('BEGIN'), { verb: 'BEGIN', table: null });
    assert.deepEqual(classifyStatement('   commit  '), { verb: 'COMMIT', table: null });
});

test('statements per request is derived from both counters', () => {
    resetDbMetrics();
    // Three requests, six statements, two of them slow.
    recordDbStatement('SELECT * FROM `api_keys` WHERE `keyHash` = ?', 150);
    recordDbStatement('UPDATE `workspaces` SET `verificationCredits` = ?', 12);
    recordHttpRequest();
    recordDbStatement('SELECT * FROM `api_keys` WHERE `keyHash` = ?', 160);
    recordDbStatement('UPDATE `workspaces` SET `verificationCredits` = ?', 11);
    recordHttpRequest();
    recordDbStatement('BEGIN', 1);
    recordDbStatement('COMMIT', 1);
    recordHttpRequest();

    const snapshot = dbMetricsSnapshot();
    assert.equal(snapshot.totals.requests, 3);
    assert.equal(snapshot.totals.statements, 6);
    assert.equal(snapshot.totals.statementsPerRequest, 2);
    assert.equal(snapshot.totals.maxStatementMs, 160);
    assert.equal(snapshot.topTables[0].table, 'api_keys');
    assert.equal(snapshot.topTables[0].statements, 2);
    assert.deepEqual(snapshot.byVerb.SELECT, 2);
    assert.equal(snapshot.slowestStatements.length, 3);
    assert.equal(snapshot.slowestStatements[0].ms, 160);
});

test('the rolling window only counts the last minute', () => {
    resetDbMetrics();
    recordDbStatement('SELECT 1', 1);
    recordHttpRequest();

    const snapshot = dbMetricsSnapshot();
    assert.equal(snapshot.window.statements, 1);
    assert.equal(snapshot.window.requests, 1);
    assert.equal(snapshot.window.statementsPerRequest, 1);
    assert.equal(snapshot.windowSeconds, 60);
});

test('empty counters report nulls instead of dividing by zero', () => {
    resetDbMetrics();
    const snapshot = dbMetricsSnapshot();
    assert.equal(snapshot.totals.statementsPerRequest, null);
    assert.equal(snapshot.totals.meanStatementMs, null);
    assert.equal(snapshot.window.statementsPerRequest, null);
    assert.deepEqual(snapshot.topTables, []);
});

test('the slowest-statement list stays bounded', () => {
    resetDbMetrics();
    for (let i = 0; i < 20; i += 1) {
        recordDbStatement(`SELECT * FROM \`table_${i}\` WHERE id = ?`, i);
    }
    const snapshot = dbMetricsSnapshot();
    assert.equal(snapshot.slowestStatements.length, 3);
    assert.equal(snapshot.slowestStatements[0].ms, 19);
});
