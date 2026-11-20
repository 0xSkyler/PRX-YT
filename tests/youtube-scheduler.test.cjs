'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTree } = require('./helpers.cjs');
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const url = 'https://www.youtube.com/watch?v=abcdefghijk';
async function until(predicate) {
    for (let n = 0; n < 200; n++) { if (predicate()) return; await tick(); }
    throw new Error('Scheduler fixture did not settle.');
}
function fixture(count = 4, overrides = {}) {
    const { YouTubeAutomationManager } = loadTree(path.resolve(__dirname, '../src'), {}, {
        setInterval: () => 1, clearInterval() {}, ...overrides
    })('main/YouTubeAutomationManager.js');
    const health = new Map(), plays = [], checks = [], callbacks = new Map();
    const browsers = {
        getProxyRotationState: id => health.get(id) || { proxy: null },
        cancelMeasurementSession() {}, setBrowserKeepAlive() {}, prepareCycleDocument: async () => {},
        beginProxyCycle: id => health.set(id, { proxy: health.get(id).proxy }),
        assignProxy: async (id, proxy) => { health.set(id, { proxy }); },
        checkProxyHealth: async id => { checks.push(id); return { status: 'reachable' }; },
        startYouTubePlayback: async (id, config) => { plays.push(id); callbacks.set(id, config.onState); config.onState({ status: 'playing', readyState: 4 }); }
    };
    let fetches = 0;
    const proxies = { cancelCurrentFetch() {}, fetchAssignDirect: async (ids, assign, progress) => {
        fetches++;
        ids.forEach(id => assign({ browserId: id, proxy: { id: 'p' + id, host: '192.0.2.' + id, port: 8080 } }));
        progress(ids.length, ids.length, ids.length, ids.length, ids.length);
    } };
    const manager = new YouTubeAutomationManager(proxies, browsers, async (_count, { onProgress }) => {
        const ids = Array.from({ length: count }, (_, i) => i + 1); onProgress(ids); return ids;
    });
    return { manager, browsers, proxies, health, plays, checks, callbacks, fetches: () => fetches };
}
function clockFixture(count = 1) {
    let now = Date.now(), sequence = 0;
    const timers = new Map();
    const f = fixture(count, {
        Date: class extends Date { static now() { return now; } },
        setTimeout(fn, ms) { const id = ++sequence; timers.set(id, { fn, at: now + ms }); return id; },
        clearTimeout(id) { timers.delete(id); }
    });
    return { ...f, timers, async advance(ms) {
        const end = now + ms;
        for (let n = 0; n < 1000; n++) {
            await tick();
            const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) { now = end; return; }
            now = next[1].at; timers.delete(next[0]); next[1].fn();
        }
        throw new Error('Unbounded scheduler timer loop.');
    } };
}

test('100 assigned browsers start at most three health checks and playback setups together', async () => {
    const f = fixture(100), gate = deferred();
    let active = 0, peak = 0, started = 0;
    f.browsers.checkProxyHealth = async () => {
        active++; started++; peak = Math.max(peak, active);
        await gate.promise; active--; return { status: 'reachable' };
    };
    await f.manager.start({ videoUrl: url, browserCount: 100 });
    await until(() => started >= 3);
    assert.equal(started, 3);
    gate.resolve();
    await until(() => !f.manager.getState().cycleInProgress);
    assert.equal(peak, 3);
    assert.equal(f.plays.length, 100);
    f.manager.stop();
});

test('a restriction is held across scheduled cycles until the user explicitly retries', async () => {
    const f = fixture(2);
    await f.manager.start({ videoUrl: url, browserCount: 2 });
    await until(() => !f.manager.getState().cycleInProgress);
    f.callbacks.get(1)({ status: 'interaction-required', code: 'captcha', message: 'CAPTCHA requires user action.' });
    f.health.get(2).youtubeReached = true;
    await f.manager.requestCycle();
    assert.deepEqual(f.plays, [1, 2, 2]);
    assert.deepEqual(Array.from(f.manager.getState().blockedBrowserIds), [1]);
    await f.manager.runNow();
    assert.equal(f.plays.filter(id => id === 1).length, 2);
    assert.deepEqual(Array.from(f.manager.getState().blockedBrowserIds), []);
    f.manager.stop();
});

