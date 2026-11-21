"use strict";

const { parseYouTubeUrl } = require('../shared/youtube');

let nextRunId = 0;
const cleanMessage = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);

/*
 * This function is serialized into a sandboxed web page. It has no Electron or
 * Node capabilities. The controller never creates a trusted gesture, alters
 * autoplay policy, clicks consent, skips ads, or interacts with account controls.
 */
function probeYouTubePage(config) {
    const KEY = '__prxYtPlayback';
    const text = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
    const documentUrl = String(location.href);
    const base = { documentUrl, videoId: config.videoId };
    if (Date.now() > config.expiresAt) return { ...base, kind: 'expired' };
    // Ownership must be checked before *any* side effect, including pausing a
    // mismatched URL. An old queued probe must not pause a newer cycle's video.
    const old = window[KEY];
    if (old && old.runId > config.runId) return { ...base, kind: 'expired' };
    if (old?.runId === config.runId && old.stopped) return { ...base, kind: 'cancelled' };
    const pauseVideos = () => {
        for (const video of document.querySelectorAll('video')) {
            try { video.pause(); } catch { /* A detached media element is harmless. */ }
        }
    };
    let url;
    try { url = new URL(documentUrl); } catch { return { ...base, kind: 'no-player' }; }
    if (url.protocol === 'about:') return { ...base, kind: 'no-player' };
    const visible = element => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const visibleText = selector => {
        for (const element of document.querySelectorAll(selector)) {
            if (visible(element)) {
                const value = text(element.innerText || element.textContent);
                if (value) return value;
            }
        }
        return '';
    };
    if (/^consent\.(youtube|google)\.com$/.test(url.hostname)) {
        pauseVideos();
        return { ...base, kind: 'blocked', reason: 'consent', message: 'Choose your cookie consent preferences in this browser to continue.' };
    }
    if (url.hostname === 'accounts.google.com') {
        pauseVideos();
        return { ...base, kind: 'blocked', reason: 'sign-in', message: 'YouTube requires sign-in or an account choice in this browser.' };
    }
    if ((/^(?:www\.)?google\.(?:[a-z]{2,3}|(?:co|com)\.[a-z]{2})$/i.test(url.hostname) && url.pathname.startsWith('/sorry/')) ||
        Array.from(document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="captcha"], #captcha-form')).some(visible)) {
        pauseVideos();
        return { ...base, kind: 'blocked', reason: 'verification', message: 'Verification or CAPTCHA requires your action in this browser.' };
    }
    let currentId = '';
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
        if (url.pathname === '/watch' || url.pathname === '/watch/') currentId = url.searchParams.get('v') || '';
        else currentId = /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] || '';
    }
    if (currentId !== config.videoId) {
        pauseVideos();
        return { ...base, kind: 'blocked', reason: 'different-video', message: 'This browser left the configured video. Playback is paused until the next cycle.' };
    }
    if (old && old.runId !== config.runId) old.cleanup?.();
    let guard = window[KEY];
    if (!guard || guard.runId !== config.runId) {
        guard = {
            runId: config.runId, videoId: config.videoId,
            documentId: `${config.runId}:${Date.now()}:${Math.random()}`,
            stopped: false, completed: false, manualPaused: false,
            video: null, videoToken: 0, attempted: new WeakSet(),
            playErrorName: '', playErrorMessage: '', playPending: false,
            finalSample: null, removeMediaListeners: null, lastContentKind: null
        };
        guard.cleanup = () => {
            guard.stopped = true;
            guard.removeMediaListeners?.();
            guard.removeMediaListeners = null;
            window.removeEventListener('pagehide', guard.onPageHide);
            document.removeEventListener('play', guard.onAnyPlay, true);
        };
        guard.onPageHide = () => guard.cleanup();
        guard.onAnyPlay = event => {
            // Capture also covers a newly inserted next-video element. The
            // ended session remains held without polling or replay attempts.
            if ((guard.completed || guard.stopped) && event.target?.tagName === 'VIDEO') {
                try { event.target.pause(); } catch { /* A detached video is already stopped. */ }
            }
        };
        window.addEventListener('pagehide', guard.onPageHide, { once: true });
        document.addEventListener('play', guard.onAnyPlay, true);
        window[KEY] = guard;
    }
    const adPlaying = () => Boolean(document.querySelector('#movie_player.ad-showing, #movie_player.ad-interrupting, .html5-video-player.ad-showing'));
    const mediaSnapshot = video => ({
        ...base, kind: 'media', documentId: guard.documentId, videoToken: guard.videoToken,
        currentTime: Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0,
        duration: Number.isFinite(video.duration) ? Math.max(0, video.duration) : null,
        isLive: video.duration === Infinity || Boolean(document.querySelector('.ytp-live.ytp-live-badge, .ytp-live-badge[disabled]')),
        paused: Boolean(video.paused), ended: Boolean(video.ended || guard.completed),
        muted: Boolean(video.muted), seeking: Boolean(video.seeking),
        readyState: Number(video.readyState) || 0, networkState: Number(video.networkState) || 0,
        mediaErrorCode: Number(video.error?.code) || null,
        mediaErrorMessage: text(video.error?.message),
        playErrorName: text(guard.playErrorName), playErrorMessage: text(guard.playErrorMessage),
        playPending: guard.playPending, manualPaused: guard.manualPaused,
        contentKind: adPlaying() ? 'advertisement' : 'video'
    });
    const playerError = visibleText('.ytp-error-content-wrap, ytd-player-error-message-renderer, #player-unavailable');
    if (playerError) {
        pauseVideos();
        const requiresAction = /sign.?in|log.?in|age|verify|confirm|not a bot|consent/i.test(playerError);
        return { ...base, kind: requiresAction ? 'blocked' : 'unavailable', reason: requiresAction ? 'player-action' : 'video-unavailable', message: playerError };
    }
    const consent = visibleText('ytd-consent-bump-v2-lightbox, yt-consent-bump-v2-lightbox, form[action*="consent.youtube.com"]');
    if (consent) {
        pauseVideos();
        return { ...base, kind: 'blocked', reason: 'consent', message: 'Choose your cookie consent preferences in this browser to continue.' };
    }
    const video = document.querySelector('#movie_player video.html5-main-video') ||
        document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (!video || typeof video.play !== 'function' || typeof video.pause !== 'function') return { ...base, kind: 'no-player' };
    if (guard.completed) {
        try { video.pause(); } catch { /* Ending already released this element. */ }
        return { ...(guard.finalSample || mediaSnapshot(video)), documentUrl, ended: true, paused: true };
    }
    if (guard.video !== video) {
        guard.removeMediaListeners?.();
        guard.video = video;
        guard.videoToken += 1;
        guard.playErrorName = '';
        guard.playErrorMessage = '';
        guard.playPending = false;
        // Apply the user's selection once; subsequent native player adjustments
        // remain theirs. A video must finish instead of silently looping.
        video.muted = Boolean(config.muted);
        video.loop = false;
        const onEnded = () => {
            if (adPlaying() || guard.lastContentKind === 'advertisement' || guard.stopped || guard.video !== video) return;
            guard.completed = true;
            guard.finalSample = mediaSnapshot(video);
            try { video.pause(); } catch { /* A detached video is already stopped. */ }
        };
        const onPlay = () => {
            if (guard.stopped || guard.completed) {
                try { video.pause(); } catch { /* A detached video is already stopped. */ }
            } else {
                guard.playErrorName = '';
                guard.playErrorMessage = '';
            }
        };
        video.addEventListener('ended', onEnded);
        video.addEventListener('play', onPlay);
        guard.removeMediaListeners = () => {
            video.removeEventListener('ended', onEnded);
            video.removeEventListener('play', onPlay);
        };
    }
    const attemptPlay = () => {
        guard.attempted.add(video);
        guard.playPending = true;
        try {
            Promise.resolve(video.play()).then(() => {
                if (guard.stopped || guard.completed || guard.manualPaused || window[KEY] !== guard) {
                    try { video.pause(); } catch { /* Stop won the race. */ }
                    guard.playPending = false;
                    return;
                }
                guard.playPending = false;
                guard.playErrorName = '';
                guard.playErrorMessage = '';
            }, error => {
                if (guard.stopped || guard.completed || window[KEY] !== guard) return;
                guard.playPending = false;
                guard.playErrorName = text(error?.name || 'PlaybackError');
                guard.playErrorMessage = text(error?.message || 'Playback could not start.');
            });
        } catch (error) {
            guard.playPending = false;
            guard.playErrorName = text(error?.name || 'PlaybackError');
            guard.playErrorMessage = text(error?.message || 'Playback could not start.');
        }
    };
    guard.attemptPlay = attemptPlay;
    if (video.ended && !adPlaying()) {
        guard.completed = true;
        guard.finalSample = mediaSnapshot(video);
    } else if (!guard.manualPaused && video.readyState >= 1 && !guard.attempted.has(video)) {
        // Exactly one automatic attempt for this initialized media element.
        // Successful page autoplay needs no second play request.
        if (video.paused) attemptPlay();
        else guard.attempted.add(video);
    }
    const sample = mediaSnapshot(video);
    guard.lastContentKind = sample.contentKind;
    return sample;
}

