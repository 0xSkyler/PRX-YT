"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerIpc = registerIpc;
const electron_1 = require("electron");
const ipc_1 = require("../../shared/types/ipc");
/**
 * Narrow renderer API. Research pages never receive this bridge. Legacy
 * Keep Alive channels remain registered for compatibility but cannot run in
 * the active YouTube workflow.
 */
function registerIpc(deps) {
    const { browserManager, automationManager } = deps;
    electron_1.ipcMain.handle(ipc_1.IPC_CHANNELS.browserGetAll, () => browserManager.getAll());
    electron_1.ipcMain.handle(ipc_1.IPC_CHANNELS.browserSetBounds, (_event, id, bounds) => browserManager.setBounds(id, bounds));
    const allowLegacy = () => {
        if (browserManager.workflow === 'youtube') throw new Error('Keep Alive navigation is unavailable in PRX-YT.');
    };
    electron_1.ipcMain.handle(ipc_1.IPC_CHANNELS.browserSetKeepAlive, (_event, id, enabled) => { allowLegacy(); return browserManager.setBrowserKeepAlive(id, enabled, enabled); });
    electron_1.ipcMain.handle(ipc_1.IPC_CHANNELS.browserSetKeepAliveAll, (_event, enabled) => { allowLegacy(); return browserManager.setKeepAliveAll(enabled, enabled); });
    electron_1.ipcMain.handle(ipc_1.IPC_CHANNELS.browserPlayVideo, (_event, id) => browserManager.playVideo(id));
    electron_1.ipcMain.handle(ipc_1.IPC_CHANNELS.browserPauseVideo, (_event, id) => browserManager.pauseVideo(id));
    electron_1.ipcMain.handle(ipc_1.IPC_CHANNELS.browserSetVideoMuted, (_event, id, muted) => browserManager.setVideoMuted(id, muted));
    electron_1.ipcMain.handle(ipc_1.IPC_CHANNELS.automationGetState, () => automationManager.getState());
    electron_1.ipcMain.handle(ipc_1.IPC_CHANNELS.automationConfigureProxy, (_event, config) => automationManager.configureProxy(config));
    electron_1.ipcMain.handle(ipc_1.IPC_CHANNELS.automationStart, (_event, config) => automationManager.start(config));
    electron_1.ipcMain.handle(ipc_1.IPC_CHANNELS.automationStop, () => automationManager.stop());
    electron_1.ipcMain.handle(ipc_1.IPC_CHANNELS.automationRunNow, () => automationManager.runNow());
    const listeners = [
        [browserManager, 'stateChanged', ipc_1.IPC_CHANNELS.browserStateChanged],
        [automationManager, 'stateChanged', ipc_1.IPC_CHANNELS.automationStateChanged],
        [automationManager, 'seoResult', ipc_1.IPC_CHANNELS.automationSeoResult],
        [automationManager, 'playbackResult', ipc_1.IPC_CHANNELS.automationPlaybackResult]
    ].map(([emitter, event, channel]) => {
        const listener = (payload) => {
            for (const win of electron_1.BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
            }
        };
        emitter.on(event, listener);
        return [emitter, event, listener];
    });
    return () => {
        for (const [emitter, event, listener] of listeners) emitter.removeListener(event, listener);
        for (const channel of [ipc_1.IPC_CHANNELS.browserGetAll, ipc_1.IPC_CHANNELS.browserSetBounds,
            ipc_1.IPC_CHANNELS.browserSetKeepAlive, ipc_1.IPC_CHANNELS.browserSetKeepAliveAll,
            ipc_1.IPC_CHANNELS.browserPlayVideo, ipc_1.IPC_CHANNELS.browserPauseVideo, ipc_1.IPC_CHANNELS.browserSetVideoMuted,
            ipc_1.IPC_CHANNELS.automationGetState, ipc_1.IPC_CHANNELS.automationConfigureProxy, ipc_1.IPC_CHANNELS.automationStart,
            ipc_1.IPC_CHANNELS.automationStop, ipc_1.IPC_CHANNELS.automationRunNow]) electron_1.ipcMain.removeHandler(channel);
    };
}
//# sourceMappingURL=registerIpc.js.map
