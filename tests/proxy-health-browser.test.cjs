'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTree, fakeElectron } = require('./helpers.cjs');
const url = 'https://www.youtube.com/watch?v=PRXYTtest01';
const proxy = port => ({ protocol: 'http', host: '103.237.102.191', port });
const tick = () => new Promise(setImmediate);
async function fixture() {
    const electron = fakeElectron();
    const { BrowserManager } = loadTree(path.resolve(__dirname, '../src'), electron)('main/BrowserManager.js');
    const manager = new BrowserManager({ workflow: 'youtube' });
    manager.attachWindow(electron.window);
    await manager.createBrowser(1, { startPage: 'about:blank' });
    await manager.assignProxy(1, proxy(11111));
    return { manager, managed: manager.get(1) };
}
test('a late HEAD cannot mark a replacement proxy healthy', async () => {
    const f = await fixture(); let finish;
    f.managed.session.fetch = () => new Promise(resolve => { finish = resolve; });
    const checking = f.manager.checkProxyHealth(1, url);
    const rejected = assert.rejects(checking, /cancelled/i);
    while (!finish) await tick();
    await f.manager.assignProxy(1, proxy(22222));
    finish({ status: 200 });
    await rejected;
    assert.equal(f.managed.state.proxy.port, 22222);
    assert.equal(f.managed.state.proxyHealthCheck, undefined);
    await f.manager.destroyAll();
});
test('Stop cancels transport probes and does not call a reachable proxy failed', async () => {
    const f = await fixture(); let signal;
    f.managed.session.fetch = (_url, options) => { signal = options.signal; return new Promise(() => {}); };
    const checking = f.manager.checkProxyHealth(1, url);
    const rejected = assert.rejects(checking, /cancelled/i);
    while (!signal) await tick();
    await f.manager.stopYouTubePlayback(1);
    await rejected;
    assert.equal(signal.aborted, true);
    assert.equal(f.manager.getProxyRotationState(1).failed, false);
    await f.manager.destroyAll();
});
test('HEAD429 is recorded as access requiring action without a failed-proxy claim', async () => {
    const f = await fixture();
    f.managed.session.fetch = async () => ({ status: 429 });
    const result = await f.manager.checkProxyHealth(1, url);
    assert.equal(result.status, 'interaction-required');
    assert.equal(f.managed.state.proxyHealthCheck.httpStatus, 429);
    assert.equal(f.manager.getProxyRotationState(1).failed, false);
    assert.notEqual(f.managed.state.connectionStatus, 'proxy-failed');
    await f.manager.destroyAll();
});
