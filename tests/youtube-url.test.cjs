'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeYouTubeUrl, parseYouTubeUrl } = require('../src/shared/youtube');
const id = 'dQw4w9WgXcQ';
const canonical = `https://www.youtube.com/watch?v=${id}`;

test('standard, short, mobile, Shorts and live URLs normalize to one specific video', () => {
    for (const input of [
        `https://youtube.com/watch?v=${id}`, `http://www.youtube.com/watch?v=${id}`,
        `youtube.com/watch?v=${id}`, `m.youtube.com/watch?v=${id}`,
        `https://youtu.be/${id}`, `www.youtu.be/${id}/`,
        `https://www.youtube.com/shorts/${id}`, `https://youtube.com/live/${id}/`,
        `https://youtube.com/embed/${id}`, `https://youtube.com:443/watch?v=${id}`,
        `  https://www.youtube.com/watch?v=${id}&list=PL_example&index=4&si=tracking  `
    ]) assert.equal(normalizeYouTubeUrl(input), canonical, input);
});

test('explicit timestamps survive normalization while tracking and playlist navigation do not', () => {
    const values = [
        [`https://youtu.be/${id}?t=1m30s&si=track`, 90],
        [`https://youtube.com/watch?v=${id}&start=120`, 120],
        [`https://youtube.com/watch?v=${id}#t=1h2m3s`, 3723],
        [`https://youtube.com/live/${id}?t=0`, 0]
    ];
    for (const [input, seconds] of values) {
        const parsed = parseYouTubeUrl(input);
        assert.equal(parsed.videoId, id);
        assert.equal(parsed.startSeconds, seconds);
        assert.equal(parsed.url, canonical + (seconds ? `&t=${seconds}s` : ''));
    }
});

test('arbitrary navigation, lookalike domains, credentials and ambiguous IDs are rejected', () => {
    for (const input of [
        '', null, {}, 123, 'javascript:alert(1)', `file:///watch?v=${id}`,
        `https://youtube.com.evil.example/watch?v=${id}`, `https://evil.example/youtube.com/watch?v=${id}`,
        `https://user:password@youtube.com/watch?v=${id}`, `https://youtube.com:8443/watch?v=${id}`,
        `https://youtube.com/watch?v=${id}&v=aaaaaaaaaaa`, 'https://youtube.com/watch?v=short',
        `https://youtube.com/watch?v=${id}%2fextra`, `https://youtu.be/${id}/extra`,
        `https://youtube.com/@channel/live`, 'https://youtube.com/playlist?list=123',
        `https://youtube.com/watch?list=123`, `https://youtube.com./watch?v=${id}`,
        `https:\\youtube.com\watch?v=${id}`, `https://youtube.com/watch?v=${id}\n&x=1`,
        `https://youtube.com/watch?v=${id}&t=-10`, `https://youtu.be/${id}?t=tomorrow`,
        `https://youtu.be/${id}?t=1&t=2`, `https://youtu.be/${id}?start=999999999999999999`
    ]) assert.throws(() => normalizeYouTubeUrl(input), /valid YouTube video URL/, String(input));
});
