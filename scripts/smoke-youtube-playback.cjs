'use strict';

// Exercise the shipped application and real Chromium media state. The only
// injected main-process behavior is local HTTPS fixtures and one pending native
// load promise; neither BrowserManager nor the playback controller is replaced.
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
const target = process.argv[2] ? path.resolve(process.argv[2]) : require('electron');
const sourceRun = !process.argv[2];
const VIDEO_ID = 'PRXYTtest01';
const VIDEO_IDS = [VIDEO_ID, 'PRXYTtest02'];
const VIDEO_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const inputUrl = `https://youtu.be/${VIDEO_ID}?si=native-fixture`;
const mediaBase64 = fs.readFileSync(path.join(root, 'tests/fixtures/youtube/playback.webm')).toString('base64');
const servers = [];
let app, page, phase = 'launch', stderr = '', providerRequests = 0, expectedCycleNumber = null;
const timings = [];
const tunnelFailures = [];
const startedAt = Date.now();
const soakSeconds = Number(process.env.PRX_YT_NATIVE_SOAK_SECONDS || 0);
assert.ok(Number.isInteger(soakSeconds) && soakSeconds >= 0 && soakSeconds <= 900,
    'PRX_YT_NATIVE_SOAK_SECONDS must be a whole number from 0 to 900');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'prx-yt-native-'));
const fullFleet = process.env.PRX_YT_NATIVE_FULL_FLEET === '1';
const report = { schema: 1, artifact: sourceRun ? 'source' : path.basename(target),
    platform: process.platform, startedAt: new Date().toISOString(), requestedSoakSeconds: soakSeconds,
    fullFleetRequested: fullFleet, scope: 'Local protocol fixtures; zero public YouTube requests; no live proxy transport',
    memoryMetric: 'Summed per-process working sets; shared pages can be counted more than once',
    phases: [], resources: [], stopChecks: [], checks: {}, passed: false };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function logPhase(next, details = {}) {
    phase = next;
    const event = { nativeSmokeStage: phase, elapsedMs: Date.now() - startedAt, ...details };
    report.phases.push(event);
    console.log(JSON.stringify(event));
}
async function sampleResources(label) {
    const value = await app.evaluate(({ app, webContents }) => {
        const metrics = app.getAppMetrics();
        return { processes: metrics.length, nativeContents: webContents.getAllWebContents().filter(wc => !wc.isDestroyed()).length,
            workingSetBytes: metrics.reduce((total, item) => total + (item.memory?.workingSetSize || 0) * 1024, 0),
            cpuPercent: metrics.reduce((total, item) => total + (item.cpu?.percentCPUUsage || 0), 0) };
    });
    const sample = { label, elapsedMs: Date.now() - startedAt, freeMemoryBytes: os.freemem(), ...value };
    report.resources.push(sample);
    assert.ok(sample.freeMemoryBytes > 768 * 1024 * 1024, 'Native validation stopped below 768 MiB free system memory');
    return sample;
}
async function assertHealthyCycle(expectedCycle = expectedCycleNumber) {
    const state = await page.evaluate(() => window.app.automation.getState());
    assert.equal(state.lastError, undefined, `Cycle ${state.cycleNumber} failed: ${state.lastError}`);
    assert.equal(state.running, true, 'Playback unexpectedly stopped during the fixture');
    if (expectedCycle != null) assert.equal(state.cycleNumber, expectedCycle,
        `Expected cycle ${expectedCycle}; a later cycle must not satisfy an earlier cycle's assertions`);
    return state;
}
async function waitForCycle(expected, timeoutMs = 30_000) {
    return waitForAutomation(page, state => {
        assert.equal(state.lastError, undefined, `Cycle ${state.cycleNumber} failed: ${state.lastError}`);
        assert.equal(state.running, true, 'Playback stopped while waiting for a cycle');
        assert.ok(state.cycleNumber <= expected, `Missed expected cycle ${expected}; observed ${state.cycleNumber}`);
        return state.cycleNumber === expected && !state.cycleInProgress;
    }, undefined, { timeoutMs });
}

