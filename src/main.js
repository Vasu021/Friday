// Friday — main process.
// Phase 0: only a preflight window that confirms the environment is set up.
// Windows, hotkeys and orchestration arrive in Phase 1 (see docs/PLAN.md §9).

const path = require('node:path');
const { app, BrowserWindow, ipcMain, systemPreferences, shell } = require('electron');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

/** @type {BrowserWindow | null} */
let chatWindow = null;

function createChatWindow() {
  chatWindow = new BrowserWindow({
    width: 420,
    height: 620,
    resizable: true,
    title: 'Friday',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  chatWindow.loadFile(path.join(__dirname, 'chat', 'chat.html'));
  chatWindow.on('closed', () => {
    chatWindow = null;
  });
}

// Reports what Phase 0 needs: a key, and the two macOS permissions.
ipcMain.handle('friday:preflight', () => ({
  electron: process.versions.electron,
  node: process.versions.node,
  platform: process.platform,
  hasApiKey: Boolean(process.env.GEMINI_API_KEY),
  screen: systemPreferences.getMediaAccessStatus('screen'),
  microphone: systemPreferences.getMediaAccessStatus('microphone'),
}));

// Opens the relevant pane of System Settings so the user can grant a permission.
ipcMain.handle('friday:open-settings', (_event, pane) => {
  const panes = {
    screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  };
  if (panes[pane]) return shell.openExternal(panes[pane]);
});

app.whenReady().then(() => {
  createChatWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createChatWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
