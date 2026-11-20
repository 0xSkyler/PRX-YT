'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTree, fakeElectron } = require('./helpers.cjs');
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
async function fixture() {
    const electron = fakeElectron();
    const { BrowserManager } = loadTree(path.resolve(__dirname, '../src'), electron)('main/BrowserManager.js');
    const manager = new BrowserManager({ workflow: 'youtube' });
    manager.attachWindow(electron.window);
    await manager.createBrowser(1, { startPage: 'about:blank' });
    const managed = manager.get(1), wc = managed.view.webContents;
    wc.setAudioMuted = value => { wc.muted = value; };
    return { manager, managed, wc, electron };
}

test('YouTube workspaces use only the cache preload and ignore inherited automatic prompt messages', async () => {
    const f = await fixture();
    assert.ok(f.managed.view.options.webPreferences.preload.endsWith('workspace.js'));
    assert.equal(f.managed.view.options.webPreferences.sandbox, true);
    assert.equal(f.managed.view.options.webPreferences.contextIsolation, true);
    f.wc.mainFrame = { processId: 1, routingId: 1 };
    let clicks = 0;
    f.wc.sendInputEvent = () => clicks++;
    f.wc.emit('ipc-message', { senderFrame: f.wc.mainFrame }, 'dom:site-cookie-consent-click', { documentUrl: 'about:blank', documentId: 'x', point: { x: 10, y: 10 } });
    f.wc.emit('ipc-message', { senderFrame: f.wc.mainFrame }, 'dom:google-prompt-click', {});
    assert.equal(clicks, 0);
    await f.manager.destroyAll();
});

test('cancelled cleanup retains its barrier until every native storage operation settles', async () => {
    const f = await fixture(), gate = deferred(), cancelled = new AbortController();
    f.wc.url = 'https://www.youtube.com/watch?v=abcdefghijk';
    let clears = 0, navigations = 0;
    const nativeLoad = f.wc.loadURL.bind(f.wc);
    f.wc.loadURL = async url => { navigations++; return nativeLoad(url); };
    f.managed.session.clearStorageData = async () => { clears++; throw new Error('clear-failed'); };
    f.managed.session.clearCache = () => gate.promise;
    const first = f.manager.prepareCycleDocument(1, cancelled.signal);
    while (!clears) await tick();
    cancelled.abort();
    await assert.rejects(first, { name: 'AbortError' });
    const second = f.manager.prepareCycleDocument(1, new AbortController().signal);
    const secondFailure = assert.rejects(second, /clear-failed/);
    await tick();
    assert.equal(navigations, 1, 'A new document started while old native clearing was live');
    gate.resolve();
    await secondFailure;
    f.managed.session.clearStorageData = async () => {};
    await f.manager.prepareCycleDocument(1, new AbortController().signal);
    assert.equal(navigations, 1, 'An already released blank document was needlessly navigated again');
    await f.manager.destroyAll();
});

test('a delayed outgoing ERR_FAILED does not reject an observed blank-document commit', async () => {
    const f = await fixture();
    f.wc.url = 'https://www.youtube.com/watch?v=abcdefghijk';
    f.wc.loadURL = () => {
        setImmediate(() => { f.wc.url = 'about:blank'; f.wc.emit('did-navigate', {}, 'about:blank'); });
        return Promise.reject(new Error("ERR_FAILED (-2) loading 'about:blank'"));
    };
    await f.manager.releaseResearchDocument(f.managed, { timeoutMs: 200 });
    assert.equal(f.wc.getURL(), 'about:blank');
    assert.equal(f.wc.listenerCount('destroyed'), 0);
    await f.manager.destroyAll();
});

test('failed blank navigation and failed replacement block cleanup and can be retried safely', async () => {
    const f = await fixture();
    f.wc.url = 'https://www.youtube.com/watch?v=abcdefghijk';
    const OriginalView = f.electron.BrowserView;
    f.electron.BrowserView = class extends OriginalView {
        constructor(options) { super(options); this.webContents.loadURL = () => Promise.reject(new Error('ERR_FAILED (-2)')); }
    };
    f.wc.loadURL = () => Promise.reject(new Error('ERR_FAILED (-2)'));
    await assert.rejects(f.manager.releaseResearchDocument(f.managed, { timeoutMs: 10 }), /could not release/);
    assert.equal(f.managed.blankDocumentReady, false);
    f.managed.view.webContents.loadURL = async function(url) { this.url = url; this.emit('dom-ready'); };
    await f.manager.releaseResearchDocument(f.managed, { timeoutMs: 200 });
    assert.equal(f.managed.blankDocumentReady, true);
    await f.manager.destroyAll();
});

