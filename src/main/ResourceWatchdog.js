'use strict';
const MB = 1024 ** 2;
class ResourceWatchdog {
    constructor({ onPressure, log }) {
        this.onPressure = onPressure;
        this.log = log;
        this.pressureSamples = 0;
        this.latched = false;
        this.busy = false;
        this.pressured = false;
        this.lastLogAt = 0;
    }
    async sample({ totalBytes, freeBytes, appBytes }) {
        if (!(totalBytes > 0) || !Number.isFinite(freeBytes) || !Number.isFinite(appBytes)) return;
        const reserve = Math.max(512 * MB, totalBytes * 0.1);
        const budget = Math.min(8192 * MB, totalBytes * 0.5);
        const pressure = freeBytes < reserve || appBytes > budget;
        this.pressured = pressure;
        if (Date.now() - this.lastLogAt >= 60_000) {
            this.lastLogAt = Date.now();
            this.log(`Memory: app=${Math.round(appBytes / MB)}MB free=${Math.round(freeBytes / MB)}MB budget=${Math.round(budget / MB)}MB reserve=${Math.round(reserve / MB)}MB.`);
        }
        if (!pressure) { this.pressureSamples = 0; this.latched = false; return; }
        if (this.latched || this.busy || ++this.pressureSamples < 2) return;
        this.latched = true;
        this.busy = true;
        try {
            await this.onPressure('Playback paused for memory pressure. Workspaces were released. Reduce browser count and press Start when memory is available.');
        } catch (error) {
            this.log(`Memory recovery: ${error.message}`);
        } finally { this.busy = false; }
    }
}
module.exports = { ResourceWatchdog };
