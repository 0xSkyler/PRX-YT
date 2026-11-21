"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.YouTubeAutomationManager = void 0;
const node_events_1 = require("node:events");
const { randomInt } = require('node:crypto');
const automation_1 = require("../shared/types/automation");
const browser_1 = require("../shared/types/browser");
const { normalizeYouTubeUrls } = require("../shared/youtube");
const ProxyManager_1 = require("./ProxyManager");
const ProxyTiers_1 = require("../proxy/ProxyTiers");
const Logger_1 = require("./Logger");
const { waitForPreparation } = require("./runtime");
const DEFAULT_PROXY_SOURCE = (0, ProxyManager_1.resolveProxySource)();
function createCycleController() {
    const controller = new AbortController();
    // Each workspace owns one playback listener; setup adds at most eight waits.
    node_events_1.setMaxListeners(browser_1.BROWSER_IDS.length + 8, controller.signal);
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
    retryTimer = null;
    retryAttempts = 0;
    blockedBrowserIds = new Set();
    assignmentQueue = [];
    assignmentActive = 0;
    recoveryAttempts = new Map();
    recoveringBrowsers = new Set();
    generation = 0;
    pendingCycle = false;
    pendingExplicitCycle = false;
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
        return { ...this.state, browserIds: [...this.state.browserIds],
            videoUrls: [...(this.state.videoUrls || [])], videoAssignments: { ...this.state.videoAssignments },
            blockedBrowserIds: [...this.blockedBrowserIds],
            preparationFailures: [...(this.state.preparationFailures || [])] };
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
        const videoUrls = normalizeYouTubeUrls(config.videoUrls ?? config.videoUrl);
        const videoUrl = videoUrls[0];
        const muted = config.muted == null ? true : config.muted === true;
        const browserCount = (0, automation_1.normalizeBrowserCount)(config.browserCount);
        const intervalSec = (0, automation_1.normalizeAutomationIntervalSeconds)(config.intervalSec);
        const proxySource = (0, ProxyManager_1.resolveProxySource)(config.proxySource ?? this.state.proxySource, config.proxyApiUrl ?? this.state.proxyApiUrl);
        const requestedTier = config.proxyTier ?? this.state.proxyTier;
        const proxyTier = requestedTier == null ? null : (0, ProxyTiers_1.resolveProxyTier)(requestedTier);
        // A repeated Start is rejected instead of racing an active resize/cycle.
        if (this.state.running) throw new Error('Stop the current playback run before starting again.');
        this.stopTimerOnly();
        this.retryAttempts = 0;
        this.blockedBrowserIds.clear();
        this.proxyManager.cancelCurrentFetch();
        this.generation += 1;
        const generation = this.generation;
        this.cycleController.abort();
        this.cycleController = createCycleController();
        this.pendingCycle = false;
        this.pendingExplicitCycle = false;
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
            videoUrls,
            videoAssignments: {},
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
            preparationFailures: [],
            retryAttempt: 0,
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
                },
                onFailure: (id, error) => {
                    if (!this.isCurrent(generation)) return;
                    this.state = { ...this.state, preparationFailures: [...this.state.preparationFailures,
                        { browserId: id, error: error.message }] };
                    this.emitState();
                }
            }), Math.max(60_000, Math.ceil(browserCount / 2) * 5_000), signal,
            'Browser preparation timed out. Stop and retry with fewer browsers.');
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
            videoAssignments: Object.fromEntries(browserIds.map(id => [id, videoUrls[randomInt(videoUrls.length)]])),
            nextCycleAt: new Date(Date.now() + intervalSec * 1000).toISOString()
        };
        this.emitState();
        this.timer = setInterval(() => {
            if (!this.state.running || this.retryAttempts >= 3)
                return;
            this.state = {
                ...this.state,
                nextCycleAt: new Date(Date.now() + this.state.intervalSec * 1000).toISOString()
            };
            this.emitState();
            void this.requestCycle();
        }, intervalSec * 1000);
        this.pendingCycle = false;
        this.pendingExplicitCycle = false;
        void this.requestCycle(true);
        return this.getState();
    }
    stop() {
        this.cycleController.abort();
        this.generation += 1;
        this.pendingCycle = false;
        this.pendingExplicitCycle = false;
        for (const work of this.assignmentQueue.splice(0)) work.resolve();
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
    pauseForResourcePressure(message) {
        this.stop();
        this.state = { ...this.state, lastError: String(message) };
        this.emitState();
        return this.getState();
    }
    async runNow() {
        if (!this.state.running)
            throw new Error('Start playback first.');
        this.retryAttempts = 0;
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.state = { ...this.state, retryAttempt: 0 };
        await this.requestCycle(true);
        return this.getState();
    }
    stopTimerOnly() {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        if (!this.timer)
            return;
        clearInterval(this.timer);
        this.timer = null;
    }
    emitState() {
        this.emit('stateChanged', this.getState());
    }
    async requestCycle(explicit = false) {
        if (!this.state.running)
            return;
        if (!explicit && (this.retryTimer || this.retryAttempts >= 3)) return;
        if (this.state.cycleInProgress) {
            this.pendingCycle = true;
            this.pendingExplicitCycle ||= explicit;
            // Explicit retry cancels old work; scheduled boundaries coalesce.
            if (explicit && !this.state.preparingBrowsers) {
                this.cycleController.abort();
                this.proxyManager.cancelCurrentFetch();
                for (const id of this.state.browserIds) this.browserManager.cancelMeasurementSession(id);
            }
            return;
        }
        await this.runCycle(explicit);
    }
    async runCycle(explicit = false) {
        if (!this.state.running) return;
        const generation = this.generation;
        this.cycleController.abort();
        this.cycleController = createCycleController();
        const controller = this.cycleController;
        const signal = controller.signal;
        const cycleNumber = this.state.cycleNumber + 1;
        const retryingBlockedIds = explicit ? new Set(this.blockedBrowserIds) : new Set();
        if (explicit) this.blockedBrowserIds.clear();
        this.recoveryAttempts = new Map();
        let browserIds = this.state.browserIds.filter(id => !this.blockedBrowserIds.has(id));
        const { videoUrl, muted, proxySource, proxyApiUrl, proxyTier } = this.state;
        const current = () => this.isCurrent(generation) && this.state.cycleNumber === cycleNumber && !signal.aborted;
        this.state = {
            ...this.state,
            cycleInProgress: true,
            cycleNumber,
            fetchedProxies: 0,
            checkedProxies: 0,
            totalProxies: 0,
            liveProxies: 0,
            assignedBrowsers: this.blockedBrowserIds.size,
            retainedBrowsers: 0,
            replacedBrowsers: 0,
            lastCycleStartedAt: new Date().toISOString(),
            lastError: undefined
        };
        this.emitState();
        let timedOut = false;
        const setupTimeoutMs = Math.min(300_000, Math.max(60_000, Math.ceil(browserIds.length / 3) * 10_000));
        const watchdog = setTimeout(() => {
            if (!current()) return;
            timedOut = true;
            controller.abort();
            this.proxyManager.cancelCurrentFetch();
            for (const id of browserIds) {
                try { this.browserManager.cancelMeasurementSession(id); } catch { /* A workspace may have closed. */ }
            }
        }, setupTimeoutMs);
        try {
            const rotationStates = new Map(this.state.browserIds.map(id => [id, this.browserManager.getProxyRotationState(id)]));
            for (const [id, health] of rotationStates) {
                if (health.captchaSeen) {
                    if (explicit) retryingBlockedIds.add(id);
                    else this.blockedBrowserIds.add(id);
                }
            }
            browserIds = browserIds.filter(id => !this.blockedBrowserIds.has(id));
            const belongsToSelectedTier = proxy => !proxyTier ||
                (0, ProxyTiers_1.matchesProxyTier)(proxy.countryCode, proxyTier);
            const heldReservations = [...this.blockedBrowserIds].map(browserId => ({
                browserId, proxy: rotationStates.get(browserId)?.proxy
            })).filter(assignment => assignment.proxy);
            const retained = cycleNumber > 1 ? browserIds.filter(id => {
                const health = rotationStates.get(id);
                return health.proxy && belongsToSelectedTier(health.proxy) &&
                    (retryingBlockedIds.has(id) || health.youtubeReached && !health.captchaSeen && !health.failed);
            }).map(browserId => ({ browserId, proxy: rotationStates.get(browserId).proxy, retained: true })) : [];
            const retainedIds = new Set(retained.map(assignment => assignment.browserId));
            const replacementIds = browserIds.filter(id => !retainedIds.has(id));
            const failedProxies = cycleNumber > 1
                ? replacementIds.map(id => rotationStates.get(id).proxy)
                    .filter(proxy => proxy && belongsToSelectedTier(proxy)) : [];
            this.state = { ...this.state, liveProxies: retained.length,
                assignedBrowsers: retained.length + heldReservations.length, retainedBrowsers: retained.length };
            this.emitState();
            const failures = [], cleanupFailedIds = new Set();
            // Stop outgoing work before navigation and per-browser data clearing.
            for (const id of browserIds) {
                if (!current()) return;
                this.browserManager.cancelMeasurementSession(id);
                this.browserManager.setBrowserKeepAlive(id, false, false);
            }
            let nextBrowser = 0;
            const cleanBrowser = async () => {
                while (nextBrowser < browserIds.length && current()) {
                    const id = browserIds[nextBrowser++];
                    try {
                        if (!retainedIds.has(id)) {
                            await waitForPreparation(this.browserManager.assignProxy(id, null), 15_000, signal,
                                `Browser ${id} proxy reset timed out before the next cycle.`);
                        }
                        if (!current()) return;
                        await waitForPreparation(this.browserManager.prepareCycleDocument(id, signal), 15_000, signal,
                            `Browser ${id} page preparation timed out before the next cycle.`);
                    } catch (error) {
                        if (!current()) throw error;
                        cleanupFailedIds.add(id);
                        failures.push(error);
                        this.emit('playbackResult', { cycleNumber, result: { browserId: id,
                            videoUrl: this.state.videoAssignments?.[id] || videoUrl,
                            status: 'error', error: error.message, message: error.message, ranAt: new Date().toISOString() } });
                    }
                }
            };
            try {
                await Promise.all(Array.from({ length: Math.min(2, browserIds.length) }, cleanBrowser));
            } catch (error) { controller.abort(); throw error; }
            if (!current()) {
                if (timedOut) throw new Error('Playback cycle setup timed out.');
                return;
            }
            const startAssignments = async assignments => {
                const results = await Promise.all(assignments.map(assignment => this.enqueueAssignment(generation, cycleNumber,
                    assignment, this.state.videoAssignments?.[assignment.browserId] || videoUrl, muted, signal)));
                failures.push(...results.filter(Boolean));
            };
            // Healthy slots reopen even while the provider is unavailable.
            await startAssignments(retained.filter(assignment => !cleanupFailedIds.has(assignment.browserId)));
            if (!current()) {
                if (timedOut) throw new Error('Playback cycle setup timed out.');
                return;
            }
            const assignments = [];
            const preparedReplacementIds = replacementIds.filter(id => !cleanupFailedIds.has(id));
            const replacementSet = new Set(preparedReplacementIds);
            const getReservations = () => this.state.browserIds.filter(id => !replacementSet.has(id)).map(browserId => ({
                browserId, proxy: this.proxyManager.getAssignment
                    ? this.proxyManager.getAssignment(browserId) : this.browserManager.getProxyRotationState(browserId).proxy
            })).filter(assignment => assignment.proxy);
            if (preparedReplacementIds.length) await waitForPreparation(this.proxyManager.fetchAssignDirect(preparedReplacementIds, (assignment) => {
                if (current()) assignments.push(assignment);
            }, (checked, total, working, assigned, fetched) => {
                if (!current()) return;
                this.state = {
                    ...this.state,
                    fetchedProxies: fetched,
                    checkedProxies: checked,
                    totalProxies: total,
                    liveProxies: working + retained.length,
                    assignedBrowsers: assigned + getReservations().length,
                    replacedBrowsers: assigned
                };
                this.emitState();
            }, { source: proxySource, endpoint: proxyApiUrl, tier: proxyTier,
                retainedAssignments: getReservations(), getRetainedAssignments: getReservations, failedProxies }),
            setupTimeoutMs, signal, 'Proxy provider request timed out.');
            await startAssignments(assignments);
            if (!current()) {
                if (timedOut) throw new Error('Playback cycle setup timed out.');
                return;
            }
            if (failures.length) throw failures[0];
            if (preparedReplacementIds.length && !assignments.some(assignment => assignment.proxy))
                throw new Error('The proxy source returned no assignment for the available browsers.');
            this.retryAttempts = 0;
            this.state = {
                ...this.state,
                cycleInProgress: false,
                lastCycleCompletedAt: new Date().toISOString(),
                retryAttempt: 0
            };
            this.emitState();
            Logger_1.logger.info('application', `Playback cycle ${cycleNumber} setup complete: ${this.state.liveProxies} available, ` +
                `${this.state.assignedBrowsers}/${browserIds.length} browser(s) assigned.`);
        }
        catch (err) {
            if (!this.isCurrent(generation)) return;
            const error = timedOut ? new Error('Playback cycle setup timed out.') : err;
            const restarting = this.pendingExplicitCycle;
            this.state = {
                ...this.state,
                cycleInProgress: false,
                lastCycleCompletedAt: new Date().toISOString(),
                lastError: restarting ? undefined : error.message
            };
            if (!restarting) {
                this.pendingCycle = false;
                this.retryAttempts++;
                this.state = { ...this.state, retryAttempt: this.retryAttempts };
                if (this.retryAttempts < 3) {
                    this.retryTimer = setTimeout(() => {
                        this.retryTimer = null;
                        if (this.isCurrent(generation)) void this.requestCycle();
                    }, 1_000 * 2 ** (this.retryAttempts - 1));
                } else {
                    this.state = { ...this.state, nextCycleAt: undefined,
                        lastError: `${error.message} Automatic retries paused after 3 attempts. Use Run Now to retry.` };
                }
            }
            this.emitState();
            Logger_1.logger.warn('application', `Playback cycle ${cycleNumber} failed: ${error.message}`);
        }
        finally {
            clearTimeout(watchdog);
            if (this.isCurrent(generation) && this.state.cycleNumber === cycleNumber && this.state.cycleInProgress) {
                this.state = { ...this.state, cycleInProgress: false };
                this.emitState();
            }
            if (this.isCurrent(generation) && this.pendingCycle) {
                const explicit = this.pendingExplicitCycle;
                this.pendingCycle = false;
                this.pendingExplicitCycle = false;
                void this.requestCycle(explicit);
            }
        }
    }
    enqueueAssignment(generation, cycleNumber, assignment, videoUrl, muted, signal) {
        return new Promise(resolve => {
            this.assignmentQueue.push({ generation, cycleNumber, assignment, videoUrl, muted, signal, resolve });
            this.drainAssignments();
        });
    }
    drainAssignments() {
        while (this.assignmentActive < 3 && this.assignmentQueue.length) {
            const work = this.assignmentQueue.shift();
            if (!this.isCurrent(work.generation) || this.state.cycleNumber !== work.cycleNumber || work.signal.aborted) {
                work.resolve();
                continue;
            }
            this.assignmentActive++;
            Promise.resolve(this.handleAssignment(work.generation, work.cycleNumber, work.assignment,
                work.videoUrl, work.muted, work.signal)).then(work.resolve, work.resolve).finally(() => {
                this.assignmentActive--;
                this.drainAssignments();
            });
        }
    }
    replaceFailedAssignment(generation, cycleNumber, browserId, proxy, videoUrl, signal) {
        if (!this.isCurrent(generation) || this.state.cycleNumber !== cycleNumber || signal.aborted) return;
        if (this.proxyManager.getAssignment && this.proxyManager.getAssignment(browserId) !== proxy) return;
        const exhausted = (this.recoveryAttempts.get(browserId) || 0) >= 3;
        const replacement = this.proxyManager.replaceFailedAssignment?.(browserId, proxy, !exhausted);
        if (replacement?.proxy) return replacement;
        const message = exhausted ? `Browser ${browserId} reached the three-proxy retry limit. Retry at the next scheduled cycle or use Run Now.` :
            `Browser ${browserId} has no unused proxy available. Retry at the next scheduled cycle or use Run Now.`;
        this.state = { ...this.state, lastError: message,
            assignedBrowsers: Math.max(0, this.state.assignedBrowsers - 1) };
        this.emitState();
        this.emit('playbackResult', { cycleNumber, result: { browserId, videoUrl,
            status: 'error', code: 'proxy-pool-exhausted', message, error: message, ranAt: new Date().toISOString() } });
        return { browserId, proxy: null, removeFailed: true };
    }
    async handleAssignment(generation, cycleNumber, assignment, videoUrl, muted, signal) {
        const current = () => this.isCurrent(generation) && this.state.cycleNumber === cycleNumber && !signal.aborted;
        if (!current()) return;
        const { browserId, proxy } = assignment;
        try {
            if (assignment.removeFailed) {
                await waitForPreparation(this.browserManager.assignProxy(browserId, null), 15_000, signal,
                    `Browser ${browserId} failed proxy removal timed out.`);
                return;
            }
            if (!proxy) return;
            this.recoveryAttempts.set(browserId, (this.recoveryAttempts.get(browserId) || 0) + 1);
            if (assignment.retained) this.browserManager.beginProxyCycle(browserId);
            else await waitForPreparation(this.browserManager.assignProxy(browserId, proxy), 15_000, signal,
                `Browser ${browserId} proxy assignment timed out.`);
            if (!current()) return;
            this.browserManager.setBrowserKeepAlive(browserId, false, false);
            const health = this.browserManager.checkProxyHealth
                ? await waitForPreparation(this.browserManager.checkProxyHealth(browserId, videoUrl, { signal }), 20_000,
                    signal, `Browser ${browserId} proxy health check timed out.`) : null;
            if (!current()) return;
            if (health?.status === 'failed') {
                const error = new Error(health.message || `Browser ${browserId} could not reach the selected video.`);
                error.code = health.code;
                error.healthCheck = true;
                throw error;
            }
            if (health?.status === 'interaction-required') this.blockedBrowserIds.add(browserId);
            await waitForPreparation(this.browserManager.startYouTubePlayback(browserId, {
                videoUrl, muted, signal,
                onState: state => {
                    if (!current()) return;
                    if (this.proxyManager.getAssignment && this.proxyManager.getAssignment(browserId) !== proxy) return;
                    if (state.status === 'interaction-required') {
                        this.blockedBrowserIds.add(browserId);
                        this.emitState();
                    }
                    this.emit('playbackResult', { cycleNumber, result: {
                        ...state, browserId, videoUrl, ranAt: state.observedAt || new Date().toISOString()
                    }});
                    if (['proxy-authentication', 'proxy-transport-error'].includes(state.code) && !this.blockedBrowserIds.has(browserId)) {
                        const key = `${generation}:${cycleNumber}:${browserId}:${proxy.id || `${proxy.host}:${proxy.port}`}`;
                        if (this.recoveringBrowsers.has(key)) return;
                        this.recoveringBrowsers.add(key);
                        const replacement = this.replaceFailedAssignment(generation, cycleNumber, browserId, proxy, videoUrl, signal);
                        if (replacement) void this.enqueueAssignment(generation, cycleNumber, replacement, videoUrl, muted, signal)
                            .finally(() => this.recoveringBrowsers.delete(key));
                        else this.recoveringBrowsers.delete(key);
                    }
                }
            }), 15_000, signal, `Browser ${browserId} playback setup timed out.`);
            if (current() && health?.status === 'interaction-required') {
                this.emitState();
                this.emit('playbackResult', { cycleNumber, result: { ...health,
                    browserId, videoUrl, ranAt: health.checkedAt || new Date().toISOString() } });
            }
        } catch (error) {
            if (!current()) return;
            this.emit('playbackResult', { cycleNumber, result: {
                browserId, videoUrl, status: 'error', error: error.message,
                code: error.code, message: error.message, ranAt: new Date().toISOString()
            }});
            if (['proxy-authentication', 'proxy-transport-error'].includes(error.code)) {
                const replacement = this.replaceFailedAssignment(generation, cycleNumber, browserId, proxy, videoUrl, signal);
                if (replacement) return this.handleAssignment(generation, cycleNumber, replacement, videoUrl, muted, signal);
                return;
            }
            if (error.healthCheck) {
                this.state = { ...this.state, lastError: error.message };
                this.emitState();
                return;
            }
            return error;
        }
    }
    isCurrent(generation) {
        return this.state.running && generation === this.generation;
    }
}
exports.YouTubeAutomationManager = YouTubeAutomationManager;
