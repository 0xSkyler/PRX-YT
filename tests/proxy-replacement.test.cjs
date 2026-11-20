'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTree } = require('./helpers.cjs');
async function fixture(count = 4) {
    const feed = Array.from({ length: count }, (_, n) => `http://192.0.2.${n + 1}:8080`).join('\n');
    const { ProxyManager } = loadTree(path.resolve(__dirname, '../src'), {}, {
        fetch: async () => ({ ok: true, text: async () => feed })
    })('main/ProxyManager.js');
    const manager = new ProxyManager();
    await manager.fetchAssignDirect([1, 2], () => {});
    return manager;
}
test('failed endpoint is removed immediately and an unused endpoint is exclusively reserved', async () => {
    const manager = await fixture();
    const first = manager.getAssignment(1), second = manager.getAssignment(2);
    const replacement = manager.replaceFailedAssignment(1, first);
    assert.equal(replacement.browserId, 1);
    assert.equal(replacement.proxy.host, '192.0.2.3');
    assert.equal(manager.getAssignment(1), replacement.proxy);
    assert.equal(manager.getAssignment(2), second);
    assert.equal(manager.getAll().some(p => p.host === first.host), false);
    const next = manager.replaceFailedAssignment(2, second);
    assert.equal(next.proxy.host, '192.0.2.4');
    assert.notEqual(next.proxy.host, replacement.proxy.host);
});
test('stale failure cannot remove a newer assignment and exhausted pool is explicit', async () => {
    const manager = await fixture(3);
    const first = manager.getAssignment(1);
    const next = manager.replaceFailedAssignment(1, first);
    assert.equal(manager.replaceFailedAssignment(1, first), null);
    assert.equal(manager.getAssignment(1), next.proxy);
    assert.equal(manager.replaceFailedAssignment(1, next.proxy), null);
    assert.equal(manager.getAssignment(1), null);
    assert.equal(manager.getAll().length, 1, 'only the other reserved endpoint remains');
});
test('a newly fetched feed cannot immediately resurrect quarantined endpoints', async () => {
    const manager = await fixture();
    const failed = manager.getAssignment(1);
    manager.replaceFailedAssignment(1, failed);
    await manager.fetchAssignDirect([1, 2, 3, 4], () => {});
    assert.equal(manager.getAll().some(p => p.host === failed.host), false);
    assert.equal([...manager.assignments.values()].some(p => p?.host === failed.host), false);
});
test('exhausted attempt budget removes the failed route without reserving another proxy', async () => {
    const manager = await fixture();
    const failed = manager.getAssignment(1);
    assert.equal(manager.replaceFailedAssignment(1, failed, false), null);
    assert.equal(manager.getAssignment(1), null);
    assert.equal(manager.getAll().some(p => p.host === failed.host), false);
});
