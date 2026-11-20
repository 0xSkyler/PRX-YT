'use strict';

// Renderer helpers stay readable next to the recovered React runtime. They are
// shared by the real controls and the unit fixtures; no DOM rewriting/replayed
// Start clicks or private React APIs are needed.
(function installPrxYtUi(global) {
    const SETTINGS_KEY = 'prx-yt.settings.v1';
    const SOURCE_DEFAULTS = Object.freeze({
        'all-working': Object.freeze({
            label: 'All Working API',
            endpoint: 'http://169.58.35.69/data/all-working.txt'
        }),
        'proxyscrape-free': Object.freeze({
            label: 'ProxyScrape Free API',
            endpoint: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text'
        })
    });
    const TIER_LABELS = Object.freeze({
        tier1: 'Tier 1 · 25 countries',
        tier2: 'Tier 2 · 22 countries',
        tier3: 'Tier 3 · All remaining / unknown countries',
        all: 'All Countries · labeled countries only'
    });
    const STATUS_LABELS = Object.freeze({
        idle: 'Idle', loading: 'Loading video', ready: 'Player ready',
        playing: 'Playing', paused: 'Paused', buffering: 'Buffering', ended: 'Ended',
        unavailable: 'Video unavailable', error: 'Playback error',
        'playback-error': 'Playback error', 'autoplay-blocked': 'Autoplay blocked',
        'interaction-required': 'User action required', 'awaiting-user': 'User action required',
        'navigation-blocked': 'Navigation blocked', stopped: 'Stopped', cancelled: 'Stopped'
    });
    const DEFAULT_SETTINGS = Object.freeze({
        videoUrl: '', muted: true, browserCount: 10, intervalSec: 600,
        proxySource: 'proxyscrape-free',
        proxyApiUrl: SOURCE_DEFAULTS['proxyscrape-free'].endpoint,
        proxyTier: 'tier1'
    });
    const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
    const boundedNumber = (value, fallback, min, max) => Number.isInteger(value) && value >= min && value <= max ? value : fallback;
    function normalizeSettings(value) {
        const saved = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const proxySource = owns(SOURCE_DEFAULTS, saved.proxySource) ? saved.proxySource : DEFAULT_SETTINGS.proxySource;
        return {
            videoUrl: typeof saved.videoUrl === 'string' ? saved.videoUrl.slice(0, 4096) : '',
            muted: typeof saved.muted === 'boolean' ? saved.muted : DEFAULT_SETTINGS.muted,
            browserCount: boundedNumber(saved.browserCount, DEFAULT_SETTINGS.browserCount, 1, 100),
            intervalSec: boundedNumber(saved.intervalSec, DEFAULT_SETTINGS.intervalSec, 30, 86400),
            proxySource,
            proxyApiUrl: typeof saved.proxyApiUrl === 'string' && saved.proxyApiUrl.trim()
                ? saved.proxyApiUrl.trim().slice(0, 4096) : SOURCE_DEFAULTS[proxySource].endpoint,
            proxyTier: owns(TIER_LABELS, saved.proxyTier) ? saved.proxyTier : DEFAULT_SETTINGS.proxyTier
        };
    }
    function readSettings(storage) {
        try { return normalizeSettings(JSON.parse(storage.getItem(SETTINGS_KEY) || '{}')); }
        catch { return { ...DEFAULT_SETTINGS }; }
    }
    function saveSettings(storage, value) {
        try { storage.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(value))); return true; }
        catch { return false; }
    }
    function createStartConfig(settings) {
        const videoUrl = typeof settings.videoUrl === 'string' ? settings.videoUrl.trim() : '';
        if (!videoUrl) throw new Error('Enter a YouTube video URL.');
        if (!Number.isInteger(settings.browserCount) || settings.browserCount < 1 || settings.browserCount > 100)
            throw new Error('Choose a whole number of browsers from 1 to 100.');
        if (!Number.isInteger(settings.intervalSec) || settings.intervalSec < 30 || settings.intervalSec > 86400)
            throw new Error('Choose a whole cycle interval from 30 to 86400 seconds.');
        if (!owns(SOURCE_DEFAULTS, settings.proxySource)) throw new Error('Choose a supported proxy source.');
        if (!owns(TIER_LABELS, settings.proxyTier)) throw new Error('Choose a supported proxy country tier.');
        const proxyApiUrl = typeof settings.proxyApiUrl === 'string' ? settings.proxyApiUrl.trim() : '';
        if (!proxyApiUrl) throw new Error('Enter a proxy API URL.');
        return { videoUrl, muted: Boolean(settings.muted), browserCount: settings.browserCount,
            intervalSec: settings.intervalSec, proxySource: settings.proxySource, proxyApiUrl, proxyTier: settings.proxyTier };
    }
    function formatTime(value) {
        if (!Number.isFinite(value) || value < 0) return '—';
        const seconds = Math.floor(value);
        const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
        return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
            : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
    }
    function playbackLabel(status) { return STATUS_LABELS[status] || (typeof status === 'string' ? status : 'Waiting'); }
    function playbackClass(status) {
        if (status === 'playing') return 'status-ok';
        if (['error', 'playback-error', 'unavailable'].includes(status)) return 'status-bad';
        if (['autoplay-blocked', 'interaction-required', 'awaiting-user', 'buffering', 'navigation-blocked'].includes(status)) return 'status-warning';
        return 'muted';
    }
    function playbackMessage(playback) {
        return [playback?.message, playback?.error].filter(value => typeof value === 'string' && value.trim())
            .filter((value, index, values) => values.indexOf(value) === index).join(' — ');
    }
    function providerNote(settings) {
        if (settings.proxySource === 'all-working' && settings.proxyTier !== 'tier3')
            return 'This tier needs country-labeled JSON. For the default All Working text feed, choose Tier 3.';
        return 'Country tiers use provider labels. All Countries includes every known country; Tier 3 also accepts unclassified proxies.';
    }
    const helpers = Object.freeze({ SETTINGS_KEY, SOURCE_DEFAULTS, TIER_LABELS, STATUS_LABELS, DEFAULT_SETTINGS,
        normalizeSettings, readSettings, saveSettings, createStartConfig, formatTime, playbackLabel, playbackClass, playbackMessage, providerNote });
    if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
    else global.prxYtUi = helpers;
})(globalThis);
