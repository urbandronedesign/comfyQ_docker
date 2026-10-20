// Gives the console page the token its local server expects (see main.js).
// Nothing else of Electron or Node reaches the page.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('comfyqConsole', {
    token: ipcRenderer.sendSync('console-token'),
    app: true,
    // Updates, shown in the page: the state now, its changes as they happen,
    // and the two things the page can ask for.
    updates: {
        get: () => ipcRenderer.invoke('update-get'),
        onStatus: (cb) => { ipcRenderer.on('update-status', (_e, s) => cb(s)); },
        check: () => ipcRenderer.send('update-check'),
        install: () => ipcRenderer.send('update-install'),
    },
    // Only answered when the app runs under its test (main.js).
    testCloseWindow: () => ipcRenderer.send('test-close-window'),
});
