'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkProxyHealth } = require('../src/main/ProxyHealthCheck');
const video = 'https://www.youtube.com/watch?v=PRXYTtest01';
test('transport HEAD uses only selected video and never follows a redirect', async () => {
    let request, cancelled = false;
    const result = await checkProxyHealth({ fetch: async (url, options) => {
        request = { url, options };
        return { status: 200, body: { cancel: async () => { cancelled = true; } } };
    } }, video);
    assert.equal(request.url, video);
    assert.equal(request.options.method, 'HEAD');
    assert.equal(request.options.redirect, 'manual');
    assert.equal(cancelled, true);
    assert.equal(result.status, 'reachable');
    assert.doesNotMatch(result.message, /playing/i);
});
test('access limits and verification redirects require action, not proxy rotation', async () => {
    for (const status of [302, 403, 429]) {
        const result = await checkProxyHealth({ fetch: async () => ({ status }) }, video);
        assert.equal(result.status, 'interaction-required');
        assert.equal(result.httpStatus, status);
    }
});
test('failed tunnels are transport failures and user cancellation is not one', async () => {
    const result = await checkProxyHealth({ fetch: async () => { throw Error('net::ERR_TUNNEL_CONNECTION_FAILED'); } }, video);
    assert.equal(result.status, 'failed');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(checkProxyHealth({ fetch: async () => { throw Error('must not run'); } }, video, { signal: controller.signal }), /cancelled/i);
});
test('health timeout remains bounded even when native fetch ignores cancellation', async () => {
    let signal;
    const result = await checkProxyHealth({ fetch: (_url, options) => { signal = options.signal; return new Promise(() => {}); } }, video, { timeoutMs: 15 });
    assert.equal(result.code, 'transport-timeout');
    assert.equal(signal.aborted, true);
});
test('a late health result cannot update a superseded assignment', async () => {
    let finish;
    const pending = checkProxyHealth({ fetch: () => new Promise(resolve => { finish = resolve; }) }, video, { isCurrent: () => false });
    await assert.rejects(pending, /cancelled/i);
    assert.equal(finish, undefined, 'stale checks must not send a request');
});
