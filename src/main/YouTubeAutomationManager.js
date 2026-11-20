"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.YouTubeAutomationManager = void 0;
const node_events_1 = require("node:events");
const automation_1 = require("../shared/types/automation");
const browser_1 = require("../shared/types/browser");
const { normalizeYouTubeUrl } = require("../shared/youtube");
const ProxyManager_1 = require("./ProxyManager");
const ProxyTiers_1 = require("../proxy/ProxyTiers");
const Logger_1 = require("./Logger");
const { waitForPreparation } = require("./runtime");
const DEFAULT_PROXY_SOURCE = (0, ProxyManager_1.resolveProxySource)();
function createCycleController() {
    const controller = new AbortController();
    // One sleeping monitor per existing workspace is expected, not a leak.
    // Keep this allowance local and finite; Stop/rotation still detach all of
    // these listeners synchronously through cancellableDelay.
    node_events_1.setMaxListeners(browser_1.BROWSER_IDS.length, controller.signal);
    return controller;
}
/**
 * YouTube orchestration derived from ProxyDesk main b7c3c93 (DOM 0.5.29).
 * Retains browser preparation, exclusive proxy allocation, tier filtering,
 * healthy-proxy retention, safe cycle cleanup and centralized scheduling.
 * Media observation is owned by YouTubePlaybackController; setup never waits
 * for full-page network completion or for a video to finish.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
class YouTubeAutomationManager extends node_events_1.EventEmitter {
    proxyManager;
    browserManager;
    ensureBrowserCount;
    timer = null;
    generation = 0;
    pendingCycle = false;
    cycleController = createCycleController();
    state = {
        running: false,
        cycleInProgress: false,
        preparingBrowsers: false,
        preparedBrowsers: 0,
        proxySource: DEFAULT_PROXY_SOURCE.id,
        proxySourceLabel: DEFAULT_PROXY_SOURCE.label,
        proxyApiUrl: DEFAULT_PROXY_SOURCE.endpoint,
        proxyTier: null, // Legacy direct API callers without the UI remain unchanged.
        videoUrl: '',
        muted: true,
        intervalSec: 600,
        browserCount: 10,
        browserIds: [],
        cycleNumber: 0,
        fetchedProxies: 0,
        checkedProxies: 0,
        totalProxies: 0,
        liveProxies: 0,
        assignedBrowsers: 0,
        retainedBrowsers: 0,
        replacedBrowsers: 0
    };
    constructor(proxyManager, browserManager, ensureBrowserCount) {
        super();
        this.proxyManager = proxyManager;
        this.browserManager = browserManager;
        this.ensureBrowserCount = ensureBrowserCount;
    }
    getState() {
        return { ...this.state, browserIds: [...this.state.browserIds] };
    }
    isRunning() {
        return this.state.running;
    }
    configureProxy(config) {
        if (this.state.running)
            throw new Error('Stop playback before changing the proxy source.');
        const source = (0, ProxyManager_1.resolveProxySource)(config?.source, config?.endpoint);
        const requestedTier = config?.tier ?? this.state.proxyTier;
        const tier = requestedTier == null ? null : (0, ProxyTiers_1.resolveProxyTier)(requestedTier);
        this.state = {
            ...this.state,
            proxySource: source.id,
            proxySourceLabel: source.label,
            proxyApiUrl: source.endpoint,
            proxyTier: tier
        };
        this.emitState();
        return this.getState();
    }
    async start(config) {
        if (!config || typeof config !== 'object') throw new Error('Enter a YouTube video URL.');
        const videoUrl = normalizeYouTubeUrl(config.videoUrl);
        const muted = config.muted == null ? true : config.muted === true;
        const browserCount = (0, automation_1.normalizeBrowserCount)(config.browserCount);
        const intervalSec = (0, automation_1.normalizeAutomationIntervalSeconds)(config.intervalSec);
        const proxySource = (0, ProxyManager_1.resolveProxySource)(config.proxySource ?? this.state.proxySource, config.proxyApiUrl ?? this.state.proxyApiUrl);
        const requestedTier = config.proxyTier ?? this.state.proxyTier;
        const proxyTier = requestedTier == null ? null : (0, ProxyTiers_1.resolveProxyTier)(requestedTier);
        // A repeated Start is rejected instead of racing an active resize/cycle.
        if (this.state.running) throw new Error('Stop the current playback run before starting again.');
        this.stopTimerOnly();
        this.proxyManager.cancelCurrentFetch();
        this.generation += 1;
        const generation = this.generation;
        this.cycleController.abort();
        this.cycleController = createCycleController();
        this.pendingCycle = false;
        // Publish state before any browser preparation. The Start button therefore
        // reacts instantly even if Electron still has browser shells to create.
        this.state = {
            running: true,
            cycleInProgress: true,
            preparingBrowsers: true,
            preparedBrowsers: 0,
            proxySource: proxySource.id,
            proxySourceLabel: proxySource.label,
            proxyApiUrl: proxySource.endpoint,
            proxyTier,
            videoUrl,
            muted,
            intervalSec,
            browserCount,
            browserIds: [],
            cycleNumber: 0,
            fetchedProxies: 0,
            checkedProxies: 0,
            totalProxies: 0,
            liveProxies: 0,
            assignedBrowsers: 0,
            retainedBrowsers: 0,
            replacedBrowsers: 0,
            nextCycleAt: undefined
        };
        this.emitState();
        let browserIds;
        try {
            const signal = this.cycleController.signal;
            browserIds = await waitForPreparation(this.ensureBrowserCount(browserCount, {
                signal,
                onProgress: (readyIds) => {
                    if (!this.isCurrent(generation) || !this.state.preparingBrowsers) return;
                    this.state = { ...this.state, preparedBrowsers: readyIds.length, browserIds: [...readyIds] };
                    this.emitState();
                }
            }), 60_000, signal, 'Browser preparation timed out. Try fewer browsers or retry Start.');
        }
        catch (err) {
            if (!this.isCurrent(generation)) return this.getState();
            this.cycleController.abort();
            this.state = {
                ...this.state,
                running: false,
                cycleInProgress: false,
                preparingBrowsers: false,
                nextCycleAt: undefined,
                lastError: `Browser preparation failed: ${err.message}`
            };
            this.emitState();
            throw err;
        }
        if (!this.isCurrent(generation)) return this.getState();
        if (browserIds.length === 0) {
            this.state = {
                ...this.state,
                running: false,
                cycleInProgress: false,
                preparingBrowsers: false,
                nextCycleAt: undefined,
                lastError: 'No browser workspaces are available.'
            };
            this.emitState();
            throw new Error('No browser workspaces are available.');
        }
        this.state = {
            ...this.state,
            cycleInProgress: false,
            preparingBrowsers: false,
            preparedBrowsers: browserIds.length,
            browserIds,
            nextCycleAt: new Date(Date.now() + intervalSec * 1000).toISOString()
        };
        this.emitState();
        this.timer = setInterval(() => {
            if (!this.state.running)
                return;
            this.state = {
                ...this.state,
                nextCycleAt: new Date(Date.now() + this.state.intervalSec * 1000).toISOString()
            };
            this.emitState();
            void this.requestCycle();
        }, intervalSec * 1000);
        void this.requestCycle();
        return this.getState();
    }
    stop() {
        this.cycleController.abort();
        this.generation += 1;
        this.pendingCycle = false;
        this.proxyManager.cancelCurrentFetch();
        this.stopTimerOnly();
        for (const id of this.state.browserIds) {
            try {
                this.browserManager.cancelMeasurementSession(id);
                this.browserManager.setBrowserKeepAlive(id, false, false);
            }
            catch {
                // Browser may already have been removed.
            }
        }
        this.state = {
            ...this.state,
            running: false,
            cycleInProgress: false,
            preparingBrowsers: false,
            nextCycleAt: undefined
        };
        this.emitState();
        return this.getState();
    }
    async runNow() {
        if (!this.state.running)
            throw new Error('Start playback first.');
        await this.requestCycle();
        return this.getState();
    }
    stopTimerOnly() {
        if (!this.timer)
            return;
        clearInterval(this.timer);
        this.timer = null;
    }
    emitState() {
        this.emit('stateChanged', this.getState());
    }
    async requestCycle() {
        if (!this.state.running)
            return;
        if (this.state.cycleInProgress) {
            this.pendingCycle = true;
            // A boundary cancels the old media immediately, including while
            // the provider is waiting for Retry-After. The next setup begins
            // only once the old setup has unwound; requests cannot overlap.
            if (!this.state.preparingBrowsers) {
                this.cycleController.abort();
                this.proxyManager.cancelCurrentFetch();
                for (const id of this.state.browserIds) this.browserManager.cancelMeasurementSession(id);
            }
            return;
        }
        await this.runCycle();
    }
    async runCycle() {
        if (!this.state.running)
            return;
        const generation = this.generation;
        this.cycleController.abort();
        this.cycleController = createCycleController();
        const cycleNumber = this.state.cycleNumber + 1;
        const browserIds = [...this.state.browserIds];
        const { videoUrl, muted, proxySource, proxyApiUrl, proxyTier } = this.state;
        // Retain already-successful proxies for the next cycle, including
        // when a country tier is selected. Historical success is NOT a live
        // connectivity, latency, geolocation, or health preflight. Proxies
        // outside the user's selected tier cannot be retained.
        const rotationStates = new Map(browserIds.map(id => [id, this.browserManager.getProxyRotationState(id)]));
        const belongsToSelectedTier = proxy => !proxyTier ||
            (0, ProxyTiers_1.matchesProxyTier)(proxy.countryCode, proxyTier);
        const retained = cycleNumber > 1 ? browserIds.filter(id => {
            const health = rotationStates.get(id);
            return health.proxy && belongsToSelectedTier(health.proxy) &&
                health.youtubeReached && !health.captchaSeen && !health.failed;
        }).map(browserId => ({ browserId, proxy: rotationStates.get(browserId).proxy, retained: true })) : [];
        const retainedIds = new Set(retained.map(assignment => assignment.browserId));
        const replacementIds = browserIds.filter(id => !retainedIds.has(id));
        const failedProxies = cycleNumber > 1
            ? replacementIds.map(id => rotationStates.get(id).proxy)
                .filter(proxy => proxy && belongsToSelectedTier(proxy)) : [];
        this.state = {
            ...this.state,
            cycleInProgress: true,
            cycleNumber,
            fetchedProxies: 0,
            checkedProxies: 0,
            totalProxies: 0,
            liveProxies: retained.length,
            assignedBrowsers: retained.length,
            retainedBrowsers: retained.length,
            replacedBrowsers: 0,
            lastCycleStartedAt: new Date().toISOString(),
            lastError: undefined
        };
        this.emitState();
        const playbackTasks = [];
        try {
            // Stop outgoing work before navigation and per-browser data clearing.
            for (const id of browserIds) {
                if (!this.isCurrent(generation))
                    return;
                this.browserManager.cancelMeasurementSession(id);
                this.browserManager.setBrowserKeepAlive(id, false, false);
            }
            const cleanupController = this.cycleController;
            const signal = cleanupController.signal;
            let nextBrowser = 0;
            const cleanBrowser = async () => {
                while (nextBrowser < browserIds.length && this.isCurrent(generation) && !signal.aborted) {
                    const id = browserIds[nextBrowser++];
                    if (!retainedIds.has(id)) {
                        await waitForPreparation(this.browserManager.assignProxy(id, null), 15_000, signal,
                            `Browser ${id} proxy reset timed out before the next cycle.`);
                    }
                    if (!this.isCurrent(generation) || signal.aborted) return;
                    await waitForPreparation(this.browserManager.prepareCycleDocument(id, signal), 15_000, signal,
                        `Browser ${id} page preparation timed out before the next cycle.`);
                    if (!this.isCurrent(generation) || signal.aborted) return;
                }
            };
            // Bound page preparation to two browsers at a time on small PCs.
            // Proxy fetching/playback starts only after all pages are released.
            // Each released document's session data is cleared before playback.
            try {
                await Promise.all(Array.from({ length: Math.min(2, browserIds.length) }, cleanBrowser));
            } catch (error) { cleanupController.abort(); throw error; }
            if (!this.isCurrent(generation) || signal.aborted) return;
            for (const assignment of retained) {
                playbackTasks.push(this.handleAssignment(generation, cycleNumber, assignment, videoUrl, muted, signal));
            }
            // Healthy browsers reopen the configured video even if the provider is
            // unavailable. An all-healthy cycle needs no API request at all.
            if (replacementIds.length) await this.proxyManager.fetchAssignDirect(replacementIds, (assignment) => {
                if (!this.isCurrent(generation) || this.state.cycleNumber !== cycleNumber)
                    return;
                playbackTasks.push(this.handleAssignment(generation, cycleNumber, assignment, videoUrl, muted, signal));
            }, (checked, total, working, assigned, fetched) => {
                if (!this.isCurrent(generation))
                    return;
                this.state = {
                    ...this.state,
                    fetchedProxies: fetched,
                    checkedProxies: checked,
                    totalProxies: total,
                    liveProxies: working + retained.length,
                    assignedBrowsers: assigned + retained.length,
                    replacedBrowsers: assigned
                };
                this.emitState();
            }, { source: proxySource, endpoint: proxyApiUrl, tier: proxyTier, retainedAssignments: retained, failedProxies });
            await Promise.allSettled(playbackTasks);
            if (!this.isCurrent(generation))
                return;
            this.state = {
                ...this.state,
                cycleInProgress: false,
                lastCycleCompletedAt: new Date().toISOString()
            };
            this.emitState();
            Logger_1.logger.info('application', `Playback cycle ${cycleNumber} setup complete: ${this.state.liveProxies} available, ` +
                `${this.state.assignedBrowsers}/${browserIds.length} browser(s) assigned.`);
        }
        catch (err) {
            if (!this.isCurrent(generation)) return;
            this.state = {
                ...this.state,
                cycleInProgress: false,
                lastCycleCompletedAt: new Date().toISOString(),
                lastError: this.pendingCycle ? undefined : err.message
            };
            this.emitState();
            Logger_1.logger.warn('application', `Playback cycle ${cycleNumber} failed: ${err.message}`);
        }
        finally {
            if (this.isCurrent(generation) && this.state.cycleNumber === cycleNumber && this.state.cycleInProgress) {
                this.state = { ...this.state, cycleInProgress: false };
                this.emitState();
            }
            if (this.isCurrent(generation) && this.pendingCycle) {
                this.pendingCycle = false;
                void this.requestCycle();
            }
        }
    }
    async handleAssignment(generation, cycleNumber, assignment, videoUrl, muted, signal) {
        const current = () => this.isCurrent(generation) && this.state.cycleNumber === cycleNumber && !signal.aborted;
        if (!assignment.proxy || !current()) return;
        const { browserId, proxy } = assignment;
        try {
            if (assignment.retained) this.browserManager.beginProxyCycle(browserId);
            else await waitForPreparation(this.browserManager.assignProxy(browserId, proxy), 15_000, signal,
                `Browser ${browserId} proxy assignment timed out.`);
            if (!current()) return;
            this.browserManager.setBrowserKeepAlive(browserId, false, false);
            await this.browserManager.startYouTubePlayback(browserId, {
                videoUrl, muted, signal,
                onState: state => {
                    if (!current()) return;
                    this.emit('playbackResult', { cycleNumber, result: {
                        ...state, browserId, videoUrl, ranAt: state.observedAt || new Date().toISOString()
                    }});
                }
            });
        } catch (error) {
            if (!current()) return;
            this.emit('playbackResult', { cycleNumber, result: {
                browserId, videoUrl, status: 'error', error: error.message,
                message: error.message, ranAt: new Date().toISOString()
            }});
        }
    }
    isCurrent(generation) {
        return this.state.running && generation === this.generation;
    }
}
exports.YouTubeAutomationManager = YouTubeAutomationManager;