test('disabling inherited Keep Alive creates no timers or synthetic user gestures in YouTube', async () => {
    const f = await fixture();
    const scripts = [];
    f.wc.executeJavaScript = (...args) => { scripts.push(args); return Promise.resolve(); };
    f.manager.setBrowserKeepAlive(1, false);
    f.manager.setKeepAliveAll(false);
    f.manager.cancelKeepAliveAction(f.managed);
    assert.equal(scripts.length, 0);
    assert.equal(f.manager.keepAliveTimer, null);
    assert.throws(() => f.manager.setBrowserKeepAlive(1, true), /unavailable/);
    await f.manager.destroyAll();
});

test('proxy routing cannot change until the old video document has been released', async () => {
    const f = await fixture(), stopped = deferred(), events = [];
    f.wc.url = 'https://www.youtube.com/watch?v=abcdefghijk';
    f.managed.playbackController = { stop: () => stopped.promise };
    const nativeLoad = f.wc.loadURL.bind(f.wc);
    f.wc.loadURL = async url => { events.push(['document', url]); return nativeLoad(url); };
    f.managed.session.setProxy = async value => { events.push(['routing', value.mode || value.proxyRules]); };
    const change = f.manager.assignProxy(1, null);
    await tick();
    assert.equal(f.wc.muted, true);
    assert.equal(events.length, 0);
    stopped.resolve();
    await change;
    assert.deepEqual(events, [['document', 'about:blank'], ['routing', 'direct']]);
    await f.manager.destroyAll();
});

test('renderer crash recovery recreates playback observation and respects Stop cancellation', async () => {
    const f = await fixture();
    const signal = new AbortController();
    const config = { videoUrl: 'https://www.youtube.com/watch?v=abcdefghijk', muted: true, signal: signal.signal, onState() {} };
    f.managed.playbackConfig = config;
    f.managed.playbackController = { stop: async () => {} };
    const restarted = [];
    f.manager.startYouTubePlayback = async (id, value) => { restarted.push([id, value]); };
    await f.manager.handleCrash(f.managed, { startPage: 'about:blank' });
    assert.equal(restarted.length, 1);
    assert.equal(restarted[0][1], config);
    f.managed.playbackConfig = config;
    signal.abort();
    await f.manager.handleCrash(f.managed, { startPage: 'about:blank' });
    assert.equal(restarted.length, 1);
    await f.manager.destroyAll();
});

test('shrinking and regrowing a workspace cannot outrun its previous native storage cleanup', async () => {
    const f = await fixture(), clearing = deferred();
    const originalSession = f.managed.session;
    f.managed.pendingStorageCleanup = clearing.promise;
    const disposing = f.manager.destroyBrowser(1);
    await tick();
    assert.equal(f.manager.getAll().length, 0);
    let recreated = false;
    const creating = f.manager.createBrowser(1, { startPage: 'about:blank' }).then(() => { recreated = true; });
    try {
        await tick();
        assert.equal(recreated, false, 'The persistent partition was reused before its old clearing settled');
    } finally { clearing.resolve(); }
    await disposing;
    await creating;
    assert.equal(f.manager.get(1).session, originalSession);
    await f.manager.destroyAll();
});

test('initial blank readiness follows the committed document even when loadURL never settles', async () => {
    const electron = fakeElectron();
    const OriginalView = electron.BrowserView;
    electron.BrowserView = class extends OriginalView {
        constructor(options) {
            super(options);
            this.webContents.loadURL = url => {
                setImmediate(() => { this.webContents.url = url; this.webContents.emit('dom-ready'); });
                return new Promise(() => {});
            };
        }
    };
    const { BrowserManager } = loadTree(path.resolve(__dirname, '../src'), electron)('main/BrowserManager.js');
    const manager = new BrowserManager({ workflow: 'youtube' });
    manager.preparationTimeoutMs = 30;
    manager.attachWindow(electron.window);
    await manager.createBrowser(1, { startPage: 'about:blank' });
    assert.equal(manager.get(1).view.webContents.getURL(), 'about:blank');
    await manager.destroyAll();
});