test('an access restriction opens once for inspection and holds its proxy on later scheduled cycles', async () => {
    const f = fixture(1), results = [];
    f.browsers.checkProxyHealth = async () => ({ status: 'interaction-required', code: 'http-429', message: 'Access is rate limited.', httpStatus: 429 });
    f.manager.on('playbackResult', value => results.push(value.result));
    await f.manager.start({ videoUrl: url, browserCount: 1 });
    await until(() => !f.manager.getState().cycleInProgress);
    assert.deepEqual(f.plays, [1]);
    assert.ok(results.some(value => value.status === 'interaction-required'));
    await f.manager.requestCycle();
    assert.equal(f.fetches(), 1, 'A restriction must not trigger another proxy assignment');
    assert.deepEqual(f.plays, [1]);
    f.manager.stop();
});

test('resource pressure stops a run and retains an actionable diagnostic', async () => {
    const f = fixture(1);
    await f.manager.start({ videoUrl: url, browserCount: 1 });
    f.manager.pauseForResourcePressure('Available memory is below the safe limit.');
    assert.equal(f.manager.getState().running, false);
    assert.match(f.manager.getState().lastError, /memory/);
    assert.equal(f.manager.timer, null);
});

test('provider outages retry with a finite backoff budget and Stop releases all waits', async () => {
    const f = clockFixture();
    let requests = 0;
    f.proxies.fetchAssignDirect = async () => { requests++; throw new Error('Network unavailable'); };
    await f.manager.start({ videoUrl: url, browserCount: 1 });
    await until(() => !f.manager.getState().cycleInProgress);
    await f.advance(60_000);
    assert.equal(requests, 3);
    assert.equal(f.manager.getState().cycleInProgress, false);
    assert.match(f.manager.getState().lastError, /Network unavailable/);
    assert.equal(f.timers.size, 0);
    f.manager.stop();
    assert.equal(f.timers.size, 0);
});

test('the lifecycle watchdog releases a provider that ignores cancellation', async () => {
    const f = clockFixture();
    let requests = 0;
    f.proxies.fetchAssignDirect = async () => { requests++; return new Promise(() => {}); };
    await f.manager.start({ videoUrl: url, browserCount: 1 });
    await until(() => requests === 1);
    await f.advance(10 * 60_000);
    assert.equal(requests, 3);
    assert.equal(f.manager.getState().cycleInProgress, false);
    assert.match(f.manager.getState().lastError, /timed out/i);
    f.manager.stop();
    assert.equal(f.timers.size, 0);
});

test('a scheduled boundary during stalled setup cannot bypass the finite retry budget', async () => {
    const f = clockFixture();
    let requests = 0;
    f.proxies.fetchAssignDirect = async () => { requests++; return new Promise(() => {}); };
    await f.manager.start({ videoUrl: url, browserCount: 1 });
    await until(() => requests === 1);
    await f.manager.requestCycle();
    await f.advance(10 * 60_000);
    assert.equal(requests, 3);
    assert.match(f.manager.getState().lastError, /paused.*3|3.*paused/i);
    assert.equal(f.manager.getState().nextCycleAt, undefined);
    f.manager.stop();
});

test('Stop prevents queued health checks and late old results from entering a new run', async () => {
    const f = fixture(10), gate = deferred(), results = [];
    let checks = 0;
    f.browsers.checkProxyHealth = async () => { checks++; await gate.promise; return { status: 'interaction-required', message: 'old restriction' }; };
    f.manager.on('playbackResult', result => results.push(result));
    await f.manager.start({ videoUrl: url, browserCount: 10 });
    await until(() => checks >= 3);
    f.manager.stop();
    assert.equal(checks, 3);
    f.browsers.checkProxyHealth = async () => ({ status: 'reachable' });
    await f.manager.start({ videoUrl: url, browserCount: 10 });
    await until(() => !f.manager.getState().cycleInProgress);
    const resultCount = results.length;
    gate.resolve(); await tick();
    assert.equal(results.length, resultCount);
    assert.deepEqual(Array.from(f.manager.getState().blockedBrowserIds), []);
    f.manager.stop();
});

test('a CAPTCHA health flag holds the slot even if the outgoing renderer callback was missed', async () => {
    const f = fixture(1);
    await f.manager.start({ videoUrl: url, browserCount: 1 });
    await until(() => !f.manager.getState().cycleInProgress);
    f.health.get(1).captchaSeen = true;
    await f.manager.requestCycle();
    assert.equal(f.fetches(), 1);
    assert.deepEqual(f.plays, [1]);
    f.manager.stop();
});

