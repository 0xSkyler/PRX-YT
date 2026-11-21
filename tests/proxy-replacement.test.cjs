'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTree } = require('./helpers.cjs');
const { checkProxyHealth } = require('../src/main/ProxyHealthCheck');
const videoUrl = 'https://www.youtube.com/watch?v=abcdefghijk';
async function fixture(count = 4, browserIds = [1, 2]) {
    const feed = Array.from({ length: count }, (_, n) => `http://192.0.2.${n + 1}:8080`).join('\n');
    const { ProxyManager } = loadTree(path.resolve(__dirname, '../src'), {}, {
        fetch: async () => ({ ok: true, text: async () => feed })
    })('main/ProxyManager.js');
    const manager = new ProxyManager();
    await manager.fetchAssignDirect(browserIds, () => {});
    return manager;
}

async function playbackFixture(statuses, playbackState = { status: 'playing', readyState: 4 }) {
    const proxies = await fixture(5, []), checked = [], played = [], routed = [];
    const { YouTubeAutomationManager } = loadTree(path.resolve(__dirname, '../src'), {})('main/YouTubeAutomationManager.js');
    let proxy = null, callback;
    const browsers = {
        getProxyRotationState: () => ({ proxy }),
        cancelMeasurementSession() {}, setBrowserKeepAlive() {},
        prepareCycleDocument: async () => {},
        assignProxy: async (_id, value) => { proxy = value; routed.push(value); },
        checkProxyHealth: async (_id, url) => {
            assert.ok(proxy, 'Transport checks must use an assigned proxy.');
            const status = statuses[Math.min(checked.length, statuses.length - 1)];
            checked.push({ proxy, url });
            return checkProxyHealth({ fetch: async () => ({ status }) }, url);
        },
        startYouTubePlayback: async (id, config) => {
            assert.ok(proxy, 'A rejected proxy must never fall back to direct playback.');
            assert.equal(proxy, proxies.getAssignment(id));
            played.push({ proxy, url: config.videoUrl });
            callback = config.onState;
            callback(playbackState);
        }
    };
    const automation = new YouTubeAutomationManager(proxies, browsers, async () => [1]);
    const settle = async () => {
        for (let n = 0; n < 200; n++) {
            if (!automation.getState().cycleInProgress && !automation.assignmentActive) return;
            await new Promise(setImmediate);
        }
        throw new Error('Proxy replacement fixture did not settle.');
    };
    return { proxies, automation, checked, played, routed, settle, emit: state => callback(state) };
}

test('HTTP407 removes the rejected proxy and plays the same video through an unused replacement', async () => {
    const f = await playbackFixture([407, 200]);
    try {
        await f.automation.start({ videoUrl, browserCount: 1 });
        await f.settle();
        assert.equal(f.checked.length, 2);
        const rejected = f.checked[0].proxy, replacement = f.checked[1].proxy;
        assert.notEqual(replacement.host, rejected.host);
        assert.equal(f.proxies.getAll().some(proxy => proxy.host === rejected.host), false);
        assert.equal(f.proxies.getAssignment(1), replacement);
        assert.deepEqual(f.checked.map(check => check.url), [videoUrl, videoUrl]);
        assert.deepEqual(f.played, [{ proxy: replacement, url: videoUrl }]);
    } finally { f.automation.stop(); }
});

test('three HTTP407 candidates exhaust the retry budget and remove the route without direct playback', async () => {
    const f = await playbackFixture([407]);
    try {
        await f.automation.start({ videoUrl, browserCount: 1 });
        await f.settle();
        assert.equal(f.checked.length, 3);
        assert.equal(new Set(f.checked.map(check => check.proxy.host)).size, 3);
        assert.equal(f.proxies.getAssignment(1), null);
        assert.equal(f.routed.at(-1), null);
        assert.equal(f.played.length, 0);
        assert.equal(f.proxies.getAll().length, 2, 'The fourth unused candidate must remain unassigned.');
        assert.match(f.automation.getState().lastError, /three-proxy retry limit/);
    } finally { f.automation.stop(); }
});

test('a later proxy-authentication diagnostic replaces only the failed route', async () => {
    const f = await playbackFixture([200]);
    try {
        await f.automation.start({ videoUrl, browserCount: 1 });
        await f.settle();
        const rejected = f.proxies.getAssignment(1);
        f.emit({ status: 'error', code: 'proxy-authentication' });
        await f.settle();
        assert.notEqual(f.proxies.getAssignment(1), rejected);
        assert.equal(f.proxies.getAll().some(proxy => proxy.host === rejected.host), false);
        assert.deepEqual(f.played.map(play => play.url), [videoUrl, videoUrl]);
    } finally { f.automation.stop(); }
});

test('HTTP403, HTTP429 and CAPTCHA hold their proxy even after late failure diagnostics', async () => {
    for (const status of [403, 429, 200]) {
        const f = await playbackFixture([status], status === 200
            ? { status: 'interaction-required', code: 'captcha', message: 'CAPTCHA requires your action.' }
            : { status: 'playing', readyState: 4 });
        try {
            await f.automation.start({ videoUrl, browserCount: 1 });
            await f.settle();
            const held = f.proxies.getAssignment(1);
            f.emit({ status: 'error', code: 'proxy-transport-error' });
            f.emit({ status: 'error', code: 'proxy-authentication' });
            await f.automation.requestCycle();
            await f.settle();
            assert.equal(f.proxies.getAssignment(1), held);
            assert.equal(f.checked.length, 1);
            assert.equal(f.played.length, 1);
            assert.deepEqual(Array.from(f.automation.getState().blockedBrowserIds), [1]);
        } finally { f.automation.stop(); }
    }
});
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
