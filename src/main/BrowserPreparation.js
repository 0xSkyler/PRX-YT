"use strict";
const { BROWSER_IDS } = require('../shared/types/browser');
const { normalizeBrowserCount } = require('../shared/types/automation');
const { cancellableDelay, waitForPreparation, preparationCancelled } = require('./runtime');

// Limit only workspace creation, not the number of browsing/Keep Alive tasks.
// Starting dozens of Chromium renderers and storage contexts in one turn can
// starve the dashboard on a small PC. Two workers leave room for UI and Stop.
class BrowserPreparation {
    queue = Promise.resolve();
    constructor(browserManager, { concurrency = 2, pauseMs = 50, retryDelayMs = 250 } = {}) {
        this.browserManager = browserManager;
        this.concurrency = concurrency;
        this.pauseMs = pauseMs;
        this.retryDelayMs = retryDelayMs;
    }
    ensure(count, options = {}) {
        const work = this.queue.catch(() => {}).then(() => this.prepare(count, options));
        this.queue = work;
        return work;
    }
    async prepare(count, { signal, onProgress, onFailure } = {}) {
        const assertActive = () => {
            if (signal?.aborted || this.browserManager.disposed) throw preparationCancelled();
        };
        assertActive();
        const desired = BROWSER_IDS.slice(0, normalizeBrowserCount(count));
        const desiredSet = new Set(desired);
        const ready = new Set(this.browserManager.getAll().map((browser) => browser.id));
        const report = () => onProgress?.(desired.filter((id) => ready.has(id)));
        report();
        for (const id of ready) {
            assertActive();
            if (!desiredSet.has(id)) {
                await waitForPreparation(this.browserManager.destroyBrowser(id), 5_000, signal,
                    `Browser ${id} cleanup timed out. Stop and retry with fewer browsers.`);
                ready.delete(id);
            }
        }
        const pending = desired.filter((id) => !ready.has(id));
        let next = 0, failure;
        const worker = async () => {
            while (next < pending.length) {
                assertActive();
                const id = pending[next++];
                for (let attempt = 0; attempt < 3; attempt++) {
                    assertActive();
                    try {
                        await this.browserManager.createBrowser(id, {
                            persistSessions: true, startPage: 'about:blank', userAgent: '', signal
                        });
                        assertActive();
                        ready.add(id);
                        report();
                        break;
                    } catch (error) {
                        assertActive();
                        if (error.name === 'AbortError') throw error;
                        if (attempt < 2) await cancellableDelay(this.retryDelayMs * 2 ** attempt, signal);
                        else {
                            failure ??= error;
                            onFailure?.(id, error);
                        }
                    }
                }
                await cancellableDelay(this.pauseMs, signal);
            }
        };
        // Wait for both workers to settle before another resize can reuse IDs.
        const results = await Promise.allSettled(Array.from({ length: Math.min(this.concurrency, pending.length) }, worker));
        for (const result of results) if (result.status === 'rejected') throw result.reason;
        assertActive();
        report();
        const prepared = desired.filter(id => ready.has(id));
        if (!prepared.length && failure) throw failure;
        return prepared;
    }
}

module.exports = { BrowserPreparation };
