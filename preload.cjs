const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('companion', {
  beginPetDrag: () => ipcRenderer.send('pet:drag-start'),
  movePetDrag: () => ipcRenderer.send('pet:drag-move'),
  endPetDrag: () => ipcRenderer.send('pet:drag-end'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  setWindowMode: (mode) => ipcRenderer.invoke('window:set-mode', mode),
  toggleWindow: () => ipcRenderer.invoke('window:toggle'),
  chooseFolder: () => ipcRenderer.invoke('organizer:choose'),
  scanFolder: () => ipcRenderer.invoke('organizer:scan'),
  organizeFolder: () => ipcRenderer.invoke('organizer:run'),
  getReachChannels: () => ipcRenderer.invoke('agent-reach:channels'),
  queryReach: (input) => ipcRenderer.invoke('agent-reach:query', input),
  openReachUrl: (url) => ipcRenderer.invoke('agent-reach:open-url', url),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  login: (input) => ipcRenderer.invoke('account:login', input),
  register: (input) => ipcRenderer.invoke('account:register', input),
  logout: () => ipcRenderer.invoke('account:logout'),
  saveSharedSettings: (settings) => ipcRenderer.invoke('admin:save-settings', settings),
  createInvite: () => ipcRenderer.invoke('admin:create-invite'),
  ask: (prompt) => ipcRenderer.invoke('assistant:ask', prompt),
  importInteractionVoice: () => ipcRenderer.invoke('voice:import'),
  getInteractionVoice: () => ipcRenderer.invoke('voice:get'),
  removeInteractionVoice: () => ipcRenderer.invoke('voice:remove'),
  notify: (payload) => ipcRenderer.invoke('notification:show', payload),
  sendFeedback: (text) => ipcRenderer.invoke('feedback:email', text),
  onWindowModeChanged: (callback) => {
    ipcRenderer.on('window:mode-changed', (_event, mode) => callback(mode));
  }
});
