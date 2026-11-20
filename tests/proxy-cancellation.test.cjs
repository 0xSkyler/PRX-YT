'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTree } = require('./helpers.cjs');
const root = path.resolve(__dirname, '../src');
function fixture() {
    const { ProxyManager } = loadTree(root, {}, {
        fetch: async () => ({ ok: true, text: async () => 'http://192.0.2.1:8080\nhttp://192.0.2.2:8080' })
    })('main/ProxyManager.js');
    return new ProxyManager();
}
test('Stop from progress prevents all later proxy assignments', async () => {
    const manager = fixture(), assigned = [];
    await assert.rejects(manager.fetchAssignDirect([1, 2], a => assigned.push(a), () => manager.cancelCurrentFetch()), /cancelled/);
    assert.equal(assigned.length, 0);
    assert.equal(manager.getAssignment(1), null);
});
test('Stop from assignment prevents remaining callbacks and successful summary', async () => {
    const manager = fixture(), assigned = [];
    let summaries = 0;
    manager.on('assignmentsChanged', () => summaries++);
    await assert.rejects(manager.fetchAssignDirect([1, 2], a => {
        assigned.push(a); manager.cancelCurrentFetch();
    }), /cancelled/);
    assert.deepEqual(assigned.map(a => a.browserId), [1]);
    assert.equal(manager.getAssignment(2), null);
    assert.equal(summaries, 0);
});
test('a replacement fetch owns assignment state after a reentrant cancellation', async () => {
    const manager = fixture(), assigned = [];
    let replacement;
    await assert.rejects(manager.fetchAssignDirect([1, 2], a => {
        assigned.push(a.browserId);
        replacement = manager.fetchAssignDirect([3], b => assigned.push(b.browserId));
    }), /cancelled/);
    await replacement;
    assert.deepEqual(assigned, [1, 3]);
    assert.equal(manager.getAssignment(1), null);
    assert.equal(manager.getAssignment(2), null);
    assert.ok(manager.getAssignment(3));
});
