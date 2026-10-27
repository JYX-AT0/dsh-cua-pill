import { createRequire } from 'node:module';

const { contextBridge, ipcRenderer } = createRequire(import.meta.url)('electron');

contextBridge.exposeInMainWorld('pillApi', {
  on: callback => ipcRenderer.on('pill', (_event, message) => callback(message)),
  hidden: () => ipcRenderer.send('pill-hidden'),
});