test('Run Now while preparing is coalesced with the first cycle', async () => {
    const f = fixture(1), gate = deferred();
    f.manager.ensureBrowserCount = () => gate.promise;
    const starting = f.manager.start({ videoUrl: url, browserCount: 1 });
    await f.manager.runNow();
    gate.resolve([1]); await starting;
    await until(() => !f.manager.getState().cycleInProgress);
    assert.equal(f.fetches(), 1);
    assert.equal(f.manager.getState().cycleNumber, 1);
    f.manager.stop();
});

test('a failed cleanup slot does not prevent the other browsers from starting', async () => {
    const f = clockFixture(4);
    f.browsers.prepareCycleDocument = async id => { if (id === 2) throw new Error('Browser 2 cleanup failed'); };
    await f.manager.start({ videoUrl: url, browserCount: 4 });
    await until(() => !f.manager.getState().cycleInProgress);
    assert.deepEqual(f.plays, [1, 3, 4]);
    assert.match(f.manager.getState().lastError, /Browser 2/);
    f.manager.stop();
    assert.equal(f.timers.size, 0);
});

test('multiple pasted links choose one valid video per browser and retain each choice across cycles', async () => {
    const f = fixture(20), second = 'https://www.youtube.com/watch?v=lmnopqrstuv';
    const choices = new Map();
    f.browsers.startYouTubePlayback = async (id, config) => {
        if (choices.has(id)) assert.equal(config.videoUrl, choices.get(id));
        choices.set(id, config.videoUrl);
    };
    await f.manager.start({ videoUrl: url + '\nhttps://youtu.be/lmnopqrstuv\n' + url, browserCount: 20 });
    await until(() => !f.manager.getState().cycleInProgress);
    assert.deepEqual(Array.from(f.manager.getState().videoUrls), [url, second]);
    assert.equal(choices.size, 20);
    assert.ok([...choices.values()].every(value => [url, second].includes(value)));
    assert.deepEqual({ ...f.manager.getState().videoAssignments }, Object.fromEntries(choices));
    for (const value of f.health.values()) value.youtubeReached = true;
    await f.manager.requestCycle();
    f.manager.stop();
});

test('an invalid video in a pasted list fails before any browser or provider side effect', async () => {
    const f = fixture(1);
    await assert.rejects(f.manager.start({ videoUrls: [url, 'https://example.test/watch?v=lmnopqrstuv'], browserCount: 1 }), /YouTube/i);
    assert.equal(f.fetches(), 0);
    assert.equal(f.manager.getState().running, false);
    assert.deepEqual(f.plays, []);
});

test('confirmed proxy transport failure immediately consumes unused candidates with a three-attempt cap', async () => {
    const f = clockFixture(1), attempts = [], replacements = [];
    f.browsers.checkProxyHealth = async id => {
        attempts.push(f.health.get(id).proxy.id);
        return { status: 'failed', code: 'proxy-transport-error', message: 'Proxy connection failed.' };
    };
    f.proxies.replaceFailedAssignment = (id, failed, reserve = true) => {
        if (!reserve) return null;
        replacements.push(failed.id);
        return { browserId: id, proxy: { id: 'unused-' + replacements.length, host: '192.0.2.' + (100 + replacements.length), port: 8080 } };
    };
    await f.manager.start({ videoUrl: url, browserCount: 1 });
    await until(() => !f.manager.getState().cycleInProgress);
    assert.deepEqual(attempts, ['p1', 'unused-1', 'unused-2']);
    assert.equal(replacements.length, 2);
    await f.advance(60_000);
    assert.equal(f.fetches(), 1, 'Exhausted candidates must not cause an automatic provider fetch');
    assert.match(f.manager.getState().lastError, /three|3|retry|unused/i);
    f.manager.stop();
});

