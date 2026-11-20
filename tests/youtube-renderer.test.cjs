'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ui = require('../src/renderer/provider-controls');

function config(patch = {}) { return { ...ui.DEFAULT_SETTINGS, videoUrl: 'https://youtu.be/abcdefghijk', ...patch }; }

test('Start sends the video and complete current form without any SEO inputs', () => {
    const result = ui.createStartConfig(config({ videoUrl: '  https://youtu.be/abcdefghijk  ',
        browserCount: 100, intervalSec: 30, muted: false, proxyTier: 'all',
        proxyApiUrl: '  https://fixture.example/feed  ' }));
    assert.equal(result.videoUrl, 'https://youtu.be/abcdefghijk');
    assert.equal(result.proxyApiUrl, 'https://fixture.example/feed');
    assert.equal(result.browserCount, 100);
    assert.equal(result.muted, false);
    assert.equal(result.proxyTier, 'all');
    assert.deepEqual(Object.keys(result).sort(), ['browserCount', 'intervalSec', 'muted', 'proxyApiUrl', 'proxySource', 'proxyTier', 'videoUrl']);
});

test('invalid form values fail before creating or replacing browser sessions', () => {
    for (const patch of [{ videoUrl: '' }, { videoUrl: '  ' }, { videoUrl: null },
        { browserCount: 0 }, { browserCount: 101 }, { browserCount: 1.5 }, { browserCount: NaN },
        { intervalSec: 29 }, { intervalSec: 86401 }, { intervalSec: 60.2 },
        { proxySource: 'constructor' }, { proxyTier: '__proto__' }, { proxyApiUrl: ' ' }]) {
        assert.throws(() => ui.createStartConfig(config(patch)), Error, JSON.stringify(patch));
    }
});

test('the existing 1–100 workspace and 30–86400 second limits remain available', () => {
    for (const browserCount of [1, 100]) for (const intervalSec of [30, 86400]) {
        const value = ui.createStartConfig(config({ browserCount, intervalSec }));
        assert.equal(value.browserCount, browserCount);
        assert.equal(value.intervalSec, intervalSec);
    }
});

test('unknown duration and live streams do not become misleading finite media times', () => {
    assert.equal(ui.formatTime(null), '—');
    assert.equal(ui.formatTime(undefined), '—');
    assert.equal(ui.formatTime(NaN), '—');
    assert.equal(ui.formatTime(Infinity), '—');
    assert.equal(ui.formatTime(-1), '—');
    assert.equal(ui.formatTime(0), '0:00');
    assert.equal(ui.formatTime(65.9), '1:05');
    assert.equal(ui.formatTime(3661), '1:01:01');
});

test('blocked, buffering and failed observations are never presented as Playing', () => {
    for (const status of ['autoplay-blocked', 'interaction-required', 'buffering', 'error', 'unavailable', 'ended', 'paused']) {
        assert.notEqual(ui.playbackLabel(status), 'Playing');
        assert.notEqual(ui.playbackClass(status), 'status-ok');
    }
    assert.equal(ui.playbackLabel('playing'), 'Playing');
    assert.equal(ui.playbackClass('playing'), 'status-ok');
    assert.equal(ui.playbackLabel('interaction-required'), 'User action required');
});

test('diagnostics retain both distinct state explanations and concrete media errors', () => {
    assert.equal(ui.playbackMessage({ message: 'Waiting for consent', error: 'Autoplay blocked' }), 'Waiting for consent — Autoplay blocked');
    assert.equal(ui.playbackMessage({ message: 'Ended', error: 'Ended' }), 'Ended');
    assert.equal(ui.playbackMessage({ error: { private: 'not a user message' } }), '');
});

test('the application components no longer subscribe to SEO events or invoke Keep Alive controls', () => {
    const bundle = fs.readFileSync(path.join(__dirname, '../src/renderer/assets/index-BZgi7Ish.js'), 'utf8');
    const application = bundle.slice(bundle.indexOf('// PRX-YT application components.'));
    assert.match(application, /onPlaybackResult/);
    assert.match(application, /YouTube Video URL/);
    assert.doesNotMatch(application, /onSeoResult|setKeepAlive|Keywords \(|Target website|Search engine|Max Google pages/);
});
