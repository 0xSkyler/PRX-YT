'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTree } = require('./helpers.cjs');
const { withTimeout } = require('../src/main/runtime');
const tick = () => new Promise(setImmediate);
const url = 'https://www.youtube.com/watch?v=abcdefghijk';
const proxy = n => ({ id: `p${n}`, protocol: 'http', host: `192.0.2.${n}`, port: 8080, countryCode: 'US' });
async function until(predicate) {
    for (let n = 0; n < 200; n++) { if (predicate()) return; await tick(); }
    throw new Error('Fixture did not settle.');
}
function fixture() {
    const { YouTubeAutomationManager } = loadTree(path.resolve(__dirname, '../src'), {}, {
        setInterval: () => 1, clearInterval() {}
    })('main/YouTubeAutomationManager.js');
    const events = [], health = new Map(), callbacks = new Map(), requests = [];
    const browsers = {
        getProxyRotationState: id => health.get(id) || { proxy: null },
        cancelMeasurementSession: id => events.push(['stop', id]),
        setBrowserKeepAlive: (_id, enabled) => assert.equal(enabled, false),
        prepareCycleDocument: async id => events.push(['cleanup', id]),
        beginProxyCycle: id => health.set(id, { proxy: health.get(id).proxy, youtubeReached: false }),
        assignProxy: async (id, value) => { health.set(id, { proxy: value }); events.push(['proxy', id, value]); },
        startYouTubePlayback: async (id, config) => {
            events.push(['play', id, config.videoUrl, config.muted]);
            callbacks.set(id, config.onState);
            config.onState({ status: 'playing', currentTime: 1, duration: 20 });
        }
    };
    let fetchNumber = 0;
    const proxies = {
        cancelCurrentFetch() {},
        async fetchAssignDirect(ids, onAssignment, onProgress, options) {
            requests.push({ ids, options });
            fetchNumber++;
            ids.forEach((id, index) => onAssignment({ browserId: id, proxy: proxy(fetchNumber * 10 + index) }));
            onProgress(ids.length, ids.length, ids.length, ids.length, ids.length);
        }
    };
    const manager = new YouTubeAutomationManager(proxies, browsers, async (count, { onProgress }) => {
        const ids = Array.from({ length: count }, (_, n) => n + 1);
        onProgress(ids);
        return ids;
    });
    return { manager, browsers, proxies, events, health, callbacks, requests };
}

test('YouTube Start needs only a valid video URL and uses existing browser/proxy settings', async () => {
    const f = fixture();
    await assert.rejects(f.manager.start({ videoUrl: 'https://youtube.com.example.org/watch?v=abcdefghijk' }), /YouTube/i);
    assert.equal(f.events.length, 0);
    const results = [];
    f.manager.on('playbackResult', result => results.push(result));
    await f.manager.start({ videoUrl: 'https://youtu.be/abcdefghijk?si=tracking', muted: false,
        browserCount: 3, intervalSec: 60, proxySource: 'proxyscrape-free', proxyTier: 'all' });
    await until(() => !f.manager.getState().cycleInProgress);
    assert.equal(f.manager.getState().videoUrl, url);
    assert.equal(f.manager.getState().assignedBrowsers, 3);
    assert.equal(f.requests[0].options.tier, 'all');
    assert.equal(results.length, 3);
    assert.equal(f.events.filter(e => e[0] === 'play').length, 3);
    assert.ok(f.events.filter(e => e[0] === 'play').every(e => e[2] === url && e[3] === false));
    assert.ok(f.events.findLastIndex(e => e[0] === 'cleanup') < f.events.findIndex(e => e[0] === 'play'));
    await assert.rejects(f.manager.start({ videoUrl: url }), /Stop the current/);
    f.manager.stop();
});