test('later proxy transport errors reuse the same three-worker setup limit and keep the assigned video', async () => {
    const f = fixture(10), gate = deferred(), replacements = [];
    await f.manager.start({ videoUrl: url, browserCount: 10 });
    await until(() => !f.manager.getState().cycleInProgress);
    let active = 0, peak = 0, checks = 0;
    f.browsers.checkProxyHealth = async () => {
        checks++; active++; peak = Math.max(peak, active);
        await gate.promise; active--; return { status: 'reachable' };
    };
    f.proxies.replaceFailedAssignment = (id, failed) => {
        replacements.push(failed.id);
        return { browserId: id, proxy: { id: 'unused-' + id, host: '198.51.100.' + id, port: 8080 } };
    };
    for (const callback of f.callbacks.values()) callback({ status: 'error', code: 'proxy-transport-error', message: 'Tunnel failed.' });
    await until(() => checks >= 3);
    assert.equal(checks, 3);
    gate.resolve();
    await until(() => f.plays.length === 20);
    assert.equal(peak, 3);
    assert.equal(replacements.length, 10);
    assert.ok(Object.values(f.manager.getState().videoAssignments).every(value => value === url));
    f.manager.stop();
});

test('explicit retry reopens a CAPTCHA slot through its existing proxy', async () => {
    const f = fixture(1);
    await f.manager.start({ videoUrl: url, browserCount: 1 });
    await until(() => !f.manager.getState().cycleInProgress);
    f.health.get(1).captchaSeen = true;
    f.callbacks.get(1)({ status: 'interaction-required', code: 'captcha', message: 'User action required.' });
    const originalProxy = f.health.get(1).proxy;
    await f.manager.runNow();
    assert.equal(f.fetches(), 1);
    assert.equal(f.health.get(1).proxy, originalProxy);
    assert.deepEqual(f.plays, [1, 1]);
    f.manager.stop();
});

test('a late callback from the failed proxy cannot block its newly reserved replacement', async () => {
    const f = fixture(1), reserved = new Map();
    f.proxies.getAssignment = id => reserved.get(id) || f.health.get(id)?.proxy;
    f.proxies.replaceFailedAssignment = id => {
        const proxy = { id: 'replacement', host: '198.51.100.10', port: 8080 };
        reserved.set(id, proxy);
        return { browserId: id, proxy };
    };
    await f.manager.start({ videoUrl: url, browserCount: 1 });
    await until(() => !f.manager.getState().cycleInProgress);
    const oldCallback = f.callbacks.get(1);
    oldCallback({ status: 'error', code: 'proxy-transport-error', message: 'Proxy failed.' });
    oldCallback({ status: 'interaction-required', code: 'captcha', message: 'Late old document.' });
    await until(() => f.plays.length === 2);
    assert.deepEqual(Array.from(f.manager.getState().blockedBrowserIds), []);
    f.manager.stop();
});

test('a held CAPTCHA proxy remains exclusively reserved while failed and healthy slots advance', async () => {
    const f = fixture(3), results = [];
    let rows = [1, 2, 3];
    const { ProxyManager } = loadTree(path.resolve(__dirname, '../src'), {}, {
        fetch: async () => ({ ok: true, text: async () => rows.map(id => `http://192.0.2.${id}:8080`).join('\n') })
    })('main/ProxyManager.js');
    const proxies = new ProxyManager();
    f.manager.proxyManager = proxies;
    f.manager.on('playbackResult', result => results.push(result));
    await f.manager.start({ videoUrl: url, browserCount: 3, proxySource: 'all-working', proxyApiUrl: 'http://fixture.test/list' });
    await until(() => !f.manager.getState().cycleInProgress);
    const held = f.health.get(1).proxy, healthy = f.health.get(3).proxy;
    f.health.get(1).captchaSeen = true;
    f.callbacks.get(1)({ status: 'interaction-required', code: 'captcha', message: 'Manual verification required.' });
    f.health.get(2).failed = true;
    f.health.get(3).youtubeReached = true;
    rows = [1, 2, 3, 4];
    await f.manager.requestCycle();
    assert.equal(proxies.getAssignment(1), held);
    assert.notEqual(proxies.getAssignment(2), held);
    assert.equal(f.health.get(2).proxy.host, '192.0.2.4');
    assert.equal(proxies.getAssignment(3), healthy);
    assert.equal(f.manager.getState().assignedBrowsers, 3);
    assert.deepEqual(Array.from(f.manager.getState().blockedBrowserIds), [1]);
    await f.manager.runNow();
    assert.equal(proxies.getAssignment(1), held);
    const before = results.length;
    f.callbacks.get(1)({ status: 'playing', currentTime: 2 });
    assert.equal(results.length, before + 1);
    f.manager.stop();
});

