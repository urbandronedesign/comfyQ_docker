// Gives the console page the token its local server expects (see main.js).
// Nothing else of Electron or Node reaches the page.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('comfyqConsole', {
    token: ipcRenderer.sendSync('console-token'),
    app: true,
});
