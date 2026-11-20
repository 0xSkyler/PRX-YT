'use strict';

// Exercise the shipped application and real Chromium media state. The only
// injected main-process behavior is an HTTPS fixture on each research session;
// neither BrowserManager nor the playback controller is replaced or patched.
// Protocol handling bypasses external transport: resolveProxy assertions verify
// native routing configuration, not the quality of live public proxies.
const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { withinDeadline, waitForAutomation, waitForRenderer } = require('./benchmark-state.cjs');

const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'prx-yt-native-'));
const target = process.argv[2] ? path.resolve(process.argv[2]) : require('electron');
const sourceRun = !process.argv[2];
const VIDEO_ID = 'PRXYTtest01';
const VIDEO_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const inputUrl = `https://youtu.be/${VIDEO_ID}?si=native-fixture`;
const mediaBase64 = fs.readFileSync(path.join(root, 'tests/fixtures/youtube/playback.webm')).toString('base64');
const servers = [];
let app, page, phase = 'launch', stderr = '', providerRequests = 0;
const timings = [];
const startedAt = Date.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function serve(handler) {
    const server = http.createServer(handler);
    // No request is forwarded. An accidental external tunnel fails locally.
    server.on('connect', (_request, socket) => socket.end('HTTP/1.1 502 Fixture has no upstream\r\nContent-Length: 0\r\n\r\n'));
    servers.push(server);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return server.address().port;
}

async function launch() {
    const linuxTestSandbox = process.platform === 'linux' && process.env.PRX_YT_TEST_SANDBOX !== '1';
    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
        throw new Error('The native BrowserView fixture requires a graphical session or Xvfb. Run on a native Windows runner or use xvfb-run on Linux.');
    }
    app = await _electron.launch({
        executablePath: target,
        chromiumSandbox: !linuxTestSandbox,
        args: [
            ...(linuxTestSandbox ? ['--no-sandbox'] : []),
            '--disable-gpu', `--user-data-dir=${profile}`, ...(sourceRun ? [root] : [])
        ],
        env: { ...process.env, NODE_ENV: 'production', APPIMAGE_EXTRACT_AND_RUN: '1' },
        timeout: 45_000
    });
    app.process().stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16_000); });
    page = await waitForRenderer(app);
    page.setDefaultTimeout(15_000);
    await page.getByRole('heading', { name: 'PRX-YT', exact: true }).waitFor();
    assert.equal(await app.evaluate(({ app }) => app.commandLine.hasSwitch('autoplay-policy')), false,
        'The native fixture must not bypass Chromium autoplay policy');
}

