'use strict';
// Sandboxed research workspace preload. Only the inherited per-cycle renderer
// cache handshake is needed. YouTube controls and consent stay with the user.
const { ipcRenderer, webFrame } = require('electron');
ipcRenderer.on('dom:clear-renderer-cache', (_event, requestId) => {
    try {
        webFrame.clearCache();
        ipcRenderer.send('dom:renderer-cache-cleared', { requestId });
    } catch (error) {
        ipcRenderer.send('dom:renderer-cache-cleared', { requestId, error: error.message });
    }
});