function stopYouTubePage(runId) {
    const old = window.__prxYtPlayback;
    if (old && old.runId > runId) return false;
    if (old?.runId === runId) old.cleanup?.();
    window.__prxYtPlayback = { runId, stopped: true };
    for (const video of document.querySelectorAll('video')) {
        try { video.pause(); } catch { /* Navigation may remove a video. */ }
    }
    return true;
}

function commandYouTubePage(runId, command, value, expiresAt) {
    if (Date.now() > expiresAt) return { ok: false, reason: 'expired' };
    const guard = window.__prxYtPlayback;
    if (!guard || guard.runId !== runId || guard.stopped) return { ok: false, reason: 'inactive' };
    const video = guard.video;
    if (command === 'pause') {
        guard.manualPaused = true;
        if (video) video.pause();
        return { ok: true };
    }
    if (command === 'muted') {
        if (video) video.muted = Boolean(value);
        return { ok: true };
    }
    if (command === 'play') {
        if (guard.completed) return { ok: false, reason: 'ended' };
        guard.manualPaused = false;
        if (!video || video.readyState < 1 || !guard.attemptPlay) return { ok: false, reason: 'not-ready' };
        guard.attemptPlay();
        return { ok: true };
    }
    return { ok: false, reason: 'unknown-command' };
}

