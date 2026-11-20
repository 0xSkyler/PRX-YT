"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const node_path_1 = __importDefault(require("node:path"));
const BrowserManager_1 = require("./BrowserManager");
const { BrowserPreparation } = require("./BrowserPreparation");
const ProxyManager_1 = require("./ProxyManager");
const { YouTubeAutomationManager } = require("./YouTubeAutomationManager");
const registerIpc_1 = require("./ipc/registerIpc");
const Logger_1 = require("./Logger");
const browser_1 = require("../shared/types/browser");
const os = require('node:os');
const { ResourceWatchdog } = require('./ResourceWatchdog');
// Recovered renderer assets are available in both source and packaged runs.
const isDev = process.env.NODE_ENV === 'development';
electron_1.app.setName('PRX-YT');
if (process.platform === 'linux' && process.env.PRX_YT_SOFTWARE_RENDERING === '1') {
    electron_1.app.disableHardwareAcceleration();
}
let mainWindow = null;
let browserManager;
let proxyManager;
let automationManager;
let activeBrowserCount = 10;
let startupWork = Promise.resolve();
let shuttingDown = false;
let shutdownComplete = false;
let disposeIpc = () => {};
let browserPreparation;
let resourceTimer;
let resourceWatchdog;
async function createWindowShell() {
    mainWindow = new electron_1.BrowserWindow({
        width: 1600,
        height: 1000,
        minWidth: 1050,
        minHeight: 720,
        backgroundColor: '#0f1115',
        title: 'PRX-YT',
        show: false,
        webPreferences: {
            preload: node_path_1.default.join(__dirname, '../preload/preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true
        }
    });
    // Electron's BrowserView adds one closed listener per attached view. Allow
    // the existing 100-workspace maximum plus shell lifecycle listeners without
    // suppressing warnings globally; destroyBrowser still removes each view.
    mainWindow.setMaxListeners(browser_1.BROWSER_IDS.length + 10);
    browserManager.attachWindow(mainWindow);
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
    if (process.platform !== 'darwin') mainWindow.on('close', (event) => {
        if (!shutdownComplete) {
            event.preventDefault();
            electron_1.app.quit();
        }
    });
}
async function loadRenderer() {
    if (!mainWindow)
        throw new Error('Main window is not available.');
    if (isDev) {
        await mainWindow.loadURL('http://localhost:5173');
    }
    else {
        await mainWindow.loadFile(node_path_1.default.join(__dirname, '../renderer/index.html'));
    }
    mainWindow.show();
}
async function ensureBrowserCount(count, options) {
    if (shuttingDown) return [];
    if (resourceWatchdog?.busy || resourceWatchdog?.pressured)
        throw new Error('Memory is still under pressure. Wait for recovery and reduce browser count before Start.');
    const ids = await browserPreparation.ensure(count, options);
    activeBrowserCount = ids.length;
    return ids;
}
async function bootstrap() {
    proxyManager = new ProxyManager_1.ProxyManager();
    await proxyManager.init();
    browserManager = new BrowserManager_1.BrowserManager({ workflow: 'youtube' });
    browserPreparation = new BrowserPreparation(browserManager);
    activeBrowserCount = 10;
    automationManager = new YouTubeAutomationManager(proxyManager, browserManager, ensureBrowserCount);
    resourceWatchdog = new ResourceWatchdog({
        log: message => Logger_1.logger.info('application', message),
        onPressure: async message => {
            Logger_1.logger.warn('application', message);
            automationManager.pauseForResourcePressure(message);
            // Destroy only native views; retain session profiles and allow Start
            // to recreate them through the normal preparation/disposal barriers.
            await Promise.allSettled(browserManager.getAll().map(({ id }) => browserManager.destroyBrowser(id)));
        }
    });
    resourceTimer = setInterval(() => {
        if (shuttingDown) return;
        const appBytes = electron_1.app.getAppMetrics().reduce((bytes, metric) =>
            bytes + (metric.memory.privateBytes ?? metric.memory.workingSetSize ?? 0) * 1024, 0);
        void resourceWatchdog.sample({ totalBytes: os.totalmem(), freeBytes: os.freemem(), appBytes });
    }, 15_000);
    resourceTimer.unref?.();
    // Register IPC before the renderer loads. The previous order allowed the
    // React app to call automation:getState before a handler existed.
    disposeIpc = (0, registerIpc_1.registerIpc)({
        browserManager,
        automationManager
    });
    // Build the native shell first, create blank isolated browser sessions,
    // and only then show React. This removes the startup race where the user
    // could click Start while browser creation was still in flight.
    await createWindowShell();
    await ensureBrowserCount(activeBrowserCount);
    if (shuttingDown) return;
    await loadRenderer();
    Logger_1.logger.info('application', 'PRX-YT ready.');
}
electron_1.app.whenReady().then(() => {
    electron_1.session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    startupWork = bootstrap().catch((err) => {
        Logger_1.logger.error('application', `Fatal startup error: ${err.stack ?? err}`);
        electron_1.app.quit();
    });
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0) {
            void (async () => {
                await createWindowShell();
                await loadRenderer();
            })();
        }
    });
});
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin')
        electron_1.app.quit();
});
electron_1.app.on('before-quit', (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(resourceTimer);
    automationManager?.stop();
    // A hung Chromium storage operation must not prevent shutdown forever.
    const deadline = setTimeout(() => electron_1.app.exit(0), 10_000);
    deadline.unref();
    void (async () => {
        await startupWork;
        await browserPreparation?.queue.catch(() => {});
        automationManager?.stop();
        disposeIpc();
        await browserManager?.destroyAll();
        await Logger_1.logger.close();
    })().catch((err) => {
        console.error('PRX-YT shutdown failed:', err);
    }).finally(() => {
        clearTimeout(deadline);
        shutdownComplete = true;
        electron_1.app.quit();
    });
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => electron_1.app.quit());
process.on('uncaughtException', (err) => {
    Logger_1.logger.error('application', `Uncaught exception: ${err.stack ?? err.message}`);
});
process.on('unhandledRejection', (reason) => {
    Logger_1.logger.error('application', `Unhandled rejection: ${String(reason)}`);
});
//# sourceMappingURL=main.js.map