test('a stuck outgoing document is replaced in its existing session before cleanup can continue', async () => {
    const f = await fixture(), oldView = f.managed.view, clearing = deferred();
    f.wc.url = 'https://www.youtube.com/watch?v=abcdefghijk';
    f.wc.loadURL = () => new Promise(() => {});
    f.managed.pendingStorageCleanup = clearing.promise;
    await f.manager.releaseResearchDocument(f.managed, { timeoutMs: 10 });
    assert.notEqual(f.managed.view, oldView);
    assert.equal(f.wc.isDestroyed(), true);
    assert.equal(f.managed.view.webContents.getURL(), 'about:blank');
    assert.equal(f.managed.view.options.webPreferences.session, f.managed.session);
    assert.equal(f.managed.pendingStorageCleanup, clearing.promise);
    clearing.resolve();
    await f.manager.destroyAll();
});

test('cycle preparation clears history on the replacement view after releasing a failed native document', async () => {
    const f = await fixture(), OriginalView = f.electron.BrowserView;
    let historyClears = 0;
    f.wc.url = 'https://www.youtube.com/watch?v=abcdefghijk';
    f.wc.loadURL = () => Promise.reject(new Error('Native blank navigation could not start.'));
    f.wc.clearHistory = () => { if (f.wc.isDestroyed()) throw new Error('Object has been destroyed'); };
    f.electron.BrowserView = class extends OriginalView {
        constructor(options) { super(options); this.webContents.clearHistory = () => { historyClears++; }; }
    };
    await f.manager.prepareCycleDocument(1, new AbortController().signal);
    assert.equal(f.wc.isDestroyed(), true);
    assert.equal(historyClears, 1);
    assert.equal(f.managed.rendererCacheRequest, null);
    await f.manager.destroyAll();
});

test('YouTube navigation rejects proxy addresses and other videos across public and page paths', async () => {
    const f = await fixture(), videoUrl = 'https://www.youtube.com/watch?v=abcdefghijk';
    f.managed.playbackConfig = { videoUrl };
    for (const target of ['http://103.237.102.191:11111', 'https://www.google.com/search?q=test', 'https://www.youtube.com/watch?v=aaaaaaaaaaa']) {
        await assert.rejects(f.manager.navigate(1, target), /configured YouTube video/);
        let prevented = false;
        f.wc.emit('will-navigate', { preventDefault() { prevented = true; } }, target);
        assert.equal(prevented, true, target);
        f.wc.url = target;
        await assert.rejects(f.manager.reload(1), /configured YouTube video/);
        await assert.rejects(f.manager.restart(1), /configured YouTube video/);
    }
    for (const target of [videoUrl, 'https://consent.youtube.com/m', 'https://accounts.google.com/ServiceLogin', 'https://www.google.co.uk/sorry/index']) {
        let prevented = false;
        f.wc.emit('will-redirect', { preventDefault() { prevented = true; } }, target, false, true);
        assert.equal(prevented, false, target);
    }
    await f.manager.destroyAll();
});

test('a Google verification redirect stays a user-action state without legacy proxy failure', async () => {
    const f = await fixture();
    f.managed.state.proxy = { protocol: 'http', host: '103.237.102.191', port: 11111 };
    f.wc.url = 'https://www.google.com/sorry/index';
    f.wc.emit('did-navigate', {}, f.wc.url, 429);
    f.wc.emit('dom-ready');
    assert.notEqual(f.managed.state.connectionStatus, 'proxy-failed');
    assert.doesNotMatch(f.managed.state.errorMessage || '', /proxy will be replaced/);
    assert.equal(f.managed.proxyHealth.failed, false);
    await f.manager.destroyAll();
});