async function serve(handler) {
    const server = http.createServer(handler);
    // No request is forwarded. An accidental external tunnel fails locally.
    server.on('connect', (request, socket) => {
        tunnelFailures.push({ proxyPort: server.address().port, target: request.url, at: Date.now() });
        socket.end('HTTP/1.1 502 Fixture has no upstream\r\nContent-Length: 0\r\n\r\n');
    });
    servers.push(server);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return server.address().port;
}

async function launch() {
    logPhase('launching native application', { artifact: sourceRun ? 'source' : path.basename(target) });
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
    await app.evaluate(({ session }, { mediaBase64, videoIds }) => {
        const clip = Buffer.from(mediaBase64, 'base64');
        globalThis.__prxYtFixture = { modes: {}, expectedCycle: 1, requests: [], documents: 0,
            documentRecords: [], unfinishedResponses: 0, rejectedRequests: [], pendingBlankPromises: 0, headStatuses: {}, handlers: {} };
        const fixture = globalThis.__prxYtFixture;
        for (let id = 1; id <= 100; id++) {
            const ses = session.fromPartition(`persist:browser-${id}`);
            const handler = request => {
                const url = new URL(request.url);
                if (url.hostname !== 'www.youtube.com') {
                    fixture.rejectedRequests.push(request.url);
                    return new Response('No upstream network in native fixture', { status: 502 });
                }
                fixture.requests.push({ browserId: id, url: request.url, method: request.method, at: Date.now() });
                if (request.method === 'HEAD') return new Response(null, { status: fixture.headStatuses[id] || 200 });
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
                if (url.pathname !== '/watch' || !videoIds.includes(url.searchParams.get('v'))) {
                    return new Response('Unexpected YouTube navigation', { status: 404 });
                }
                const mode = fixture.modes[id] || 'normal';
                const documentId = ++fixture.documents;
                const expectedCycle = fixture.expectedCycle;
                fixture.documentRecords.push({ browserId: id, documentId, videoId: url.searchParams.get('v'), mode, expectedCycle, at: Date.now() });
                if (mode === 'lightweight') return new Response('<!doctype html><title>Local native workspace</title><p>Isolated lightweight workspace</p>',
                    { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
                return new Response(`<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>PRX-YT native fixture</title>
                    <style>body{margin:0;background:#15181e;color:white;font:14px sans-serif}video{width:100%;height:160px}.ytp-error-content-wrap{padding:20px}</style></head>
                    <body><main id="movie_player"><video class="html5-main-video" controls preload="auto" src="/__prx_fixture__/playback.webm"></video></main>
                    <img src="/__prx_fixture__/unfinished.png" width="1" height="1" alt="">
                    <script>
                    window.fixture = { browserId: ${id}, documentId: ${documentId}, videoId: ${JSON.stringify(url.searchParams.get('v'))}, expectedCycle: ${expectedCycle}, mode: ${JSON.stringify(mode)},
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
                    window.fixture.showCaptcha = () => {
                        video.pause();
                        const form = document.createElement('form'); form.id = 'captcha-form';
                        form.textContent = 'Verification or CAPTCHA requires your action.';
                        document.body.appendChild(form);
                    };
                    if (window.fixture.mode === 'unavailable') window.fixture.showUnavailable();
                    if (window.fixture.mode === 'captcha') window.fixture.showCaptcha();
                    </script></body></html>`, {
                    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
                });
            };
            fixture.handlers[id] = handler;
            ses.protocol.handle('https', handler);
        }
    }, { mediaBase64, videoIds: VIDEO_IDS });
}

async function browserStates() { return page.evaluate(() => window.app.browser.getAll()); }
async function waitForBrowsers(predicate, label, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let states;
    do {
        if (expectedCycleNumber != null) await assertHealthyCycle();
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
                    documentId: window.fixture.documentId, videoId: window.fixture.videoId, expectedCycle: window.fixture.expectedCycle, mode: window.fixture.mode,
                    beforeStorage: window.fixture.beforeStorage,
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
    expectedCycleNumber = null;
    logPhase(`preparing ${count} browsers`);
    await app.evaluate(() => { if (globalThis.__prxYtFixture) globalThis.__prxYtFixture.expectedCycle = 1; });
    await page.getByLabel('Browsers', { exact: true }).fill(String(count));
    const start = Date.now();
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    const state = await waitForAutomation(page, (value, expected) => {
        assert.equal(value.lastError, undefined, `Fleet startup failed: ${value.lastError}`);
        return value.running && !value.preparingBrowsers && !value.cycleInProgress &&
            value.cycleNumber >= 1 && value.assignedBrowsers === expected;
    }, count, { timeoutMs: count === 100 ? 120_000 : 40_000 });
    assert.equal(state.lastError, undefined);
    assert.equal(state.cycleNumber, 1, 'Initial cycle did not settle before the next boundary');
    expectedCycleNumber = 1;
    assert.equal(state.preparedBrowsers, count);
    assert.equal((await browserStates()).length, count);
    const live = await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(wc => !wc.isDestroyed()).length);
    assert.equal(live, count + 1, 'Resizing leaked a native browser');
    timings.push({ browserCount: count, preparationMs: Date.now() - start });
    await sampleResources(`${count}-browser first cycle`);
    logPhase(`${count}-browser first cycle ready`, { cycleNumber: state.cycleNumber, assignedBrowsers: state.assignedBrowsers, providerRequests });
    return state;
}
async function stopFleet() {
    logPhase('stopping playback', { expectedCycleNumber });
    expectedCycleNumber = null;
    const stopAt = Date.now();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await waitForAutomation(page, state => !state.running && !state.preparingBrowsers);
    await page.getByRole('button', { name: 'Start', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Start')?.disabled);
    const ids = (await browserStates()).map(state => state.id);
    await withinDeadline((async () => {
        while (!(await mediaSnapshot(ids)).every(value => value.absent || (value.url === 'about:blank' && value.media === null))) await sleep(100);
    })(), 20_000, 'Stop must release every local media document');
    report.stopChecks.push({ browserCount: ids.length, elapsedMs: Date.now() - stopAt, allDocumentsReleased: true, activeMediaElements: 0 });
    timings.push({ operation: 'stop', elapsedMs: Date.now() - stopAt });
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
    logPhase('checking dashboard and validation');
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
        window.__prxCycles = [];
        window.app.automation.onStateChanged(state => {
            if (state.preparingBrowsers) window.__prxPreparation.push({ count: state.browserCount, ready: state.preparedBrowsers });
            window.__prxCycles.push({ at: Date.now(), running: state.running, cycleNumber: state.cycleNumber,
                cycleInProgress: state.cycleInProgress, preparingBrowsers: state.preparingBrowsers, lastError: state.lastError,
                lastCycleStartedAt: state.lastCycleStartedAt, nextCycleAt: state.nextCycleAt });
            if (window.__prxCycles.length > 300) window.__prxCycles.shift();
        });
    });
    const firstState = await startFleet(2);
    assert.equal(firstState.videoUrl, VIDEO_URL);
    logPhase('verifying real media playback', { cycleNumber: firstState.cycleNumber });
    await waitForBrowsers(states => states.length === 2 && states.every(state => state.playback?.status === 'playing' && state.playback.currentTime > 0), 'Actual media playback');
    const first = await mediaSnapshot();
    assert.ok(first.every(value => value.fixture.expectedCycle === firstState.cycleNumber && value.fixture.mode === 'normal'));
    assert.ok((await browserStates()).every(state => state.proxyHealthCheck?.httpStatus === 200 && state.proxyHealthCheck.status === 'reachable'),
        'Successful native HEAD transport checks were not recorded separately from real media');
    logPhase('initial media verified', { documents: first.map(value => value.fixture), positions: first.map(value => value.media.currentTime) });
    if (process.env.PRX_YT_SMOKE_SCREENSHOT) await page.screenshot({
        path: path.resolve(process.env.PRX_YT_SMOKE_SCREENSHOT.replace(/\.png$/, '-playing.png'))
    });
    assert.ok(first.every(value => value.media && value.media.currentTime > 0 && value.media.duration >= 6 && value.media.duration <= 8));
    assert.ok(first.every(value => value.media.muted && !value.media.paused && value.fixture.beforeStorage === null));
    assert.ok(first.some(value => value.loading), 'The fixture did not keep network loading unfinished during playback');
    assert.deepEqual(first.map(value => value.localStorage), ['1', '2'], 'Profiles share local storage');
    const routes = await app.evaluate(async ({ session }, url) => Promise.all([1, 2].map(id => session.fromPartition(`persist:browser-${id}`).resolveProxy(url))), VIDEO_URL);
    assert.ok(routes.every(route => /^PROXY 127\.0\.0\.1:\d+$/.test(route)), JSON.stringify(routes));
    assert.notEqual(routes[0], routes[1], 'Browser profiles share the same proxy assignment');

    logPhase('manual playback controls');
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
    logPhase('waiting for natural video ending');
    await waitForBrowsers(states => states.every(state => state.playback?.status === 'ended'), 'Natural video ending', 15_000);
    const ended = await mediaSnapshot();
    await sleep(1200);
    const stillEnded = await mediaSnapshot();
    assert.deepEqual(stillEnded.map(value => value.fixture.playCount), ended.map(value => value.fixture.playCount), 'Ended playback was automatically restarted');
    assert.ok(stillEnded.every(value => value.media.ended && value.media.paused));

    logPhase('manual cycle, cleanup and autoplay restrictions');
    const requestsBeforeCycle = providerRequests;
    const beforeManual = await assertHealthyCycle(1);
    const manualCycle = beforeManual.cycleNumber + 1;
    logPhase('Browser 2 pending about:blank promise regression');
    await app.evaluate(({ session, webContents }) => {
        const wc = webContents.getAllWebContents().find(value => value.session === session.fromPartition('persist:browser-2'));
        const nativeLoad = wc.loadURL.bind(wc);
        wc.loadURL = (url, ...args) => {
            const loading = nativeLoad(url, ...args);
            if (url !== 'about:blank') return loading;
            wc.loadURL = nativeLoad;
            globalThis.__prxYtFixture.pendingBlankPromises++;
            loading.catch(() => {});
            return new Promise(() => {});
        };
    });
    await app.evaluate((_electron, cycle) => {
        globalThis.__prxYtFixture.modes[2] = 'blocked';
        globalThis.__prxYtFixture.expectedCycle = cycle;
    }, manualCycle);
    await page.getByRole('button', { name: 'Run Now', exact: true }).click();
    const secondState = await waitForCycle(manualCycle);
    expectedCycleNumber = manualCycle;
    assert.equal(secondState.lastError, undefined, 'Manual cycle setup reported an error');
    assert.equal(secondState.cycleNumber, manualCycle);
    logPhase('manual cycle setup complete', { cycleNumber: secondState.cycleNumber, retainedBrowsers: secondState.retainedBrowsers });
    assert.equal(secondState.retainedBrowsers, 2);
    assert.equal(secondState.replacedBrowsers, 0);
    assert.equal(providerRequests, requestsBeforeCycle, 'An all-healthy cycle fetched the proxy provider again');
    await waitForBrowsers(states => states[0].playback?.status === 'playing' && states[1].playback?.status === 'autoplay-blocked', 'Blocked playback reporting');
    const second = await mediaSnapshot();
    await assertHealthyCycle(manualCycle);
    assert.ok(second.every(value => value.fixture.expectedCycle === manualCycle), 'Manual-cycle documents have an unexpected cycle marker');
    assert.deepEqual(second.map(value => value.fixture.mode), ['normal', 'blocked']);
    logPhase('manual cycle media verified', { cycleNumber: manualCycle, documents: second.map(value => value.fixture) });
    assert.ok(second.every(value => value.fixture.beforeStorage === null), 'Cycle cleanup retained outgoing page storage');
    assert.equal(await app.evaluate(() => globalThis.__prxYtFixture.pendingBlankPromises), 1,
        'The Browser 2 pending about:blank regression was not exercised');
    report.checks.pendingBlankCommit = true;
    assert.ok(second.every((value, index) => value.fixture.documentId !== first[index].fixture.documentId), 'Cycle reused its old document');
    assert.ok(second[0].media.currentTime < ended[0].media.currentTime, 'Cycle did not reset playback position');
    assert.equal(second[1].fixture.playCount, 1);
    await sleep(1200);
    await assertHealthyCycle(manualCycle);
    assert.equal((await mediaSnapshot([2]))[0].fixture.playCount, 1, 'Autoplay rejection caused an automatic retry loop');
    await app.evaluate(async ({ session, webContents }) => {
        const wc = webContents.getAllWebContents().find(value => value.session === session.fromPartition('persist:browser-2'));
        await wc.mainFrame.executeJavaScript('window.fixture.showUnavailable()', false);
    });
    await waitForBrowsers(states => states[1].playback?.status === 'unavailable', 'Unavailable video reporting');
    const beforeScheduled = await assertHealthyCycle(manualCycle);
    const scheduledCycle = beforeScheduled.cycleNumber + 1;
    const boundaryAt = Date.parse(beforeScheduled.nextCycleAt);
    assert.ok(Number.isFinite(boundaryAt), 'The running application did not publish its next cycle boundary');
    await app.evaluate((_electron, cycle) => {
        globalThis.__prxYtFixture.modes[2] = 'normal';
        globalThis.__prxYtFixture.expectedCycle = cycle;
    }, scheduledCycle);

    logPhase('waiting for the next scheduled cycle', { fromCycle: beforeScheduled.cycleNumber, expectedCycle: scheduledCycle,
        nextCycleAt: beforeScheduled.nextCycleAt, remainingMs: Math.max(0, boundaryAt - Date.now()) });
    const scheduled = await waitForCycle(scheduledCycle, Math.max(20_000, boundaryAt - Date.now() + 15_000));
    expectedCycleNumber = scheduledCycle;
    assert.equal(scheduled.lastError, undefined, 'Scheduled cycle setup reported an error');
    assert.equal(scheduled.cycleNumber, scheduledCycle);
    assert.ok(Date.parse(scheduled.lastCycleStartedAt) > Date.parse(beforeScheduled.lastCycleStartedAt), 'Scheduled cycle did not start a new cycle');
    logPhase('scheduled cycle setup complete', { cycleNumber: scheduled.cycleNumber, retainedBrowsers: scheduled.retainedBrowsers });
    assert.equal(scheduled.retainedBrowsers, 2);
    assert.equal(providerRequests, requestsBeforeCycle, 'Scheduled healthy retention fetched the provider');
    await waitForBrowsers(states => states.every(state => state.playback?.status === 'playing'), 'Playback after scheduled reset');
    const third = await mediaSnapshot();
    await assertHealthyCycle(scheduledCycle);
    assert.ok(third.every(value => value.fixture.expectedCycle === scheduledCycle && value.fixture.mode === 'normal'));
    assert.ok(third.every((value, index) => value.fixture.beforeStorage === null && value.fixture.documentId !== second[index].fixture.documentId));
    logPhase('scheduled cycle media verified', { cycleNumber: scheduledCycle, documents: third.map(value => value.fixture) });
    logPhase('CAPTCHA held without contradictory transport failure');
    await app.evaluate(async ({ session, webContents }) => {
        const wc = webContents.getAllWebContents().find(value => value.session === session.fromPartition('persist:browser-2'));
        await wc.mainFrame.executeJavaScript('window.fixture.showCaptcha()', false);
    });
    await waitForBrowsers(states => states[1].playback?.status === 'interaction-required', 'CAPTCHA diagnostic');
    const captchaCard = page.locator('.browser-card').filter({ has: page.getByText('Browser 2', { exact: true }) });
    assert.equal(await captchaCard.count(), 1, 'Browser 2 diagnostic card was not found');
    assert.equal(await captchaCard.getByText('Proxy failed', { exact: true }).count(), 0,
        'A reached CAPTCHA was mislabeled as a proxy transport failure');
    const heldDocument = (await mediaSnapshot([2]))[0].fixture.documentId;
    await app.evaluate((_electron, cycle) => { globalThis.__prxYtFixture.expectedCycle = cycle; }, scheduledCycle + 1);
    await waitForCycle(scheduledCycle + 1, 45_000);
    expectedCycleNumber = scheduledCycle + 1;
    assert.equal((await mediaSnapshot([2]))[0].fixture.documentId, heldDocument,
        'A scheduled cycle navigated a CAPTCHA that requires manual action');
    await app.evaluate(async ({ session, webContents }) => {
        const wc = webContents.getAllWebContents().find(value => value.session === session.fromPartition('persist:browser-2'));
        await wc.mainFrame.executeJavaScript('document.getElementById("captcha-form").remove()', false);
    });
    await app.evaluate((_electron, cycle) => { globalThis.__prxYtFixture.expectedCycle = cycle; }, scheduledCycle + 2);
    await page.getByRole('button', { name: 'Run Now', exact: true }).click();
    await waitForCycle(scheduledCycle + 2);
    expectedCycleNumber = scheduledCycle + 2;
    await waitForBrowsers(states => states.every(state => state.playback?.status === 'playing'), 'Manual retry after CAPTCHA');
    report.checks.captchaHeldUntilManualRetry = true;
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
    logPhase('cancelling 100-browser preparation');
    await page.getByLabel('Browsers', { exact: true }).fill('100');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.waitForFunction(() => window.__prxPreparation.some(value => value.count === 100 && value.ready > 20 && value.ready < 100));
    await page.getByRole('status').filter({ hasText: 'Preparing browsers:' }).waitFor();
    await stopFleet();
    await startFleet(20);
    await waitForBrowsers(states => states.length === 20 && states.every(state =>
        ['playing', 'ended'].includes(state.playback?.status) && state.playback.currentTime > 0), 'Playback after cancelled preparation');
    if (soakSeconds) {
        logPhase('bounded local media soak', { browserCount: 20, seconds: soakSeconds });
        await stopFleet();
        await page.getByLabel('Cycle interval (sec)', { exact: true }).fill('30');
        await startFleet(20);
        expectedCycleNumber = null;
        const soakAt = Date.now();
        let advancingMediaSamples = 0;
        while (Date.now() - soakAt < soakSeconds * 1000) {
            await assertHealthyCycle(null);
            const states = await browserStates();
            assert.equal(states.length, 20);
            assert.ok(states.every(state => !['error', 'playback-error', 'interaction-required'].includes(state.playback?.status)),
                'Local media soak encountered a failed workspace');
            advancingMediaSamples += states.filter(state => state.playback?.status === 'playing' && state.playback.currentTime > 0).length;
            await sampleResources('20-video soak');
            await sleep(Math.min(5000, Math.max(0, soakSeconds * 1000 - (Date.now() - soakAt))));
        }
        const soaked = await assertHealthyCycle(null);
        report.checks.soak = { seconds: (Date.now() - soakAt) / 1000, browserCount: 20, cyclesCompleted: soaked.cycleNumber,
            rendering: 'software', fixtureVideoSeconds: 7, scheduledCycleSeconds: 30, advancingMediaSamples };
        assert.ok(advancingMediaSamples >= 20, 'The bounded soak did not observe actual advancing media in the 20-video fleet');
    }
    await stopFleet();
    if (fullFleet) {
        assert.ok(os.freemem() > 3 * 1024 ** 3, 'Full native fleet requires at least 3 GiB free system memory');
        logPhase('full 100 native lightweight workspaces');
        await page.getByLabel('Cycle interval (sec)', { exact: true }).fill('600');
        await app.evaluate(() => { for (let id = 1; id <= 100; id++) globalThis.__prxYtFixture.modes[id] = 'lightweight'; });
        await startFleet(100);
        await sampleResources('100 native lightweight workspaces');
        await sleep(5000);
        await assertHealthyCycle(1);
        const preparedIds = (await browserStates()).map(state => state.id);
        assert.deepEqual(preparedIds, Array.from({ length: 100 }, (_, index) => index + 1));
        report.checks.fullNativeFleet = { browserCount: 100, preparedIds, idleHoldSeconds: 5, localMediaPlayback: false };
        await stopFleet();
        await app.evaluate(() => { globalThis.__prxYtFixture.modes = {}; });
        await startFleet(20);
        await waitForBrowsers(states => states.every(state => ['playing', 'ended'].includes(state.playback?.status)), '20-video recovery after 100 workspaces');
        await stopFleet();
    }
    logPhase('multiple pasted videos keep stable random workspace assignments');
    const multiUrls = VIDEO_IDS.map(id => `https://www.youtube.com/watch?v=${id}`);
    await input.fill(multiUrls.join('\n'));
    await startFleet(20);
    await waitForBrowsers(states => states.length === 20 && states.every(state =>
        ['playing', 'ended'].includes(state.playback?.status) && state.playback.currentTime > 0), 'Randomly distributed local media');
    const multiIds = Array.from({ length: 20 }, (_, index) => index + 1);
    const assigned = await mediaSnapshot(multiIds);
    assert.ok(assigned.every(value => multiUrls.includes(value.url)), 'A workspace navigated outside the pasted video set');
    await app.evaluate(() => { globalThis.__prxYtFixture.expectedCycle = 2; });
    await page.getByRole('button', { name: 'Run Now', exact: true }).click();
    await waitForCycle(2);
    expectedCycleNumber = 2;
    await waitForBrowsers(states => states.every(state => ['playing', 'ended'].includes(state.playback?.status) && state.playback.currentTime > 0),
        'Playback after multi-video cycle reset');
    const reassigned = await mediaSnapshot(multiIds);
    assert.deepEqual(reassigned.map(value => value.url), assigned.map(value => value.url), 'A cycle changed a workspace random video assignment');
    assert.ok(reassigned.every((value, index) => value.fixture.documentId !== assigned[index].fixture.documentId), 'A multi-video cycle reused an old document');
    report.checks.multipleVideos = { providedVideos: multiUrls, assignments: assigned.map(value => ({ browserId: value.browserId, videoId: value.fixture.videoId })), stableAfterCycle: true };
    await stopFleet();
    await input.fill(inputUrl);
    logPhase('real Chromium tunnel failure uses one unused local replacement');
    const tunnelsBefore = tunnelFailures.length;
    await app.evaluate(({ session }) => {
        const ses = session.fromPartition('persist:browser-1');
        const fixture = globalThis.__prxYtFixture;
        ses.protocol.unhandle('https');
        ses.webRequest.onErrorOccurred(details => {
            if (details.url !== 'https://www.youtube.com/watch?v=PRXYTtest01') return;
            fixture.nativeTunnelFailure = { error: details.error, url: details.url, at: Date.now() };
            ses.webRequest.onErrorOccurred(null);
            ses.protocol.handle('https', fixture.handlers[1]);
        });
    });
    await startFleet(1);
    await waitForBrowsers(states => states.length === 1 && states[0].playback?.status === 'playing' && states[0].playback.currentTime > 0,
        'Playback through the replacement routing configuration');
    const nativeFailure = await app.evaluate(() => globalThis.__prxYtFixture.nativeTunnelFailure);
    assert.match(nativeFailure?.error || '', /ERR_TUNNEL_|ERR_PROXY_|ERR_SOCKS_/,
        'The replacement fixture did not exercise a real Chromium proxy transport failure');
    const actualTunnels = tunnelFailures.slice(tunnelsBefore);
    assert.ok(actualTunnels.length > 0 && actualTunnels.every(value => value.proxyPort === actualTunnels[0].proxyPort && value.target === 'www.youtube.com:443'),
        'The native transport failure fixture used unexpected proxy routes or destinations');
    const replacementRoute = await app.evaluate(({ session }, url) => session.fromPartition('persist:browser-1').resolveProxy(url), VIDEO_URL);
    const failedRoute = `PROXY 127.0.0.1:${actualTunnels[0].proxyPort}`;
    assert.notEqual(replacementRoute, failedRoute, 'A failed native proxy was reused');
    assert.equal((await mediaSnapshot([1]))[0].url, VIDEO_URL, 'Proxy recovery changed the assigned video');
    report.checks.nativeProxyReplacement = { nativeError: nativeFailure.error, failedRoute, replacementRoute,
        videoUrl: VIDEO_URL, publicRequests: 0, proxyTunnelAttempts: actualTunnels.length, advancingLocalMedia: true };
    await stopFleet();
    logPhase('HTTP 403 and 429 transport restrictions remain distinct from playback');
    await app.evaluate(() => {
        globalThis.__prxYtFixture.headStatuses = { 1: 403, 2: 429 };
        globalThis.__prxYtFixture.modes = { 1: 'captcha', 2: 'captcha' };
    });
    await startFleet(20);
    const restricted = await waitForBrowsers(states => states.slice(0, 2).every(state => state.playback?.status === 'interaction-required'),
        'Native HTTP restriction diagnostics');
    const restrictedMedia = await mediaSnapshot([1, 2]);
    assert.deepEqual(restricted.slice(0, 2).map(state => state.proxyHealthCheck?.httpStatus), [403, 429]);
    assert.ok(restricted.slice(0, 2).every(state => state.proxyHealthCheck?.status === 'interaction-required' && state.connectionStatus !== 'proxy-failed'));
    assert.ok(restrictedMedia.every(value => value.fixture.playCount === 0 && value.media.paused), 'A CAPTCHA fixture received a playback attempt');
    report.checks.transportRestrictions = restricted.slice(0, 2).map((state, index) => ({ browserId: state.id,
        httpStatus: state.proxyHealthCheck.httpStatus, transportStatus: state.proxyHealthCheck.status,
        playbackStatus: state.playback.status, playAttempts: restrictedMedia[index].fixture.playCount }));
    await stopFleet();
    await app.evaluate(() => { globalThis.__prxYtFixture.headStatuses = {}; globalThis.__prxYtFixture.modes = {}; });
    const preparation = await page.evaluate(() => window.__prxPreparation);
    assert.ok(preparation.some(value => value.count === 20 && value.ready > 2 && value.ready < 20));
    const trace = await app.evaluate(() => globalThis.__prxYtFixture);
    assert.deepEqual(trace.rejectedRequests, []);
    assert.ok(trace.unfinishedResponses >= 2);
    assert.ok(trace.requests.every(request => new URL(request.url).hostname === 'www.youtube.com'));
    assert.ok(trace.requests.every(request => ['/watch', '/__prx_fixture__/playback.webm', '/__prx_fixture__/unfinished.png'].includes(new URL(request.url).pathname)));

    logPhase('settings persistence and graceful restart');
    await page.getByLabel('Cycle interval (sec)', { exact: true }).fill('600');
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
    report.passed = true;
    report.checks.smoke = true;
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
    report.error = { phase, message: error.message };
    console.error(`YouTube native smoke failed during ${phase}: ${error.stack || error}`);
    if (app) {
        if (page && process.env.PRX_YT_SMOKE_SCREENSHOT) {
            await page.screenshot({ path: path.resolve(process.env.PRX_YT_SMOKE_SCREENSHOT.replace(/\.png$/, '-failure.png')) }).catch(() => {});
        }
        const diagnostics = await Promise.allSettled([
            withinDeadline(browserStates(), 3000, 'Failure browser states'),
            withinDeadline(page.evaluate(async () => ({ automation: await window.app.automation.getState(), cycles: window.__prxCycles })), 3000, 'Failure automation state'),
            withinDeadline(app.evaluate(() => {
                const fixture = globalThis.__prxYtFixture;
                return fixture ? { modes: fixture.modes, expectedCycle: fixture.expectedCycle, documents: fixture.documents,
                    documentRecords: fixture.documentRecords.slice(-40), requests: fixture.requests.slice(-80),
                    rejectedRequests: fixture.rejectedRequests, unfinishedResponses: fixture.unfinishedResponses } : null;
            }), 3000, 'Failure fixture trace'),
            withinDeadline(mediaSnapshot(), 3000, 'Failure document snapshots')
        ]);
        console.error(JSON.stringify({ expectedCycleNumber, providerRequests,
            diagnostics: diagnostics.map((result, index) => ({ kind: ['browsers', 'automation', 'fixtures', 'documents'][index],
                ...(result.status === 'fulfilled' ? { value: result.value } : { error: result.reason?.message || String(result.reason) }) })) }, null, 2));
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
    report.elapsedMs = Date.now() - startedAt;
    report.timings = timings;
    if (process.env.PRX_YT_VALIDATION_REPORT) {
        const output = path.resolve(process.env.PRX_YT_VALIDATION_REPORT);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    }
});
