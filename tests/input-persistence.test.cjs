'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SETTINGS_KEY, DEFAULT_SETTINGS, readSettings, saveSettings } = require('../src/renderer/provider-controls');

function memoryStorage(seed = []) {
    const values = new Map(seed);
    return { values, getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('PRX-YT restores the video, muted setting, fleet, cadence and proxy configuration', () => {
    const storage = memoryStorage();
    const settings = { videoUrl: 'https://youtu.be/abcdefghijk', muted: false,
        browserCount: 73, intervalSec: 180, proxySource: 'all-working',
        proxyApiUrl: 'https://fixture.example/proxies', proxyTier: 'all' };
    assert.equal(saveSettings(storage, settings), true);
    assert.deepEqual(readSettings(storage), settings);
    assert.equal(storage.values.size, 1);
    assert.equal(storage.values.has(SETTINGS_KEY), true);
});

test('deleting the saved YouTube URL stays deleted and does not restore legacy DOM inputs', () => {
    const storage = memoryStorage([['dom.keywords', 'old keyword'], ['dom.targetWebsite', 'old.example']]);
    assert.equal(readSettings(storage).videoUrl, '');
    saveSettings(storage, { ...DEFAULT_SETTINGS, videoUrl: 'https://youtu.be/abcdefghijk' });
    saveSettings(storage, { ...readSettings(storage), videoUrl: '' });
    assert.equal(readSettings(storage).videoUrl, '');
    assert.equal(storage.getItem('dom.keywords'), 'old keyword');
    assert.equal(storage.getItem('dom.targetWebsite'), 'old.example');
});

test('unavailable or full settings storage never prevents a fresh usable form', () => {
    const storage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('full'); } };
    assert.deepEqual(readSettings(storage), DEFAULT_SETTINGS);
    assert.equal(saveSettings(storage, DEFAULT_SETTINGS), false);
});

test('malformed and wrong-shape saved values reset safely without enabling sound or a huge fleet', () => {
    for (const content of ['bad JSON', 'null', '[]', '"text"', '{"browserCount":1000000,"muted":"false","intervalSec":-1,"proxyTier":"constructor"}']) {
        const settings = readSettings(memoryStorage([[SETTINGS_KEY, content]]));
        assert.equal(settings.muted, true);
        assert.equal(settings.browserCount, 10);
        assert.equal(settings.intervalSec, 600);
        assert.equal(settings.proxyTier, 'tier1');
    }
});

test('saved settings contain only recognized configuration fields', () => {
    const storage = memoryStorage();
    saveSettings(storage, { ...DEFAULT_SETTINGS, query: 'obsolete', targetWebsite: 'obsolete',
        running: true, cycleNumber: 200, secretUnrelatedField: 'not persisted' });
    assert.deepEqual(Object.keys(JSON.parse(storage.getItem(SETTINGS_KEY))).sort(), Object.keys(DEFAULT_SETTINGS).sort());
});
