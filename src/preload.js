// Safe bridge between the main process and the renderer windows.
// One narrow function per capability -- ipcRenderer itself is never exposed.

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, callback) => {
  ipcRenderer.on(channel, (_event, payload) => callback(payload));
};

contextBridge.exposeInMainWorld('friday', {
  // --- chat -> main ---
  ask: (payload) => ipcRenderer.invoke('friday:ask', payload),
  transcribe: (payload) => ipcRenderer.invoke('friday:transcribe', payload),
  getSettings: () => ipcRenderer.invoke('friday:get-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('friday:save-settings', patch),
  openSettings: (pane) => ipcRenderer.invoke('friday:open-settings', pane),

  // Provider setup. Keys travel one way only: in.
  getProviders: () => ipcRenderer.invoke('friday:get-providers'),
  listModels: (provider) => ipcRenderer.invoke('friday:list-models', provider),
  setProvider: (config) => ipcRenderer.invoke('friday:set-provider', config),
  forgetKey: (provider) => ipcRenderer.invoke('friday:forget-key', provider),
  testProvider: () => ipcRenderer.invoke('friday:test-provider'),
  openExternal: (url) => ipcRenderer.invoke('friday:open-external', url),

  // The floating ball.
  orbExpand: (expanded) => ipcRenderer.send('friday:orb-expand', expanded),
  orbMove: (delta) => ipcRenderer.send('friday:orb-move', delta),
  togglePanel: () => ipcRenderer.send('friday:toggle-panel'),
  askFromOrb: (question) => ipcRenderer.send('friday:ask-from-orb', question),
  onOrbStatus: (fn) => ipcRenderer.on('friday:orb-status', (_event, payload) => fn(payload)),
  onSpeak: (fn) => ipcRenderer.on('friday:speak', (_event, reply) => fn(reply)),
  setMode: (mode) => ipcRenderer.send('friday:set-mode', mode),
  clearScreen: () => ipcRenderer.send('friday:clear'),
  togglePause: () => ipcRenderer.send('friday:toggle-pause'),
  speechEnded: (autoClearAfterMs) => ipcRenderer.send('friday:speech-ended', autoClearAfterMs),
  pointerState: (state) => ipcRenderer.send('friday:pointer-state', state),

  // --- main -> chat ---
  onPauseChanged: (cb) => on('friday:pause-changed', cb),
  onToggleMic: (cb) => on('friday:toggle-mic', cb),
  onStopSpeaking: (cb) => on('friday:stop-speaking', cb),
  onNotice: (cb) => on('friday:notice', cb),
  // A monitor was plugged in, unplugged or rearranged.
  onDisplaysChanged: (cb) => on('friday:displays-changed', cb),

  // --- main -> overlay ---
  onDraw: (cb) => on('friday:draw', cb),
  onClear: (cb) => on('friday:clear', cb),
  onPointerState: (cb) => on('friday:pointer-state', cb),
  onWatching: (cb) => on('friday:watching', cb),
  onSkin: (cb) => on('friday:skin', cb),
  onSpeechEnd: (cb) => on('friday:speech-end', cb),
});