test('a retained slot that recovers before provider fetching keeps its newly reserved proxy', async () => {
    const f = fixture(3);
    let rows = [1, 2, 3, 4];
    const { ProxyManager } = loadTree(path.resolve(__dirname, '../src'), {}, {
        fetch: async () => ({ ok: true, text: async () => rows.map(id => `http://192.0.2.${id}:8080`).join('\n') })
    })('main/ProxyManager.js');
    const proxies = new ProxyManager();
    f.manager.proxyManager = proxies;
    await f.manager.start({ videoUrl: url, browserCount: 3, proxySource: 'all-working', proxyApiUrl: 'http://fixture.test/list' });
    await until(() => !f.manager.getState().cycleInProgress);
    f.health.get(1).youtubeReached = true;
    f.health.get(2).failed = true;
    f.health.get(3).youtubeReached = true;
    f.browsers.checkProxyHealth = async id => f.health.get(id).proxy.host === '192.0.2.3'
        ? { status: 'failed', code: 'proxy-transport-error', message: 'Proxy connection failed.' } : { status: 'reachable' };
    rows = [1, 2, 3, 4, 5];
    await f.manager.requestCycle();
    assert.equal(f.health.get(3).proxy.host, '192.0.2.4');
    assert.equal(proxies.getAssignment(3), f.health.get(3).proxy);
    assert.equal(f.health.get(2).proxy.host, '192.0.2.5');
    assert.equal(new Set([...f.health.values()].map(value => value.proxy.host)).size, 3);
    f.manager.stop();
});

test('a proxy that fails during replacement setup still advances to its third unused candidate', async () => {
    const f = fixture(1), attempts = [];
    let reserved, sequence = 1;
    f.proxies.getAssignment = id => reserved || f.health.get(id)?.proxy;
    f.proxies.replaceFailedAssignment = (id, expected, reserve) => {
        if (expected !== f.proxies.getAssignment(id) || !reserve) return null;
        reserved = { id: 'p' + (++sequence), host: '198.51.100.' + sequence, port: 8080 };
        return { browserId: id, proxy: reserved };
    };
    f.browsers.startYouTubePlayback = async (id, config) => {
        attempts.push(f.health.get(id).proxy.id);
        config.onState(attempts.length < 3 ? { status: 'error', code: 'proxy-transport-error', message: 'Immediate tunnel failure.' }
            : { status: 'playing', readyState: 4, currentTime: 1 });
    };
    await f.manager.start({ videoUrl: url, browserCount: 1 });
    await until(() => attempts.length === 3 && !f.manager.getState().cycleInProgress);
    assert.deepEqual(attempts, ['p1', 'p2', 'p3']);
    f.manager.stop();
});

test('a retained proxy replaced during a provider wait is reserved before that feed commits', async () => {
    const f = fixture(3), feed = deferred();
    let requests = 0;
    const { ProxyManager } = loadTree(path.resolve(__dirname, '../src'), {}, {
        fetch: async () => {
            requests++;
            const number = requests;
            return { ok: true, text: async () => {
                if (number === 2) await feed.promise;
                return (number === 1 ? [1, 2, 3, 4] : [1, 2, 3, 4, 5]).map(id => `http://192.0.2.${id}:8080`).join('\n');
            } };
        }
    })('main/ProxyManager.js');
    const proxies = new ProxyManager();
    f.manager.proxyManager = proxies;
    await f.manager.start({ videoUrl: url, browserCount: 3, proxySource: 'all-working', proxyApiUrl: 'http://fixture.test/list' });
    await until(() => !f.manager.getState().cycleInProgress);
    f.health.get(1).youtubeReached = true;
    f.health.get(2).failed = true;
    f.health.get(3).youtubeReached = true;
    const cycling = f.manager.requestCycle();
    await until(() => requests === 2);
    f.callbacks.get(3)({ status: 'error', code: 'proxy-transport-error', message: 'Tunnel failed while provider was pending.' });
    await until(() => f.health.get(3).proxy.host === '192.0.2.4');
    feed.resolve(); await cycling;
    assert.equal(proxies.getAssignment(3), f.health.get(3).proxy);
    assert.equal(f.health.get(2).proxy.host, '192.0.2.5');
    f.manager.stop();
});
