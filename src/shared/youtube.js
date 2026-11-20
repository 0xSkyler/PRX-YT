"use strict";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);

function invalidUrl(detail) {
    return new Error(`Enter a valid YouTube video URL. ${detail}`);
}

function parseStartSeconds(value) {
    if (value == null || value === '') return 0;
    let seconds;
    if (/^\d+$/.test(value)) seconds = Number(value);
    else {
        const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(value);
        if (!match || !match.slice(1).some(part => part != null)) {
            throw invalidUrl('The start time must be seconds or a time such as 1m30s.');
        }
        seconds = Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
    }
    if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 2_147_483_647) {
        throw invalidUrl('The video start time is outside the supported range.');
    }
    return seconds;
}

/** Accept a specific public YouTube video, never an arbitrary navigation URL. */
function parseYouTubeUrl(input) {
    if (typeof input !== 'string' || !input.trim()) throw invalidUrl('Paste a watch, youtu.be, Shorts, or live video link.');
    let value = input.trim();
    if (value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) {
        throw invalidUrl('The link contains invalid characters.');
    }
    if (/^(?:(?:www|m)\.)?youtube\.com\//i.test(value) || /^(?:www\.)?youtu\.be\//i.test(value)) {
        value = `https://${value}`;
    }
    let parsed;
    try { parsed = new URL(value); } catch { throw invalidUrl('The link could not be read.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port) {
        throw invalidUrl('Use an HTTP or HTTPS YouTube link without credentials or a custom port.');
    }
    const host = parsed.hostname.toLowerCase();
    if (!YOUTUBE_HOSTS.has(host) && !SHORT_HOSTS.has(host)) {
        throw invalidUrl('Only youtube.com and youtu.be video links are supported.');
    }
    let path;
    try { path = decodeURIComponent(parsed.pathname); } catch { throw invalidUrl('The video path is malformed.'); }
    let kind, videoId;
    if (SHORT_HOSTS.has(host)) {
        const match = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(path);
        if (match) { videoId = match[1]; kind = 'short-link'; }
    } else if (path === '/watch' || path === '/watch/') {
        if (parsed.searchParams.getAll('v').length !== 1) throw invalidUrl('The watch link must contain one video ID.');
        videoId = parsed.searchParams.get('v');
        kind = 'watch';
    } else {
        const match = /^\/(shorts|live|embed)\/([A-Za-z0-9_-]{11})\/?$/.exec(path);
        if (match) { kind = match[1]; videoId = match[2]; }
    }
    if (!VIDEO_ID.test(videoId || '')) {
        throw invalidUrl('Open the video or live stream and copy its specific video link; channel and playlist links are not supported.');
    }
    for (const key of ['t', 'start']) {
        if (parsed.searchParams.getAll(key).length > 1) throw invalidUrl('The link contains more than one start time.');
    }
    const fragment = new URLSearchParams(parsed.hash.slice(1));
    const start = parsed.searchParams.get('t') ?? parsed.searchParams.get('start') ?? fragment.get('t');
    const startSeconds = parseStartSeconds(start);
    const normalized = new URL('https://www.youtube.com/watch');
    normalized.searchParams.set('v', videoId);
    if (startSeconds) normalized.searchParams.set('t', `${startSeconds}s`);
    return { url: normalized.href, videoId, startSeconds, kind };
}

function normalizeYouTubeUrl(input) {
    return parseYouTubeUrl(input).url;
}

function normalizeYouTubeUrls(input) {
    const lines = typeof input === 'string' ? input.split(/\r\n?|\n/) : input;
    if (!Array.isArray(lines)) throw new Error('Enter one or more YouTube video URLs, one per line.');
    const urls = new Set();
    for (let index = 0; index < lines.length; index++) {
        if (typeof lines[index] === 'string' && !lines[index].trim()) continue;
        let url;
        try { url = normalizeYouTubeUrl(lines[index]); }
        catch (error) { throw new Error(`YouTube URL on line ${index + 1} is invalid: ${error.message}`); }
        urls.add(url);
        if (urls.size > 100) throw new Error('Enter at most 100 unique YouTube video URLs.');
    }
    if (!urls.size) throw new Error('Enter at least one YouTube video URL.');
    return [...urls];
}

const youtubeUrls = Object.freeze({ normalizeYouTubeUrl, normalizeYouTubeUrls, parseYouTubeUrl, parseStartSeconds });
if (typeof module !== 'undefined' && module.exports) module.exports = youtubeUrls;
else globalThis.prxYtYouTube = youtubeUrls;