test('origin document errors remain distinct from confirmed proxy transport errors', async () => {
    const f = await fixture();
    f.managed.state.proxy = { protocol: 'http', host: '103.237.102.191', port: 11111 };
    f.wc.emit('did-fail-load', {}, -202, 'ERR_CERT_AUTHORITY_INVALID', 'https://www.youtube.com/watch?v=abcdefghijk', true);
    assert.equal(f.managed.state.connectionStatus, 'navigation-failed');
    assert.equal(f.managed.proxyHealth.failed, false);
    f.wc.emit('did-fail-load', {}, -130, 'ERR_PROXY_CONNECTION_FAILED', 'https://www.youtube.com/watch?v=abcdefghijk', true);
    assert.equal(f.managed.state.connectionStatus, 'proxy-failed');
    assert.equal(f.managed.proxyHealth.failed, true);
    await f.manager.destroyAll();
});

test('legacy search and Keep Alive entry points cannot execute in a YouTube workspace', async () => {
    const f = await fixture();
    await assert.rejects(f.manager.broadcastSearch(1, 'test', 'example.com'), /unavailable/);
    await assert.rejects(f.manager.clickControlledGoogleResult(1, 'test', 'example.com', 'https://example.com', 1), /unavailable/);
    assert.throws(() => f.manager.startControlledKeepAlive(1, 'example.com'), /unavailable/);
    f.manager.configureKeepAlive(1000, 10, true);
    assert.equal(f.manager.keepAliveTimer, null);
    await f.manager.destroyAll();
});

test('consent and login documents require an active configured playback before public navigation', async () => {
    const f = await fixture();
    for (const target of ['https://consent.youtube.com/m', 'https://accounts.google.com/ServiceLogin', 'https://www.google.com/sorry/index']) {
        await assert.rejects(f.manager.navigate(1, target), /configured YouTube video/);
    }
    await f.manager.destroyAll();
});

test('a renderer crash is reported as a browser failure without claiming the proxy transport failed', async () => {
    const f = await fixture();
    f.managed.state.proxy = { protocol: 'http', host: '103.237.102.191', port: 11111 };
    f.wc.emit('render-process-gone', {}, { reason: 'oom' });
    assert.equal(f.managed.state.connectionStatus, 'crashed');
    assert.equal(f.managed.proxyHealth.failed, false);
    await f.manager.destroyAll();
});

test('a synchronous playback callback cannot navigate after aborting its own run', async () => {
    const f = await fixture(), abort = new AbortController(), loads = [];
    await f.manager.assignProxy(1, { protocol: 'http', host: '103.237.102.191', port: 11111 });
    const original = f.wc.loadURL.bind(f.wc);
    f.wc.loadURL = url => { loads.push(url); return original(url); };
    await assert.rejects(f.manager.startYouTubePlayback(1, {
        videoUrl: 'https://youtu.be/abcdefghijk', muted: true, signal: abort.signal,
        onState() { abort.abort(); }
    }), { name: 'AbortError' });
    assert.equal(loads.includes('https://www.youtube.com/watch?v=abcdefghijk'), false);
    await f.manager.destroyAll();
});

test('state observers that Stop or remove the owner prevent later playback callbacks and navigation', async () => {
    for (const action of ['stop', 'remove']) {
        const f = await fixture(), loads = [];
        await f.manager.assignProxy(1, { protocol: 'http', host: '103.237.102.191', port: 11111 });
        const original = f.wc.loadURL.bind(f.wc);
        f.wc.loadURL = url => { loads.push(url); return original(url); };
        let callbacks = 0;
        const observer = state => {
            if (state.playback?.status !== 'loading') return;
            if (action === 'stop') void f.manager.stopYouTubePlayback(1);
            else f.manager.browsers.delete(1);
        };
        f.manager.on('stateChanged', observer);
        try {
            await assert.rejects(f.manager.startYouTubePlayback(1, {
                videoUrl: 'https://youtu.be/abcdefghijk', muted: true, onState() { callbacks++; }
            }), { name: 'AbortError' });
            assert.equal(callbacks, 0, action);
            assert.equal(loads.includes('https://www.youtube.com/watch?v=abcdefghijk'), false, action);
        } finally {
            f.manager.removeListener('stateChanged', observer);
            f.manager.browsers.set(1, f.managed);
            await f.manager.destroyAll();
        }
    }
});