function buildYouTubeProbeScript(config) {
    return `(${probeYouTubePage.toString()})(${JSON.stringify(config)})`;
}
function buildStopYouTubePlaybackScript(runId) {
    return `(${stopYouTubePage.toString()})(${JSON.stringify(runId)})`;
}
function buildYouTubeCommandScript(runId, command, value, expiresAt) {
    return `(${commandYouTubePage.toString()})(${JSON.stringify(runId)},${JSON.stringify(command)},${JSON.stringify(value)},${JSON.stringify(expiresAt)})`;
}

/** Convert actual media samples to a state without treating play() as proof. */
function classifyPlaybackSample(sample, previous = {}, options = {}) {
    const now = options.now ?? Date.now();
    const startedAt = options.startedAt ?? now;
    const initializationTimeoutMs = options.initializationTimeoutMs ?? 45_000;
    const stallTimeoutMs = options.stallTimeoutMs ?? 4_000;
    const base = {
        status: 'loading', message: 'Waiting for the video player.',
        documentUrl: cleanMessage(sample?.documentUrl), videoId: sample?.videoId || '',
        currentTime: 0, duration: null, isLive: false, muted: false,
        paused: true, readyState: 0, networkState: 0, autoplayBlocked: false,
        mediaErrorCode: null, contentKind: 'video', code: null
    };
    if (!sample || sample.kind === 'no-player' || sample.kind === 'expired') {
        if (now - startedAt >= initializationTimeoutMs) Object.assign(base, {
            status: 'error', code: 'player-timeout', message: 'The video player did not initialize. Check this browser or wait for the next cycle.'
        });
        return { state: base, history: {} };
    }
    if (sample.kind === 'cancelled') return { state: { ...base, status: 'paused', code: 'cancelled', message: 'Playback stopped.' }, history: {} };
    if (sample.kind === 'blocked' || sample.kind === 'unavailable') return {
        state: { ...base, status: sample.kind === 'blocked' ? 'interaction-required' : 'unavailable', code: sample.reason || sample.kind, message: cleanMessage(sample.message) }, history: {}
    };
    if (sample.kind !== 'media') return { state: { ...base, status: 'error', message: 'The video player returned an invalid state.', code: 'invalid-player-state' }, history: {} };
    const identity = `${sample.documentId}:${sample.videoToken}:${sample.contentKind}`;
    const sameVideo = identity === previous.identity;
    const currentTime = Number.isFinite(sample.currentTime) ? Math.max(0, sample.currentTime) : 0;
    const advancing = sameVideo && !sample.seeking && !previous.seeking && currentTime > previous.currentTime + 0.01;
    const firstVideoAt = sameVideo ? previous.firstVideoAt : now;
    const lastAdvancedAt = advancing ? now : sameVideo ? previous.lastAdvancedAt : null;
    const history = { identity, currentTime, seeking: Boolean(sample.seeking), firstVideoAt, lastAdvancedAt };
    Object.assign(base, {
        currentTime: Math.round(currentTime * 1000) / 1000,
        duration: Number.isFinite(sample.duration) ? Math.max(0, sample.duration) : null,
        isLive: Boolean(sample.isLive), muted: Boolean(sample.muted), paused: Boolean(sample.paused),
        readyState: Number(sample.readyState) || 0, networkState: Number(sample.networkState) || 0,
        mediaErrorCode: Number(sample.mediaErrorCode) || null, contentKind: sample.contentKind || 'video'
    });
    if (sample.mediaErrorCode) {
        const message = { 1: 'Media loading was aborted.', 2: 'The video encountered a network error.', 3: 'The video could not be decoded.', 4: 'The video format or source is not supported.' }[sample.mediaErrorCode] || 'The video player reported an error.';
        Object.assign(base, { status: 'error', code: 'media-error', message: `${message}${sample.mediaErrorMessage ? ` ${cleanMessage(sample.mediaErrorMessage)}` : ''}` });
    } else if (sample.ended) {
        Object.assign(base, { status: 'ended', message: 'Video ended. Waiting for the next cycle.' });
    } else if (sample.paused && sample.playErrorName === 'NotAllowedError') {
        Object.assign(base, { status: 'autoplay-blocked', code: 'autoplay-blocked', autoplayBlocked: true, message: 'Autoplay was blocked. Click Play in this browser, or select muted playback for the next run.' });
    } else if (sample.playErrorName && sample.playErrorName !== 'AbortError' && sample.paused) {
        Object.assign(base, { status: 'error', code: 'play-rejected', message: cleanMessage(sample.playErrorMessage) || 'The video rejected the playback request.' });
    } else if (sample.contentKind === 'advertisement') {
        Object.assign(base, { status: 'loading', message: 'Advertisement in the player. Waiting for the requested video.' });
    } else if (sample.paused && (sample.manualPaused || !sample.playPending) && sample.readyState >= 1) {
        Object.assign(base, { status: 'paused', message: sample.playErrorName === 'AbortError' ? 'The play request was interrupted. Click Play in this browser to continue.' : 'Video paused. Use the player or Play control to continue.' });
    } else if (sample.readyState < 2 || sample.seeking) {
        Object.assign(base, { status: 'buffering', message: sample.seeking ? 'Seeking within the video.' : 'Waiting for video data.' });
    } else if (!sample.paused && lastAdvancedAt != null && now - lastAdvancedAt < stallTimeoutMs) {
        Object.assign(base, { status: 'playing', message: 'Playback verified by advancing media time.' });
    } else if (!sample.paused && now - (lastAdvancedAt ?? firstVideoAt) >= stallTimeoutMs) {
        Object.assign(base, { status: 'buffering', message: 'The player is not paused, but media time is not advancing.' });
    } else {
        Object.assign(base, { status: 'ready', message: 'Player ready. Waiting to verify advancing media time.' });
    }
    return { state: base, history };
}