async function installResearchFixtures() {
    await app.evaluate(({ session }, { mediaBase64, videoId }) => {
        const clip = Buffer.from(mediaBase64, 'base64');
        globalThis.__prxYtFixture = { modes: {}, requests: [], documents: 0, unfinishedResponses: 0, rejectedRequests: [] };
        const fixture = globalThis.__prxYtFixture;
        for (let id = 1; id <= 100; id++) {
            const ses = session.fromPartition(`persist:browser-${id}`);
            ses.protocol.handle('https', request => {
                const url = new URL(request.url);
                if (url.hostname !== 'www.youtube.com') {
                    fixture.rejectedRequests.push(request.url);
                    return new Response('No upstream network in native fixture', { status: 502 });
                }
                fixture.requests.push({ browserId: id, url: request.url, at: Date.now() });
                if (url.pathname === '/__prx_fixture__/unfinished.png') {
                    fixture.unfinishedResponses++;
                    // A valid PNG prefix with no end deliberately keeps page
                    // loading unfinished while actual media plays normally.
                    return new Response(new ReadableStream({ start(controller) {
                        controller.enqueue(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
                    } }), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
                }
                if (url.pathname === '/__prx_fixture__/playback.webm') {
                    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('range') || '');
                    const first = range ? Number(range[1]) : 0;
                    const last = range && range[2] ? Math.min(Number(range[2]), clip.length - 1) : clip.length - 1;
                    if (first >= clip.length || first > last) return new Response(null, {
                        status: 416, headers: { 'Content-Range': `bytes */${clip.length}` }
                    });
                    const body = clip.subarray(first, last + 1);
                    return new Response(body, {
                        status: range ? 206 : 200,
                        headers: { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes',
                            'Content-Length': String(body.length), 'Cache-Control': 'no-store',
                            ...(range ? { 'Content-Range': `bytes ${first}-${last}/${clip.length}` } : {}) }
                    });
                }
                if (url.pathname !== '/watch' || url.searchParams.get('v') !== videoId) {
                    return new Response('Unexpected YouTube navigation', { status: 404 });
                }
                const mode = fixture.modes[id] || 'normal';
                const documentId = ++fixture.documents;
                return new Response(`<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>PRX-YT native fixture</title>
                    <style>body{margin:0;background:#15181e;color:white;font:14px sans-serif}video{width:100%;height:160px}.ytp-error-content-wrap{padding:20px}</style></head>
                    <body><main id="movie_player"><video class="html5-main-video" controls preload="auto" src="/__prx_fixture__/playback.webm"></video></main>
                    <img src="/__prx_fixture__/unfinished.png" width="1" height="1" alt="">
                    <script>
                    window.fixture = { browserId: ${id}, documentId: ${documentId}, mode: ${JSON.stringify(mode)},
                        beforeStorage: localStorage.getItem('prx-fixture-session'), playCount: 0, endedCount: 0 };
                    localStorage.setItem('prx-fixture-session', String(${id}));
                    const video = document.querySelector('video');
                    const nativePlay = video.play.bind(video);
                    video.play = function() {
                        window.fixture.playCount++;
                        if (window.fixture.mode === 'blocked') return Promise.reject(new DOMException('Fixture requires a user action.', 'NotAllowedError'));
                        return nativePlay();
                    };
                    video.addEventListener('ended', () => window.fixture.endedCount++);
                    window.fixture.showUnavailable = () => {
                        video.pause();
                        const error = document.createElement('div');
                        error.className = 'ytp-error-content-wrap';
                        error.textContent = 'This video is unavailable.';
                        document.getElementById('movie_player').appendChild(error);
                    };
                    if (window.fixture.mode === 'unavailable') window.fixture.showUnavailable();
                    </script></body></html>`, {
                    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
                });
            });
        }
    }, { mediaBase64, videoId: VIDEO_ID });
}

async function browserStates() { return page.evaluate(() => window.app.browser.getAll()); }
async function waitForBrowsers(predicate, label, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let states;
    do {
        states = await withinDeadline(browserStates(), Math.max(1, deadline - Date.now()), 'Browser states');
        if (predicate(states)) return states;
        await sleep(80);
    } while (Date.now() < deadline);
    throw new Error(`${label} did not settle: ${JSON.stringify(states)}`);
}
async function mediaSnapshot(ids = [1, 2]) {
    return app.evaluate(async ({ session, webContents }, ids) => {
        const values = [];
        for (const id of ids) {
            const wc = webContents.getAllWebContents().find(wc => !wc.isDestroyed() && wc.session === session.fromPartition(`persist:browser-${id}`));
            if (!wc) { values.push({ browserId: id, absent: true }); continue; }
            const value = await wc.mainFrame.executeJavaScript(`(() => {
                const video = document.querySelector('video');
                return { browserId: ${id}, url: location.href, fixture: window.fixture ? { browserId: window.fixture.browserId,
                    documentId: window.fixture.documentId, beforeStorage: window.fixture.beforeStorage,
                    playCount: window.fixture.playCount, endedCount: window.fixture.endedCount } : null,
                    localStorage: location.protocol === 'https:' ? localStorage.getItem('prx-fixture-session') : null,
                    media: video ? { currentTime: video.currentTime, duration: video.duration, ended: video.ended,
                        paused: video.paused, muted: video.muted, readyState: video.readyState } : null };
            })()`, false);
            values.push({ ...value, loading: wc.isLoading() });
        }
        return values;
    }, ids);
}

async function startFleet(count) {
    phase = `preparing ${count} browsers`;
    await page.getByLabel('Browsers', { exact: true }).fill(String(count));
    const start = Date.now();
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    const state = await waitForAutomation(page, (value, expected) => value.running && !value.preparingBrowsers &&
        !value.cycleInProgress && value.cycleNumber >= 1 && value.assignedBrowsers === expected, count, { timeoutMs: 40_000 });
    assert.equal(state.lastError, undefined);
    assert.equal(state.preparedBrowsers, count);
    assert.equal((await browserStates()).length, count);
    const live = await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(wc => !wc.isDestroyed()).length);
    assert.equal(live, count + 1, 'Resizing leaked a native browser');
    timings.push({ browserCount: count, preparationMs: Date.now() - start });
    return state;
}
async function stopFleet() {
    phase = 'stopping playback';
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await waitForAutomation(page, state => !state.running && !state.preparingBrowsers);
    await page.getByRole('button', { name: 'Start', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Start')?.disabled);
}

async function run() {
    const proxies = [];
    for (let id = 1; id <= 100; id++) {
        proxies.push({ protocol: 'http', ip: '127.0.0.1', port: await serve((_request, response) => {
            response.writeHead(502); response.end('Fixture proxy has no upstream');
        }), country_code: 'US', country: 'United States' });
    }
    const providerPort = await serve((_request, response) => {
        providerRequests++;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(proxies));
    });
    const endpoint = `http://127.0.0.1:${providerPort}/proxies`;
    await launch();
    await installResearchFixtures();
    phase = 'checking dashboard and validation';
    await page.waitForFunction(() => document.querySelectorAll('.browser-card').length === 10);
    for (const name of ['Keywords', 'Target website', 'Search engine']) assert.equal(await page.getByLabel(name, { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: /Keep Alive/i }).count(), 0);
    const tier = page.getByLabel('Proxy country tier', { exact: true });
    assert.deepEqual(await tier.locator('option').evaluateAll(options => options.map(option => option.value)), ['tier1', 'tier2', 'tier3', 'all']);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByText('Enter a YouTube video URL.', { exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.app.automation.getState())).running, false);
    const input = page.getByLabel('YouTube Video URL', { exact: true });
    await input.fill(`https://example.com/watch?v=${VIDEO_ID}`);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByText(/Only youtube\.com and youtu\.be video links are supported\./).waitFor();
    assert.equal(providerRequests, 0, 'An invalid video must not start proxy fetching');

    await input.fill(inputUrl);
    await page.getByLabel('Proxy source', { exact: true }).selectOption('all-working');
    await page.getByLabel('Proxy API URL (editable)', { exact: true }).fill(endpoint);
    await tier.selectOption('all');
    await page.getByLabel('Cycle interval (sec)', { exact: true }).fill('30');
    await page.getByLabel('Muted playback', { exact: true }).check();
    await page.evaluate(() => {
        window.__prxPreparation = [];
        window.app.automation.onStateChanged(state => {
            if (state.preparingBrowsers) window.__prxPreparation.push({ count: state.browserCount, ready: state.preparedBrowsers });
        });
    });
    const firstState = await startFleet(2);
    assert.equal(firstState.videoUrl, VIDEO_URL);
    phase = 'verifying real media playback';
    await waitForBrowsers(states => states.length === 2 && states.every(state => state.playback?.status === 'playing' && state.playback.currentTime > 0), 'Actual media playback');
    const first = await mediaSnapshot();
    assert.ok(first.every(value => value.media && value.media.currentTime > 0 && value.media.duration >= 6 && value.media.duration <= 8));
    assert.ok(first.every(value => value.media.muted && !value.media.paused && value.fixture.beforeStorage === null));
    assert.ok(first.some(value => value.loading), 'The fixture did not keep network loading unfinished during playback');
    assert.deepEqual(first.map(value => value.localStorage), ['1', '2'], 'Profiles share local storage');
    const routes = await app.evaluate(async ({ session }, url) => Promise.all([1, 2].map(id => session.fromPartition(`persist:browser-${id}`).resolveProxy(url))), VIDEO_URL);
    assert.ok(routes.every(route => /^PROXY 127\.0\.0\.1:\d+$/.test(route)), JSON.stringify(routes));
    assert.notEqual(routes[0], routes[1], 'Browser profiles share the same proxy assignment');

    await page.getByRole('button', { name: 'Pause Browser 1', exact: true }).click();
    await waitForBrowsers(states => states[0].playback?.status === 'paused', 'Manual pause');
    const paused = (await mediaSnapshot([1]))[0].media.currentTime;
    await sleep(350);
    assert.ok(Math.abs((await mediaSnapshot([1]))[0].media.currentTime - paused) < 0.05, 'Paused media time still advanced');
    await page.getByRole('button', { name: 'Unmute Browser 1', exact: true }).click();
    await waitForBrowsers(states => states[0].playback?.muted === false, 'Manual unmute');
    await page.getByRole('button', { name: 'Mute Browser 1', exact: true }).click();
    await waitForBrowsers(states => states[0].playback?.muted === true, 'Manual mute');
    await page.getByRole('button', { name: 'Play Browser 1', exact: true }).click();
    await waitForBrowsers(states => states[0].playback?.status === 'playing', 'Manual play');
    await waitForBrowsers(states => states.every(state => state.playback?.status === 'ended'), 'Natural video ending', 15_000);
    const ended = await mediaSnapshot();
    await sleep(1200);
    const stillEnded = await mediaSnapshot();
    assert.deepEqual(stillEnded.map(value => value.fixture.playCount), ended.map(value => value.fixture.playCount), 'Ended playback was automatically restarted');
    assert.ok(stillEnded.every(value => value.media.ended && value.media.paused));

    phase = 'manual cycle, cleanup and autoplay restrictions';
    const requestsBeforeCycle = providerRequests;
    await app.evaluate(() => { globalThis.__prxYtFixture.modes[2] = 'blocked'; });
    await page.getByRole('button', { name: 'Run Now', exact: true }).click();
    const secondState = await waitForAutomation(page, state => state.cycleNumber === 2 && !state.cycleInProgress);
    assert.equal(secondState.retainedBrowsers, 2);
    assert.equal(secondState.replacedBrowsers, 0);
    assert.equal(providerRequests, requestsBeforeCycle, 'An all-healthy cycle fetched the proxy provider again');
    await waitForBrowsers(states => states[0].playback?.status === 'playing' && states[1].playback?.status === 'autoplay-blocked', 'Blocked playback reporting');
    const second = await mediaSnapshot();
    assert.ok(second.every(value => value.fixture.beforeStorage === null), 'Cycle cleanup retained outgoing page storage');
    assert.ok(second.every((value, index) => value.fixture.documentId !== first[index].fixture.documentId), 'Cycle reused its old document');
    assert.ok(second[0].media.currentTime < ended[0].media.currentTime, 'Cycle did not reset playback position');
    assert.equal(second[1].fixture.playCount, 1);
    await sleep(1200);
    assert.equal((await mediaSnapshot([2]))[0].fixture.playCount, 1, 'Autoplay rejection caused an automatic retry loop');
    await app.evaluate(async ({ session, webContents }) => {
        const wc = webContents.getAllWebContents().find(value => value.session === session.fromPartition('persist:browser-2'));
        await wc.mainFrame.executeJavaScript('window.fixture.showUnavailable()', false);
    });
    await waitForBrowsers(states => states[1].playback?.status === 'unavailable', 'Unavailable video reporting');
    await app.evaluate(() => { globalThis.__prxYtFixture.modes[2] = 'normal'; });

    phase = 'scheduled cycle';
    const scheduled = await waitForAutomation(page, state => state.cycleNumber >= 3 && !state.cycleInProgress, undefined, { timeoutMs: 35_000 });
    assert.equal(scheduled.retainedBrowsers, 2);
    assert.equal(providerRequests, requestsBeforeCycle, 'Scheduled healthy retention fetched the provider');
    await waitForBrowsers(states => states.every(state => state.playback?.status === 'playing'), 'Playback after scheduled reset');
    const third = await mediaSnapshot();
    assert.ok(third.every((value, index) => value.fixture.beforeStorage === null && value.fixture.documentId !== second[index].fixture.documentId));
    await stopFleet();
    await waitForBrowsers(states => states.every(state => state.playback?.status === 'stopped'), 'Stop diagnostics');
    await withinDeadline((async () => {
        while (!(await mediaSnapshot()).every(value => value.url === 'about:blank' && value.media === null)) await sleep(50);
    })(), 10_000, 'Stopped browser document release');

    // Resizing keeps the native browser pool exact, including repeated growth
    // and cancellation partway through the supported 100-workspace maximum.
    await page.getByLabel('Cycle interval (sec)', { exact: true }).fill('600');
    for (const count of [20, 1, 20]) {
        await startFleet(count);
        await waitForBrowsers(states => states.length === count && states.every(state =>
            ['playing', 'ended'].includes(state.playback?.status) && state.playback.currentTime > 0), `${count}-browser media playback`);
        await stopFleet();
    }
    phase = 'cancelling 100-browser preparation';
    await page.getByLabel('Browsers', { exact: true }).fill('100');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.waitForFunction(() => window.__prxPreparation.some(value => value.count === 100 && value.ready > 20 && value.ready < 100));
    await page.getByRole('status').filter({ hasText: 'Preparing browsers:' }).waitFor();
    await stopFleet();
    await startFleet(20);
    await waitForBrowsers(states => states.length === 20 && states.every(state =>
        ['playing', 'ended'].includes(state.playback?.status) && state.playback.currentTime > 0), 'Playback after cancelled preparation');
    await stopFleet();
    const preparation = await page.evaluate(() => window.__prxPreparation);
    assert.ok(preparation.some(value => value.count === 20 && value.ready > 2 && value.ready < 20));
    const trace = await app.evaluate(() => globalThis.__prxYtFixture);
    assert.deepEqual(trace.rejectedRequests, []);
    assert.ok(trace.unfinishedResponses >= 2);
    assert.ok(trace.requests.every(request => new URL(request.url).hostname === 'www.youtube.com'));
    assert.ok(trace.requests.every(request => ['/watch', '/__prx_fixture__/playback.webm', '/__prx_fixture__/unfinished.png'].includes(new URL(request.url).pathname)));

    phase = 'settings persistence and graceful restart';
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('prx-yt.settings.v1'))?.browserCount === 20);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('prx-yt.settings.v1')));
    assert.equal(saved.videoUrl, inputUrl);
    assert.equal(saved.proxyApiUrl, endpoint);
    assert.equal(saved.proxyTier, 'all');
    assert.equal(saved.muted, true);
    await app.close(); app = null;
    await launch();
    assert.equal(await page.getByLabel('YouTube Video URL', { exact: true }).inputValue(), inputUrl);
    assert.equal(await page.getByLabel('Browsers', { exact: true }).inputValue(), '20');
    assert.equal(await page.getByLabel('Cycle interval (sec)', { exact: true }).inputValue(), '600');
    assert.equal(await page.getByLabel('Proxy API URL (editable)', { exact: true }).inputValue(), endpoint);
    assert.equal(await page.getByLabel('Proxy country tier', { exact: true }).inputValue(), 'all');
    assert.equal(await page.getByLabel('Muted playback', { exact: true }).isChecked(), true);
    assert.equal((await page.evaluate(() => window.app.automation.getState())).running, false);
    if (process.env.PRX_YT_SMOKE_SCREENSHOT) await page.screenshot({ path: path.resolve(process.env.PRX_YT_SMOKE_SCREENSHOT) });
    await app.close(); app = null;
    console.log(JSON.stringify({
        artifact: sourceRun ? 'source' : path.basename(target), realHtml5Video: true,
        playbackProgress: true, playbackBeforeFullPageLoad: true, naturalEndingWithoutReplay: true, manualControls: true,
        autoplayRejection: true, unavailableVideo: true, manualCycle: true, scheduledCycle: true,
        isolatedProfiles: true, cycleStorageCleanup: true, proxyRoutingConfiguration: true,
        healthyProxyRetention: true, providerApiSkipped: true, browserGrowth: true,
        preparationCancellation: true, restartAfterCancellation: true, settingsPersistence: true,
        publicYouTubeRequests: 0, fixtureScope: 'Local protocol-served media; no live proxy transport verification',
        providerRequests, timings, elapsedMs: Date.now() - startedAt
    }, null, 2));
}

run().catch(async error => {
    console.error(`YouTube native smoke failed during ${phase}: ${error.stack || error}`);
    if (app) {
        try { console.error(JSON.stringify(await withinDeadline(browserStates(), 3000, 'Failure state'), null, 2)); }
        catch { /* The renderer may already have exited. */ }
    }
    console.error(stderr);
    process.exitCode = 1;
}).finally(async () => {
    if (app) await withinDeadline(app.close(), 15_000, 'Native app close').catch(() => app.process().kill());
    for (const server of servers) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
