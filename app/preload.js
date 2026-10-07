const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('formLotteryAPI', {
  login: () => ipcRenderer.invoke('google-login'),
  listForms: () => ipcRenderer.invoke('list-forms'),
  readForm: (formId) => ipcRenderer.invoke('read-form', formId),
  readResponses: (formId) => ipcRenderer.invoke('read-responses', formId),
  logout: () => ipcRenderer.invoke('logout'),
  hasToken: () => ipcRenderer.invoke('has-token'),
  openV138Reference: () => ipcRenderer.invoke('open-v138-reference'),
  onStatus: (callback) => ipcRenderer.on('app-status', (_event, payload) => callback(payload))
});
