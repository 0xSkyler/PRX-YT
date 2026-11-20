'use strict';

// One explicitly selected public video, direct transport, one playback attempt.
// This is an availability diagnostic, never a public-proxy or engagement soak.
const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseYouTubeUrl } = require('../src/shared/youtube');
const { withinDeadline, waitForRenderer } = require('./benchmark-state.cjs');

async function run() {
    if (!process.env.PRX_YT_LIVE_URL) {
        console.log(JSON.stringify({ status: 'skipped', reason: 'Set PRX_YT_LIVE_URL to an explicitly selected public YouTube video.' }));
        return;
    }
    const video = parseYouTubeUrl(process.env.PRX_YT_LIVE_URL);
    const seconds = Number(process.env.PRX_YT_LIVE_SECONDS || 30);
    assert.ok(Number.isInteger(seconds) && seconds >= 5 && seconds <= 120,
        'PRX_YT_LIVE_SECONDS must be a whole number from 5 to 120');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'prx-yt-live-diagnostic-'));
    const root = path.resolve(__dirname, '..');
    const executable = process.argv[2] ? path.resolve(process.argv[2]) : require('electron');
    const report = { schema: 1, mode: 'single-video-direct-diagnostic', videoId: video.videoId,
        startedAt: new Date().toISOString(), requestedSeconds: seconds, navigationAttempts: 0,
        proxyProviderRequests: 0, publicProxyTests: 0, retries: 0, states: [], status: 'failed' };
    let application;
    try {
        application = await _electron.launch({ executablePath: executable,
            args: [`--user-data-dir=${profile}`, ...(process.argv[2] ? [] : [root])],
            env: { ...process.env, NODE_ENV: 'production' }, timeout: 45_000 });
        await waitForRenderer(application);
        const transport = await application.evaluate(async ({ session, webContents }, { videoUrl, youtubeSource, controllerSource }) => {
            const ses = session.fromPartition('persist:browser-1');
            await ses.setProxy({ mode: 'direct' });
            const routing = await ses.resolveProxy(videoUrl);
            if (routing !== 'DIRECT') throw new Error('Single-video diagnostic requires direct transport');
            const wc = webContents.getAllWebContents().find(value => value.session === ses);
            if (!wc) throw new Error('The isolated research workspace was not created');
            // Playwright's main-process context has no CommonJS require. Load
            // the unchanged production modules with their one local import.
            const youtube = { exports: {} }, controller = { exports: {} };
            new Function('module', 'exports', youtubeSource)(youtube, youtube.exports);
            new Function('require', 'module', 'exports', controllerSource)(specifier => {
                if (specifier !== '../shared/youtube') throw new Error('Unexpected diagnostic module import');
                return youtube.exports;
            }, controller, controller.exports);
            const { YouTubePlaybackController } = controller.exports;
            const abort = new AbortController();
            const timer = setTimeout(() => abort.abort(), 10_000);
            let head;
            try {
                const response = await ses.fetch(videoUrl, { method: 'HEAD', credentials: 'omit', signal: abort.signal });
                head = { status: response.status, successful: response.ok };
                await response.body?.cancel();
            } catch (error) { head = { error: error.message }; }
            finally { clearTimeout(timer); }
            globalThis.__prxLiveDiagnostic = { wc, states: [], loadingError: null, mainFrameResponses: [] };
            const trace = globalThis.__prxLiveDiagnostic;
            ses.webRequest.onCompleted((details) => {
                if (details.resourceType !== 'mainFrame') return;
                const url = new URL(details.url);
                trace.mainFrameResponses.push({ origin: url.origin, pathname: url.pathname, status: details.statusCode });
            });
            trace.controller = new YouTubePlaybackController(wc, { url: videoUrl, muted: true,
                onState: state => { trace.states.push(state); if (trace.states.length > 240) trace.states.shift(); } });
            wc.setAudioMuted(true);
            trace.controller.start();
            void wc.loadURL(videoUrl).catch(error => { trace.loadingError = error.message; });
            return { routing, head };
        }, { videoUrl: video.url, youtubeSource: fs.readFileSync(path.join(root, 'src/shared/youtube.js'), 'utf8'),
            controllerSource: fs.readFileSync(path.join(root, 'src/main/YouTubePlaybackController.js'), 'utf8') });
        assert.equal(transport.routing, 'DIRECT');
        Object.assign(report, transport);
        report.navigationAttempts = 1;
        const start = Date.now();
        while (Date.now() - start < seconds * 1000) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const snapshot = await withinDeadline(application.evaluate(() => {
                const trace = globalThis.__prxLiveDiagnostic;
                const state = trace.controller.getState();
                const safeUrl = value => { try { const url = new URL(value); return url.origin + url.pathname; } catch { return ''; } };
                return { ...state, documentUrl: safeUrl(state.documentUrl), videoUrl: safeUrl(state.videoUrl),
                    nativeLoadError: trace.loadingError, at: Date.now() };
            }), 5000, 'Live diagnostic state');
            report.states.push(snapshot);
            if (['interaction-required', 'autoplay-blocked', 'unavailable', 'playback-error', 'ended'].includes(snapshot.status)) break;
        }
        const last = report.states.at(-1);
        const progressed = report.states.some((state, index) => index > 0 && state.status === 'playing' &&
            state.currentTime > (report.states[index - 1].currentTime || 0) + 0.2 && state.contentKind !== 'advertisement');
        report.status = progressed ? 'playback-observed' : last?.status || 'no-observation';
        report.playbackProgressObserved = progressed;
        report.observedSeconds = (Date.now() - start) / 1000;
        report.scope = 'One direct video in a fresh profile; restrictions are reported and never bypassed; no sustained playback claim.';
        report.final = await application.evaluate(async () => {
            const trace = globalThis.__prxLiveDiagnostic;
            const media = await trace.wc.mainFrame.executeJavaScript(`(() => {
                const media = document.querySelector('video');
                return media ? { currentTime: media.currentTime, duration: Number.isFinite(media.duration) ? media.duration : null,
                    paused: media.paused, ended: media.ended, readyState: media.readyState, errorCode: media.error?.code || null } : null;
            })()`, false);
            const url = new URL(trace.wc.getURL());
            return { currentUrl: url.origin + url.pathname, mainFrameResponses: trace.mainFrameResponses, media };
        });
        if (process.env.PRX_YT_LIVE_SCREENSHOT) {
            const screenshot = path.resolve(process.env.PRX_YT_LIVE_SCREENSHOT);
            fs.mkdirSync(path.dirname(screenshot), { recursive: true });
            const png = await application.evaluate(async () => {
                const image = await globalThis.__prxLiveDiagnostic.wc.capturePage();
                return image.toPNG().toString('base64');
            });
            fs.writeFileSync(screenshot, Buffer.from(png, 'base64'));
            report.screenshot = screenshot;
        }
        await application.evaluate(async () => {
            const trace = globalThis.__prxLiveDiagnostic;
            await trace.controller.stop();
            trace.wc.stop();
            void trace.wc.loadURL('about:blank').catch(() => {});
        });
    } catch (error) {
        report.error = error.message;
        process.exitCode = 1;
    } finally {
        if (application) await withinDeadline(application.close(), 15_000, 'Live diagnostic shutdown').catch(() => application.process().kill());
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        if (process.env.PRX_YT_VALIDATION_REPORT) {
            const output = path.resolve(process.env.PRX_YT_VALIDATION_REPORT);
            fs.mkdirSync(path.dirname(output), { recursive: true });
            fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
        }
        console.log(JSON.stringify(report, null, 2));
    }
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });
