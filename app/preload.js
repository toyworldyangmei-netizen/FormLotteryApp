const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('formLotteryAPI', {
  login: () => ipcRenderer.invoke('google-login'),
  restoreAuth: () => ipcRenderer.invoke('restore-auth'),
  listForms: () => ipcRenderer.invoke('list-forms'),
  readForm: (formId) => ipcRenderer.invoke('read-form', formId),
  readResponses: (formId) => ipcRenderer.invoke('read-responses', formId),
  getAccount: () => ipcRenderer.invoke('get-account'),
  logout: () => ipcRenderer.invoke('logout'),
  hasToken: () => ipcRenderer.invoke('has-token'),
  onStatus: (callback) => ipcRenderer.on('app-status', (_event, payload) => callback(payload))
});
