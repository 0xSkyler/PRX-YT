'use strict';
const { normalizeYouTubeUrl } = require('../shared/youtube');
const { waitForPreparation, preparationCancelled } = require('./runtime');

// A HEAD request checks transport only. The real player remains the authority
// for CAPTCHA, consent, availability and playback; never follow a challenge here.
async function checkProxyHealth(session, videoUrl, { signal, isCurrent = () => true, timeoutMs = 10_000 } = {}) {
    const url = normalizeYouTubeUrl(videoUrl);
    const assertCurrent = () => { if (signal?.aborted || !isCurrent()) throw preparationCancelled(); };
    assertCurrent();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const checkedAt = new Date().toISOString();
    try {
        const request = Promise.resolve().then(() => {
            assertCurrent();
            return session.fetch(url, { method: 'HEAD', redirect: 'manual', signal: controller.signal });
        }).then(response => {
            // Cancel late response bodies too, including a fetch that ignored AbortSignal.
            try { void Promise.resolve(response.body?.cancel()).catch(() => {}); } catch { /* Already closed. */ }
            return response;
        });
        const response = await waitForPreparation(request, timeoutMs, signal, 'Proxy transport check timed out.');
        assertCurrent();
        const httpStatus = response.status;
        if (httpStatus === 407) return { status: 'failed', code: 'proxy-authentication', httpStatus, checkedAt,
            message: 'The proxy requires valid credentials.' };
        if (httpStatus >= 300 && httpStatus < 400 || [401, 403, 429].includes(httpStatus)) return {
            status: 'interaction-required', code: 'access-response', httpStatus, checkedAt,
            message: `Transport responded with HTTP ${httpStatus}. Inspect the selected video for access or consent requirements.`
        };
        if (httpStatus >= 500 || httpStatus < 200) return { status: 'failed', code: 'upstream-response', httpStatus, checkedAt,
            message: `Transport returned HTTP ${httpStatus}; this does not establish a broken proxy.` };
        return { status: 'reachable', code: 'transport-response', httpStatus, checkedAt,
            message: `Transport responded with HTTP ${httpStatus}. Player state must be checked separately.` };
    } catch (error) {
        assertCurrent();
        return { status: 'failed', code: /timed out/i.test(error.message) ? 'transport-timeout' : /ERR_PROXY_|ERR_TUNNEL_|ERR_SOCKS_/i.test(error.message) ? 'proxy-transport-error' : 'transport-error', checkedAt,
            message: /timed out/i.test(error.message) ? 'Proxy transport check timed out.' : 'The selected video could not be reached through this proxy.' };
    } finally {
        signal?.removeEventListener('abort', abort);
        controller.abort();
    }
}
module.exports = { checkProxyHealth };