test('healthy YouTube proxies survive a cycle and all-healthy cycles skip the provider', async () => {
    const f = fixture();
    await f.manager.start({ videoUrl: url, browserCount: 2, proxyTier: 'tier1' });
    await until(() => !f.manager.getState().cycleInProgress);
    for (const value of f.health.values()) value.youtubeReached = true;
    const firstProxies = [...f.health.values()].map(value => value.proxy.id);
    await f.manager.runNow();
    assert.equal(f.requests.length, 1);
    assert.equal(f.manager.getState().retainedBrowsers, 2);
    assert.deepEqual([...f.health.values()].map(value => value.proxy.id), firstProxies);
    assert.equal(f.events.filter(e => e[0] === 'cleanup').length, 4);
    assert.equal(f.events.filter(e => e[0] === 'play').length, 4);
    f.manager.stop();
});

test('a failed proxy is excluded while a healthy workspace reopens independently', async () => {
    const f = fixture();
    await f.manager.start({ videoUrl: url, browserCount: 2, proxyTier: 'tier1' });
    await until(() => !f.manager.getState().cycleInProgress);
    f.health.get(1).youtubeReached = true;
    f.health.get(2).youtubeReached = true;
    f.health.get(2).failed = true;
    const failedId = f.health.get(2).proxy.id;
    await f.manager.runNow();
    assert.deepEqual([...f.requests[1].ids], [2]);
    assert.equal(f.requests[1].options.failedProxies[0].id, failedId);
    assert.equal(f.requests[1].options.retainedAssignments[0].browserId, 1);
    assert.notEqual(f.health.get(2).proxy.id, failedId);
    assert.equal(f.manager.getState().retainedBrowsers, 1);
    assert.equal(f.manager.getState().replacedBrowsers, 1);
    f.manager.stop();
});

test('Stop wakes pending preparation and stale playback callbacks cannot report into a later run', async () => {
    const f = fixture();
    f.manager.ensureBrowserCount = () => new Promise(() => {});
    const pending = f.manager.start({ videoUrl: url, browserCount: 100 });
    f.manager.stop();
    await withTimeout(pending, 1000, () => { throw new Error('Stop failed to cancel preparation.'); });
    assert.equal(f.manager.getState().running, false);
    assert.equal(f.requests.length, 0);

    const g = fixture(), results = [];
    g.manager.on('playbackResult', value => results.push(value));
    await g.manager.start({ videoUrl: url, browserCount: 1 });
    await until(() => !g.manager.getState().cycleInProgress);
    const old = g.callbacks.get(1);
    g.manager.stop();
    await g.manager.start({ videoUrl: url, browserCount: 1 });
    await until(() => !g.manager.getState().cycleInProgress);
    const count = results.length;
    old({ status: 'error', message: 'late old cycle' });
    assert.equal(results.length, count);
    g.manager.stop();
});

test('Run Now during a provider wait cancels old playback and serializes the next cycle', async () => {
    const f = fixture();
    let rejectFetch, calls = 0, active = 0, peak = 0;
    f.proxies.cancelCurrentFetch = () => { rejectFetch?.(new Error('cancelled')); rejectFetch = null; };
    f.proxies.fetchAssignDirect = async (ids, assign, progress) => {
        active++; peak = Math.max(peak, active); calls++;
        try {
            if (calls === 1) await new Promise((_resolve, reject) => { rejectFetch = reject; });
            else { assign({ browserId: ids[0], proxy: proxy(30) }); progress(1, 1, 1, 1, 1); }
        } finally { active--; }
    };
    await f.manager.start({ videoUrl: url, browserCount: 1 });
    await until(() => calls === 1);
    const stopsBefore = f.events.filter(e => e[0] === 'stop').length;
    await f.manager.runNow();
    await until(() => f.manager.getState().cycleNumber === 2 && !f.manager.getState().cycleInProgress);
    assert.ok(f.events.filter(e => e[0] === 'stop').length > stopsBefore);
    assert.equal(calls, 2);
    assert.equal(peak, 1);
    assert.equal(f.manager.getState().lastError, undefined);
    f.manager.stop();
});
