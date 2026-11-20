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

test('failed blank navigation blocks cleanup and can be retried safely', async () => {
    const f = await fixture();
    f.wc.url = 'https://www.youtube.com/watch?v=abcdefghijk';
    const original = f.wc.loadURL.bind(f.wc);
    f.wc.loadURL = () => Promise.reject(new Error('ERR_FAILED (-2)'));
    await assert.rejects(f.manager.releaseResearchDocument(f.managed, { timeoutMs: 10 }), /could not release/);
    assert.notEqual(f.wc.getURL(), 'about:blank');
    f.wc.loadURL = original;
    await f.manager.releaseResearchDocument(f.managed, { timeoutMs: 200 });
    assert.equal(f.wc.getURL(), 'about:blank');
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
