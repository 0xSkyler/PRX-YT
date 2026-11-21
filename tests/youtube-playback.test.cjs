'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const {
    YouTubePlaybackController, classifyPlaybackSample,
    buildYouTubeProbeScript, buildStopYouTubePlaybackScript, buildYouTubeCommandScript
} = require('../src/main/YouTubePlaybackController');
const id = 'dQw4w9WgXcQ';
const url = `https://www.youtube.com/watch?v=${id}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const microtasks = async () => { await Promise.resolve(); await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

class Target extends EventEmitter {
    addEventListener(name, listener, options) { if (options?.once) this.once(name, listener); else this.on(name, listener); }
    removeEventListener(name, listener) { this.removeListener(name, listener); }
}

class Media extends Target {
    tagName = 'VIDEO';
    currentTime = 0;
    duration = 120;
    readyState = 4;
    networkState = 1;
    paused = true;
    ended = false;
    muted = false;
    seeking = false;
    loop = true;
    error = null;
    playCount = 0;
    pauseCount = 0;
    play() {
        this.playCount++;
        if (this.playImpl) return this.playImpl();
        this.paused = false;
        this.emit('play');
        return Promise.resolve();
    }
    pause() { this.pauseCount++; this.paused = true; }
}

function fixture() {
    const video = new Media(), window = new Target();
    const f = { video, window, location: { href: url }, ad: false, playerError: '', consent: false, captcha: false, hasVideo: true };
    const node = message => ({ innerText: message, style: {}, getBoundingClientRect: () => ({ width: 100, height: 20 }) });
    const document = Object.assign(new Target(), {
        querySelector(selector) {
            if (selector.includes('ad-showing')) return f.ad ? {} : null;
            if (selector.includes('live-badge')) return null;
            if (selector.includes('video')) return f.hasVideo ? video : null;
            return null;
        },
        querySelectorAll(selector) {
            if (selector === 'video') return f.hasVideo ? [video] : [];
            if (selector.includes('recaptcha')) return f.captcha ? [node('captcha')] : [];
            if (selector.includes('error-content')) return f.playerError ? [node(f.playerError)] : [];
            if (selector.includes('consent-bump')) return f.consent ? [node('Cookie preferences')] : [];
            return [];
        }
    });
    f.document = document;
    f.context = vm.createContext({ window, document, location: f.location, URL, Date, Promise, Math, WeakSet,
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) });
    f.run = script => vm.runInContext(script, f.context);
    f.probe = (runId = 100, options = {}) => f.run(buildYouTubeProbeScript({ runId, videoId: id, muted: false, expiresAt: Date.now() + 1000, ...options }));
    f.command = (command, value = null, runId = 100) => f.run(buildYouTubeCommandScript(runId, command, value, Date.now() + 1000));
    return f;
}

function mediaSample(patch = {}) {
    return { kind: 'media', documentUrl: url, videoId: id, documentId: 'document1', videoToken: 1,
        currentTime: 0, duration: 120, isLive: false, paused: false, readyState: 4, networkState: 1,
        contentKind: 'video', ...patch };
}

test('playing requires advancing media time; an unpaused or successful play request is insufficient', () => {
    let result = classifyPlaybackSample(mediaSample(), {}, { now: 0 });
    assert.equal(result.state.status, 'ready');
    result = classifyPlaybackSample(mediaSample(), result.history, { now: 1000 });
    assert.equal(result.state.status, 'ready');
    result = classifyPlaybackSample(mediaSample({ currentTime: 1 }), result.history, { now: 2000 });
    assert.equal(result.state.status, 'playing');
    result = classifyPlaybackSample(mediaSample({ currentTime: 1 }), result.history, { now: 6500 });
    assert.equal(result.state.status, 'buffering');
    result = classifyPlaybackSample(mediaSample({ currentTime: 30, seeking: true }), result.history, { now: 7000 });
    assert.equal(result.state.status, 'buffering');
    result = classifyPlaybackSample(mediaSample({ currentTime: 31, seeking: false }), result.history, { now: 8000 });
    assert.notEqual(result.state.status, 'playing');
});

test('ended, live, unavailable, consent and media errors remain distinct serializable states', () => {
    assert.equal(classifyPlaybackSample(mediaSample({ ended: true })).state.status, 'ended');
    const live = classifyPlaybackSample(mediaSample({ duration: Infinity, isLive: true })).state;
    assert.equal(live.duration, null);
    assert.equal(live.isLive, true);
    assert.doesNotThrow(() => JSON.stringify(live));
    assert.equal(classifyPlaybackSample({ kind: 'unavailable', message: 'Video is private.' }).state.status, 'unavailable');
    assert.equal(classifyPlaybackSample({ kind: 'blocked', reason: 'consent', message: 'Your choice is needed.' }).state.status, 'interaction-required');
    const mediaError = classifyPlaybackSample(mediaSample({ mediaErrorCode: 3 })).state;
    assert.equal(mediaError.status, 'error');
    assert.match(mediaError.message, /decoded/);
    assert.equal(classifyPlaybackSample({ kind: 'no-player' }, {}, { now: 50_000, startedAt: 0 }).state.code, 'player-timeout');
});

test('a blocked automatic play request is attempted once and reports manual recovery', async () => {
    const f = fixture();
    f.video.playImpl = () => Promise.reject(Object.assign(new Error('User activation is required.'), { name: 'NotAllowedError' }));
    f.probe();
    await microtasks();
    for (let i = 0; i < 4; i++) f.probe();
    assert.equal(f.video.playCount, 1);
    const state = classifyPlaybackSample(f.probe()).state;
    assert.equal(state.status, 'autoplay-blocked');
    assert.equal(state.autoplayBlocked, true);
    assert.match(state.message, /Click Play/);
    f.video.playImpl = null;
    f.video.paused = false;
    f.video.emit('play');
    const recovered = f.probe();
    assert.equal(recovered.playErrorName, '');
    assert.equal(recovered.paused, false);
});

test('the selected mute state is applied once and native player changes remain intact', () => {
    const f = fixture();
    assert.equal(f.probe(100, { muted: true }).muted, true);
    assert.equal(f.video.loop, false);
    f.video.muted = false;
    assert.equal(f.probe(100, { muted: true }).muted, false);
    f.command('muted', true);
    assert.equal(f.video.muted, true);
});

test('pause never triggers automatic resume, while explicit Play uses a normal media request', async () => {
    const f = fixture();
    f.probe();
    await microtasks();
    assert.equal(f.video.playCount, 1);
    f.command('pause');
    for (let i = 0; i < 3; i++) f.probe();
    assert.equal(f.video.playCount, 1);
    assert.equal(classifyPlaybackSample(f.probe()).state.status, 'paused');
    assert.equal(f.command('play').ok, true);
    await microtasks();
    assert.equal(f.video.playCount, 2);
    assert.equal(f.video.paused, false);
});

test('Pause wins over an automatic play promise that fulfills after the control was pressed', async () => {
    const f = fixture(), pending = deferred();
    f.video.playImpl = () => pending.promise;
    f.probe();
    f.command('pause');
    f.video.paused = false;
    pending.resolve();
    await microtasks();
    assert.equal(f.video.paused, true);
    assert.equal(f.video.playCount, 1);
    assert.equal(f.probe().playPending, false);
});

test('ended videos are held until the next cycle and do not replay or start a next video', async () => {
    const f = fixture();
    f.probe();
    await microtasks();
    f.video.currentTime = 120;
    f.video.ended = true;
    f.video.emit('ended');
    f.video.ended = false;
    f.video.currentTime = 0;
    f.video.paused = false;
    f.video.emit('play');
    assert.equal(f.video.paused, true);
    const held = f.probe();
    assert.equal(held.ended, true);
    assert.equal(held.currentTime, 120);
    assert.equal(f.command('play').reason, 'ended');
    assert.equal(f.video.playCount, 1);
    const replacement = new Media();
    replacement.paused = false;
    f.document.emit('play', { target: replacement });
    assert.equal(replacement.paused, true, 'A replaced video element must also remain stopped after completion.');
});

test('advertisement playback does not count as the requested video or complete its session', async () => {
    const f = fixture();
    f.ad = true;
    const first = f.probe();
    await microtasks();
    assert.equal(first.contentKind, 'advertisement');
    assert.equal(classifyPlaybackSample(first).state.status, 'loading');
    f.ad = false;
    f.video.emit('ended');
    const requested = f.probe();
    assert.equal(requested.ended, false);
    assert.equal(requested.contentKind, 'video');
    f.video.ended = true;
    f.video.emit('ended');
    assert.equal(f.probe().ended, true);
});

test('consent, verification, account and unavailable pages are reported without any clicks', () => {
    const f = fixture();
    f.location.href = 'https://consent.youtube.com/m';
    assert.equal(f.probe().reason, 'consent');
    f.location.href = 'https://accounts.google.com/ServiceLogin';
    assert.equal(f.probe().reason, 'sign-in');
    f.location.href = url;
    f.captcha = true;
    assert.equal(f.probe().reason, 'verification');
    f.captcha = false;
    f.playerError = 'This video is unavailable in your country.';
    assert.equal(f.probe().kind, 'unavailable');
    f.playerError = 'Sign in to confirm your age.';
    assert.equal(f.probe().kind, 'blocked');
    assert.equal(f.video.playCount, 0);
});

test('a browser that leaves the configured video pauses instead of following engagement links', () => {
    const f = fixture();
    f.location.href = 'https://www.youtube.com/watch?v=aaaaaaaaaaa';
    assert.equal(f.probe().reason, 'different-video');
    assert.equal(f.video.playCount, 0);
    assert.ok(f.video.pauseCount > 0);
});

test('country-specific Google CAPTCHA routes require manual verification without playback attempts', () => {
    const f = fixture();
    f.location.href = 'https://www.google.co.uk/sorry/index';
    assert.equal(f.probe().reason, 'verification');
    assert.equal(f.video.playCount, 0);
});

test('cancellation defeats late play fulfillment and stale old-generation commands', async () => {
    const f = fixture(), pending = deferred();
    f.video.playImpl = () => pending.promise;
    f.probe(100);
    f.run(buildStopYouTubePlaybackScript(100));
    f.video.paused = false;
    pending.resolve();
    await microtasks();
    assert.equal(f.video.paused, true);
    assert.equal(f.probe(100).kind, 'cancelled');
    f.video.playImpl = null;
    f.probe(101);
    await microtasks();
    const pauses = f.video.pauseCount;
    assert.equal(f.probe(100).kind, 'expired');
    assert.equal(f.run(buildStopYouTubePlaybackScript(100)), false);
    assert.equal(f.command('pause', null, 100).reason, 'inactive');
    assert.equal(f.video.pauseCount, pauses);
    f.location.href = 'https://www.youtube.com/watch?v=aaaaaaaaaaa';
    assert.equal(f.probe(100).kind, 'expired');
    assert.equal(f.video.pauseCount, pauses, 'An old probe must check ownership before pausing a changed URL.');
});

class WebContents extends EventEmitter {
    constructor(f) { super(); this.fixture = f; this.calls = []; this.stopped = false; this.destroyed = false; }
    isDestroyed() { return this.destroyed; }
    stop() { this.stopped = true; }
    executeJavaScript(script, userGesture) {
        assert.equal(userGesture, false, 'Do not fabricate user activation for playback.');
        this.calls.push(script);
        return Promise.resolve(this.fixture.run(script));
    }
}

test('main-frame load failures preserve explicit proxy transport errors for replacement', async () => {
    const wc = new WebContents(fixture()), states = [];
    const controller = new YouTubePlaybackController(wc, { url, onState: state => states.push(state) });
    controller.start();
    try {
        for (const [description, code] of [
            ['ERR_PROXY_CONNECTION_FAILED', 'proxy-transport-error'],
            ['ERR_TUNNEL_CONNECTION_FAILED', 'proxy-transport-error'],
            ['ERR_SOCKS_CONNECTION_FAILED', 'proxy-transport-error'],
            ['ERR_SOCKS_CONNECTION_HOST_UNREACHABLE', 'proxy-transport-error'],
            ['ERR_NAME_NOT_RESOLVED', 'navigation-error'],
            ['ERR_CERT_AUTHORITY_INVALID', 'navigation-error']
        ]) {
            wc.emit('did-fail-load', {}, -2, description, url, true);
            assert.equal(states.at(-1).code, code, description);
            assert.equal(states.at(-1).status, 'error');
            assert.equal(states.at(-1).message, description);
        }
    } finally { await controller.stop(); }
});

test('aborted, subframe and stopped load failures cannot request proxy replacement', async () => {
    const wc = new WebContents(fixture()), states = [];
    const controller = new YouTubePlaybackController(wc, { url, onState: state => states.push(state) });
    controller.start();
    try {
        const count = states.length;
        wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', url, true);
        wc.emit('did-fail-load', {}, -130, 'ERR_PROXY_CONNECTION_FAILED', url, false);
        assert.equal(states.length, count);
        await controller.stop();
        wc.emit('did-fail-load', {}, -130, 'ERR_PROXY_CONNECTION_FAILED', url, true);
        assert.equal(states.length, count);
    } finally { await controller.stop(); }
});

test('inspection uses the current native main frame without waiting for full page load', async () => {
    const f = fixture(), wc = new WebContents(f);
    let frameCalls = 0;
    wc.executeJavaScript = () => { throw new Error('Whole-page execution would wait for an unfinished request.'); };
    wc.mainFrame = { executeJavaScript(script, userGesture) {
        assert.equal(userGesture, false);
        frameCalls++;
        return Promise.resolve(f.run(script));
    } };
    const controller = new YouTubePlaybackController(wc, { url, pollIntervalMs: 20 });
    controller.start();
    await delay(30);
    assert.ok(frameCalls > 0);
    assert.equal(f.video.playCount, 1);
    await controller.stop();
});

test('controller observes real samples, supports controls and removes listeners/timers on abort', async () => {
    const f = fixture(), wc = new WebContents(f), abort = new AbortController(), states = [];
    const controller = new YouTubePlaybackController(wc, { url, signal: abort.signal, muted: true, pollIntervalMs: 20, evaluationTimeoutMs: 100, onState: state => states.push(state) });
    controller.start();
    await delay(30);
    f.video.currentTime = 1;
    await delay(35);
    assert.ok(states.some(state => state.status === 'playing'));
    assert.equal(f.video.playCount, 1);
    await controller.pause();
    assert.equal(f.video.paused, true);
    await controller.play();
    await controller.setMuted(false);
    assert.equal(f.video.muted, false);
    abort.abort();
    await controller.stop();
    const calls = wc.calls.length, emissions = states.length;
    await delay(50);
    assert.equal(wc.calls.length, calls);
    assert.equal(states.length, emissions);
    assert.equal(wc.stopped, true);
    assert.equal(controller.timer, null);
    assert.equal(controller.evaluations.size, 0);
    for (const event of ['destroyed', 'render-process-gone', 'did-fail-load', 'dom-ready']) assert.equal(wc.listenerCount(event), 0);
    assert.equal(f.video.listenerCount('ended'), 0);
    assert.equal(f.document.listenerCount('play'), 0);
});

test('hung inspection does not accumulate probes and its expired queued script cannot start playback', async () => {
    const f = fixture(), wc = new WebContents(f), queued = [], states = [];
    wc.executeJavaScript = (script, userGesture) => {
        assert.equal(userGesture, false);
        queued.push(script);
        return new Promise(() => {});
    };
    const controller = new YouTubePlaybackController(wc, { url, pollIntervalMs: 20, evaluationTimeoutMs: 20, onState: state => states.push(state) });
    controller.start();
    await delay(100);
    assert.equal(queued.filter(script => script.includes('function probeYouTubePage')).length, 1);
    assert.equal(controller.active, false);
    assert.equal(controller.timer, null);
    assert.ok(states.some(state => state.code === 'inspection-error'));
    assert.equal(f.run(queued[0]).kind, 'expired');
    assert.equal(f.video.playCount, 0);
    await controller.stop();
    assert.equal(controller.evaluations.size, 0);
});

test('already-aborted and destroyed browsers cannot start observation or mutate the page', async () => {
    const f = fixture(), wc = new WebContents(f), abort = new AbortController();
    abort.abort();
    const controller = new YouTubePlaybackController(wc, { url, signal: abort.signal });
    controller.start();
    assert.equal(controller.active, false);
    assert.equal(wc.calls.length, 0);
    assert.equal((await controller.play()).reason, 'inactive');
});
