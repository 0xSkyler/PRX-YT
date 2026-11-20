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
    assert.equal(navigations, 2);
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