class YouTubePlaybackController {
    constructor(webContents, options = {}) {
        const parsed = parseYouTubeUrl(options.url);
        this.webContents = webContents;
        this.url = parsed.url;
        this.videoId = parsed.videoId;
        this.muted = Boolean(options.muted);
        this.signal = options.signal;
        this.onState = typeof options.onState === 'function' ? options.onState : () => {};
        this.pollIntervalMs = Math.max(20, options.pollIntervalMs ?? 1000);
        this.initializationTimeoutMs = Math.max(50, options.initializationTimeoutMs ?? 45_000);
        this.evaluationTimeoutMs = Math.max(20, options.evaluationTimeoutMs ?? 5000);
        this.runId = ++nextRunId;
        this.state = { status: 'loading', message: 'Waiting for the video player.', videoId: this.videoId, documentUrl: this.url, currentTime: 0, duration: null, isLive: false, muted: this.muted };
        this.history = {};
        this.listeners = [];
        this.active = false;
        this.started = false;
        this.timer = null;
        this.inFlight = false;
        this.stopPromise = null;
        this.evaluations = new Set();
    }
    getState() { return { ...this.state }; }
    start() {
        if (this.started) return this.getState();
        this.started = true;
        if (this.signal?.aborted || this.webContents.isDestroyed()) return this.getState();
        this.active = true;
        this.startedAt = Date.now();
        this.abort = () => { void this.stop(); };
        this.signal?.addEventListener('abort', this.abort, { once: true });
        const listen = (event, callback) => { this.webContents.on(event, callback); this.listeners.push([event, callback]); };
        listen('destroyed', () => this.halt());
        listen('render-process-gone', (_event, details) => {
            this.publish({ ...this.state, status: 'error', code: 'renderer-crashed', message: `The video browser stopped: ${cleanMessage(details?.reason || 'renderer crash')}.` });
            this.halt();
        });
        listen('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
            if (!isMainFrame || errorCode === -3 || !this.active) return;
            const code = /ERR_PROXY_|ERR_TUNNEL_|ERR_SOCKS_/i.test(errorDescription || '') ? 'proxy-transport-error' : 'navigation-error';
            this.publish({ ...this.state, status: 'error', code, message: cleanMessage(errorDescription) || 'The video page could not load.' });
        });
        listen('dom-ready', () => { this.history = {}; this.schedule(0); });
        this.publish(this.state);
        this.schedule(0);
        return this.getState();
    }
    publish(state) {
        if (!this.active) return;
        this.state = { ...state, message: cleanMessage(state.message), observedAt: new Date().toISOString() };
        try { this.onState(this.getState()); } catch { /* A diagnostic consumer cannot break cancellation. */ }
    }
    schedule(delay = this.pollIntervalMs) {
        if (!this.active || this.inFlight) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; void this.poll(); }, delay);
    }
    evaluate(script, timeout = this.evaluationTimeoutMs) {
        return new Promise((resolve, reject) => {
            let completed = false;
            let timer;
            const finish = (error, value) => {
                if (completed) return;
                completed = true;
                clearTimeout(timer);
                this.evaluations.delete(cancel);
                if (error) reject(error); else resolve(value);
            };
            const cancel = () => {
                const error = new Error('Video state inspection cancelled.');
                error.code = 'INSPECTION_CANCELLED';
                finish(error);
            };
            this.evaluations.add(cancel);
            timer = setTimeout(() => {
                const error = new Error('Video state inspection timed out.');
                error.code = 'INSPECTION_TIMEOUT';
                finish(error);
            }, timeout);
            try {
                // Explicit false keeps Chromium autoplay permission intact.
                // Unlike webContents.executeJavaScript, a captured main frame
                // does not wait for the whole page to finish loading. YouTube
                // may keep unrelated requests open while its player is ready.
                const frame = this.webContents.mainFrame;
                const target = frame && typeof frame.executeJavaScript === 'function' ? frame : this.webContents;
                Promise.resolve(target.executeJavaScript(script, false)).then(
                    value => finish(null, value), error => finish(error));
            } catch (error) { finish(error); }
        });
    }
    async poll() {
        if (!this.active || this.inFlight || this.webContents.isDestroyed()) return;
        this.inFlight = true;
        try {
            const sample = await this.evaluate(buildYouTubeProbeScript({
                runId: this.runId, videoId: this.videoId, muted: this.muted,
                expiresAt: Date.now() + this.evaluationTimeoutMs
            }));
            if (!this.active || this.signal?.aborted) return;
            const result = classifyPlaybackSample(sample, this.history, { startedAt: this.startedAt, initializationTimeoutMs: this.initializationTimeoutMs });
            this.history = result.history;
            this.publish(result.state);
        } catch (error) {
            if (!this.active || this.signal?.aborted) return;
            // A document swap can reject an inspection. Continue observation,
            // without retrying navigation or issuing a second automatic play.
            this.publish({ ...this.state, status: 'error', code: 'inspection-error', message: cleanMessage(error?.message) || 'The video state could not be inspected.' });
            // A timed-out native request can remain queued in Chromium. Do not
            // pile up further evaluations behind it; expiration prevents the
            // late probe from initiating playback when it eventually runs.
            if (error.code === 'INSPECTION_TIMEOUT') void this.stop();
        } finally {
            this.inFlight = false;
            this.schedule();
        }
    }
    async command(command, value = null) {
        if (!this.active || this.signal?.aborted || this.webContents.isDestroyed()) return { ok: false, reason: 'inactive' };
        try {
            const result = await this.evaluate(buildYouTubeCommandScript(this.runId, command, value, Date.now() + this.evaluationTimeoutMs));
            if (!this.active || this.signal?.aborted) return { ok: false, reason: 'inactive' };
            this.schedule(0);
            return result;
        } catch (error) {
            if (this.active) this.publish({ ...this.state, status: 'error', code: 'control-error', message: cleanMessage(error.message) });
            return { ok: false, reason: 'control-error' };
        }
    }
    play() { return this.command('play'); }
    pause() { return this.command('pause'); }
    setMuted(muted) { this.muted = Boolean(muted); return this.command('muted', this.muted); }
    halt() {
        this.active = false;
        clearTimeout(this.timer);
        this.timer = null;
        this.signal?.removeEventListener('abort', this.abort);
        for (const cancel of [...this.evaluations]) cancel();
        for (const [event, listener] of this.listeners) this.webContents.removeListener(event, listener);
        this.listeners = [];
    }
    stop({ pause = true } = {}) {
        if (this.stopPromise) return this.stopPromise;
        this.halt();
        if (!pause || this.webContents.isDestroyed()) return (this.stopPromise = Promise.resolve());
        try { this.webContents.stop(); } catch { /* Browser cleanup may already have stopped it. */ }
        this.stopPromise = this.evaluate(buildStopYouTubePlaybackScript(this.runId), Math.min(this.evaluationTimeoutMs, 2000)).catch(() => {});
        return this.stopPromise;
    }
}

module.exports = {
    YouTubePlaybackController, classifyPlaybackSample,
    buildYouTubeProbeScript, buildStopYouTubePlaybackScript, buildYouTubeCommandScript
};
