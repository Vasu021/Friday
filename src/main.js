// Friday -- main process. Owns the windows, the hotkeys, and the loop that
// turns a question into speech plus drawings on the overlay.

const fs = require('node:fs');
const path = require('node:path');
const {
  app, BrowserWindow, ipcMain, globalShortcut, screen,
  systemPreferences, shell,
} = require('electron');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { Capture } = require('./capture');
const { AI } = require('./ai');
const { Voice } = require('./voice');
const secrets = require('./secrets');
const errors = require('./errors');
const { describe } = errors;
const { resolveProvider, publicProviders } = require('./providers');

const DEV = process.argv.includes('--dev');
const PRELOAD = path.join(__dirname, 'preload.js');
const SKINS_DIR = path.join(__dirname, '..', 'skins');
const MAX_HISTORY = 12;

const HOTKEYS = {
  talk: 'Alt+Space',
  clear: 'Alt+C',
  pause: 'Alt+P',
  panel: 'Alt+J',
  stop: 'Alt+.',
};

let chatWindow = null;
let quitting = false;
let orbWindow = null;
let orbState = 'ready';
let orbText = 'Ready';
/** @type {Map<number, BrowserWindow>} display id -> its overlay */
const overlays = new Map();

let capture = null;
let ai = null;
let voice = null;

let mode = 'guide';
let paused = false;
let overlayHasContent = false;
let activeDisplayId = null;
const history = [];

const settings = {
  speak: true,
  // null means "let the renderer pick the best voice installed".
  voice: null,
  intervalMs: 2500,
  skin: 'professor',
  blocklist: [],
  // Which screen the AI sees. null = follow the cursor.
  displayId: null,
  // Where the floating ball sits. null = bottom-right of the main display.
  orbPosition: null,
  // Which AI answers. Chosen in the setup UI, not in .env. The key itself
  // lives encrypted in secrets.js and never appears here.
  provider: null,
  // Chosen model per provider id, so switching back and forth remembers both.
  models: {},
  ollamaHost: null,
};

// ---------------------------------------------------------------- provider

/** .env is still honoured as a fallback so existing setups keep working. */
function envKeyFor(provider) {
  const fromEnv = {
    gemini: process.env.GEMINI_API_KEY,
    claude: process.env.ANTHROPIC_API_KEY,
    openai: process.env.OPENAI_API_KEY,
  };
  return fromEnv[provider] || null;
}

/** Everything ai.configure() needs, assembled from settings + keychain + .env. */
function providerConfig() {
  const provider = settings.provider || process.env.AI_PROVIDER || 'gemini';
  const spec = resolveProvider(provider);
  const model = settings.models[provider] || spec.defaultModel;

  return {
    provider,
    apiKey: secrets.getKey(provider) || envKeyFor(provider),
    model,
    ollamaHost: settings.ollamaHost || process.env.OLLAMA_HOST || spec.defaultHost,
    ollamaModel: provider === 'ollama' ? model : settings.models.ollama,
  };
}

/** Whether a key is on file for a provider, from either source. */
function providerHasKey(id) {
  return secrets.hasKey(id) || Boolean(envKeyFor(id));
}

/** Labels for the screen picker: name, resolution, and which one is main. */
function describeDisplays() {
  const primaryId = screen.getPrimaryDisplay().id;

  return screen.getAllDisplays().map((display, index) => {
    const name = display.label || `Display ${index + 1}`;
    const { width, height } = display.size;
    return {
      id: display.id,
      label: `${name} — ${width}×${height}${display.id === primaryId ? ' (main)' : ''}`,
      primary: display.id === primaryId,
    };
  });
}

/** The pinned screen was unplugged; fall back to the cursor and say so. */
function handleDisplayLost() {
  settings.displayId = null;
  persistSettings();
  if (chatWindow) {
    chatWindow.webContents.send(
      'friday:notice',
      'That screen was disconnected, so Friday is following your cursor again.',
    );
  }
}

// ---------------------------------------------------------------- settings

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(fs.readFileSync(settingsPath(), 'utf8')));
  } catch {
    // First run, or a corrupted file: the defaults above are fine.
  }
}

function persistSettings() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (error) {
    console.error('Could not save settings:', error.message);
  }
}

function availableSkins() {
  try {
    return fs
      .readdirSync(SKINS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(SKINS_DIR, entry.name, 'skin.json'), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function currentSkin() {
  const skins = availableSkins();
  return skins.find((s) => s.id === settings.skin) || skins[0] || null;
}

// ---------------------------------------------------------------- windows

function createChatWindow({ showOnReady = false } = {}) {
  chatWindow = new BrowserWindow({
    width: 430,
    height: 640,
    minWidth: 360,
    minHeight: 440,
    title: 'Friday',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#131318',
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  wireDevLogging(chatWindow, 'chat');
  chatWindow.loadFile(path.join(__dirname, 'chat', 'chat.html'));
  chatWindow.once('ready-to-show', () => {
    if (showOnReady) chatWindow.show();
  });
  // Closing the panel returns Friday to the ball -- it is not a quit. The
  // window is kept alive because it owns speech synthesis, which the orb
  // relies on for questions asked without opening the panel.
  chatWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    chatWindow.hide();
  });

  chatWindow.on('closed', () => {
    chatWindow = null;
  });
}

// ---------------------------------------------------------------- the orb
//
// Friday's resting state. The window is resized to fit exactly what is
// visible -- just the ball, or the ball plus its prompt tray -- so there is
// never a transparent rectangle stealing clicks from the apps underneath.

const ORB_SIZE = 64;
const ORB_TRAY_WIDTH = 320;

/** Where the ball sits, defaulting to just above the Dock on the right. */
function orbAnchor() {
  if (settings.orbPosition) return settings.orbPosition;

  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  return { x: x + width - ORB_SIZE - 24, y: y + height - ORB_SIZE - 24 };
}

function orbBounds(expanded) {
  const anchor = orbAnchor();
  const width = expanded ? ORB_SIZE + ORB_TRAY_WIDTH : ORB_SIZE;

  // The tray grows to the left, so the ball itself never moves. Clamp so it
  // cannot open off the edge of the screen.
  const display = screen.getDisplayNearestPoint(anchor);
  const minX = display.workArea.x;
  const x = Math.max(minX, anchor.x - (width - ORB_SIZE));

  return { x, y: anchor.y, width, height: ORB_SIZE };
}

function createOrbWindow() {
  orbWindow = new BrowserWindow({
    ...orbBounds(false),
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  wireDevLogging(orbWindow, 'orb');
  orbWindow.loadFile(path.join(__dirname, 'orb', 'orb.html'));
  orbWindow.setAlwaysOnTop(true, 'floating');
  orbWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  orbWindow.once('ready-to-show', () => {
    orbWindow.showInactive();
    sendOrbStatus();
  });
  orbWindow.on('closed', () => {
    orbWindow = null;
  });
}

/** Tell the orb what to look like. Safe to call before it exists. */
function sendOrbStatus(state = orbState, text = orbText) {
  orbState = state;
  orbText = text;
  if (orbWindow && !orbWindow.isDestroyed()) {
    orbWindow.webContents.send('friday:orb-status', { state, text, watching: !paused });
  }
}

function showPanel(show) {
  if (!chatWindow) createChatWindow();
  if (!chatWindow) return;

  if (show) {
    chatWindow.show();
    chatWindow.focus();
  } else {
    chatWindow.hide();
  }
}

/** One overlay per display, each covering that display exactly. */
function createOverlay(display) {
  const overlay = new BrowserWindow({
    ...display.bounds,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    show: false,
    enableLargerThanScreen: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  wireDevLogging(overlay, `overlay:${display.id}`);
  overlay.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));

  // 'screen-saver' is the level that sits above full-screen apps.
  overlay.setAlwaysOnTop(true, 'screen-saver');
  // Clicks pass straight through to whatever is underneath.
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Keeps the overlay out of screen recordings -- including the ones Friday
  // takes of the user's screen, so the AI never sees its own drawings.
  overlay.setContentProtection(true);

  overlay.once('ready-to-show', () => {
    overlay.showInactive();          // never steal focus from the user's work
    overlay.webContents.send('friday:skin', currentSkin());
    overlay.webContents.send('friday:watching', !paused);
  });

  overlays.set(display.id, overlay);
  return overlay;
}

function syncOverlays() {
  const displays = screen.getAllDisplays();
  const live = new Set(displays.map((d) => d.id));

  for (const [id, overlay] of overlays) {
    if (!live.has(id)) {
      overlay.destroy();
      overlays.delete(id);
    }
  }

  for (const display of displays) {
    const existing = overlays.get(display.id);
    if (existing) existing.setBounds(display.bounds);
    else createOverlay(display);
  }
}

function overlayFor(displayId) {
  return overlays.get(displayId) || overlays.values().next().value || null;
}

function eachOverlay(fn) {
  for (const overlay of overlays.values()) {
    if (!overlay.isDestroyed()) fn(overlay);
  }
}

function toOverlay(channel, payload, displayId = activeDisplayId) {
  const overlay = overlayFor(displayId);
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send(channel, payload);
}

/** In --dev, surface renderer errors in the terminal instead of swallowing them. */
function wireDevLogging(window, label) {
  if (!DEV) return;
  window.webContents.on('console-message', (event) => {
    const level = ['debug', 'info', 'warning', 'error'][event.level] || event.level;
    console.log(`[${label}:${level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  window.webContents.on('preload-error', (_e, file, error) => {
    console.error(`[${label}:preload] ${file}`, error);
  });
}

function toChat(channel, payload) {
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send(channel, payload);
}

// ---------------------------------------------------------------- overlay state

function clearOverlays() {
  overlayHasContent = false;
  eachOverlay((overlay) => overlay.webContents.send('friday:clear'));
}

/**
 * Fallback for the AI-sees-its-own-drawings problem. setContentProtection
 * normally excludes the overlay from capture, but it is inconsistent across
 * macOS versions, so when there is actually something drawn we hide the
 * overlays for the duration of the grab. Skipped when the overlay is empty,
 * which is most of the time, so there is no periodic flicker.
 */
async function hideDuringCapture() {
  if (!overlayHasContent) return null;

  const hidden = [];
  eachOverlay((overlay) => {
    if (overlay.isVisible()) {
      overlay.hide();
      hidden.push(overlay);
    }
  });
  if (hidden.length === 0) return null;

  // One frame of breathing room so the compositor drops the window first.
  await new Promise((resolve) => setTimeout(resolve, 16));

  return async () => {
    for (const overlay of hidden) {
      if (!overlay.isDestroyed()) overlay.showInactive();
    }
  };
}

// ---------------------------------------------------------------- the main loop

async function handleAsk({ question, mode: requestedMode }) {
  const askMode = requestedMode || mode;

  if (!ai.configured) {
    return { error: `Friday has no key for ${ai.spec.name} yet. Open Settings (⚙) to add one.` };
  }

  let image = null;
  if (askMode !== 'chat') {
    if (paused) {
      return { error: 'Friday is paused and cannot see your screen. Press ⌥P to resume.' };
    }
    // Checked before capturing: desktopCapturer throws an error with no message
    // when the permission is missing, which is the most likely first-run
    // failure and deserves a better explanation than that.
    if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      return {
        error:
          'Friday needs Screen Recording permission. Open ⚙ Settings and click Fix ' +
          'next to Screen Recording, enable Friday, then restart the app — macOS ' +
          'only applies this permission on a fresh launch.',
      };
    }

    // Always grab a fresh frame for a question rather than reusing the timer's.
    let frame;
    try {
      frame = await capture.captureNow();
    } catch (error) {
      return { error: `Friday could not capture the screen: ${describe(error)}` };
    }
    if (!frame) {
      const reason = capture.lastSkipReason
        ? ` (${capture.lastSkipReason})`
        : ' No display was returned by the system.';
      return { error: `Friday could not capture the screen.${reason}` };
    }
    activeDisplayId = frame.display.id;
    image = capture.latestAsBase64();
  }

  toOverlay('friday:pointer-state', 'thinking');

  let reply;
  try {
    reply = await ai.ask({ question, image, history, mode: askMode });
  } catch (error) {
    toOverlay('friday:pointer-state', 'idle');
    return { error: friendlyError(error) };
  }

  history.push({ role: 'user', text: question }, { role: 'assistant', text: reply.speech });
  while (history.length > MAX_HISTORY) history.shift();

  if (reply.steps.length > 0) {
    overlayHasContent = true;
    toOverlay('friday:draw', { steps: reply.steps, auto_clear_after_ms: reply.auto_clear_after_ms });
  } else {
    toOverlay('friday:pointer-state', 'idle');
  }

  return reply;
}

/** Electron sometimes throws errors with no message; never render "undefined". */


function friendlyError(error) {
  return errors.classify(describe(error), {
    name: ai && ai.spec ? ai.spec.name : 'The AI',
    model: ai ? ai.model : null,
    provider: ai ? ai.provider : null,
    host: ai ? ai.ollamaHost : null,
  });
}


// ---------------------------------------------------------------- controls

function setPaused(next) {
  paused = next;
  capture.setPaused(paused);
  if (paused) {
    capture.stop();
    clearOverlays();
  } else {
    capture.start(settings.intervalMs);
  }
  eachOverlay((overlay) => overlay.webContents.send('friday:watching', !paused));
  toChat('friday:pause-changed', paused);
  sendOrbStatus(paused ? 'paused' : 'ready', paused ? 'Paused' : 'Ready');
}

function toggleChatPanel() {
  showPanel(!(chatWindow && chatWindow.isVisible()));
}

function registerHotkeys() {
  const bindings = [
    [HOTKEYS.talk, () => {
      if (!chatWindow) createChatWindow();
      toChat('friday:toggle-mic');
    }],
    [HOTKEYS.clear, () => clearOverlays()],
    [HOTKEYS.pause, () => setPaused(!paused)],
    [HOTKEYS.panel, () => toggleChatPanel()],
    [HOTKEYS.stop, () => toChat('friday:stop-speaking')],
  ];

  const failed = [];
  for (const [accelerator, handler] of bindings) {
    if (!globalShortcut.register(accelerator, handler)) failed.push(accelerator);
  }
  if (failed.length) {
    // Another app already owns the combination; say so rather than failing mute.
    // The chat renderer may not be listening yet, so wait until it is.
    const notice = `These hotkeys are taken by another app: ${failed.join(', ')}`;
    if (chatWindow) {
      chatWindow.webContents.once('did-finish-load', () => toChat('friday:notice', notice));
    }
    console.warn(notice);
  }
}

// ---------------------------------------------------------------- ipc

function registerIpc() {
  ipcMain.handle('friday:ask', async (_event, payload) => {
    sendOrbStatus('thinking', 'Thinking…');
    const reply = await handleAsk(payload);
    sendOrbStatus(reply.error ? 'error' : 'ready', reply.error ? 'Error' : 'Ready');
    return reply;
  });

  ipcMain.handle('friday:transcribe', async (_event, { buffer, mimeType }) => {
    return voice.transcribe(Buffer.from(buffer), mimeType);
  });

  ipcMain.handle('friday:get-settings', () => ({
    ...settings,
    skins: availableSkins().map((s) => ({ id: s.id, name: s.name })),
    env: {
      configured: ai.configured,
      provider: ai.provider,
      providerName: ai.spec.name,
      model: ai.describeModel,
      screen: systemPreferences.getMediaAccessStatus('screen'),
      microphone: systemPreferences.getMediaAccessStatus('microphone'),
      sttBackend: voice.backend,
      ollamaHost: ai.ollamaHost,
      displays: describeDisplays(),
      voiceAvailable: voice.available,
      voiceReason: voice.unavailableReason,
      // Which providers already have a key on file, so the picker can show it.
      keyed: Object.fromEntries(publicProviders().map((p) => [p.id, providerHasKey(p.id)])),
      canEncrypt: secrets.available(),
    },
  }));

  // ---- the orb ----

  ipcMain.on('friday:orb-expand', (_event, expanded) => {
    if (orbWindow && !orbWindow.isDestroyed()) orbWindow.setBounds(orbBounds(Boolean(expanded)));
  });

  /** Dragging the ball. Deltas, so the pointer stays glued to it. */
  ipcMain.on('friday:orb-move', (_event, { dx, dy } = {}) => {
    if (!orbWindow || orbWindow.isDestroyed()) return;

    const [x, y] = orbWindow.getPosition();
    const moved = { x: Math.round(x + (dx || 0)), y: Math.round(y + (dy || 0)) };
    orbWindow.setPosition(moved.x, moved.y);

    settings.orbPosition = moved;
    persistSettings();
  });

  ipcMain.on('friday:toggle-panel', () => {
    showPanel(!(chatWindow && chatWindow.isVisible()));
  });

  /** A question typed into the orb's tray, answered without opening the panel. */
  ipcMain.on('friday:ask-from-orb', async (_event, question) => {
    sendOrbStatus('thinking', 'Thinking…');
    const reply = await handleAsk({ question });

    if (reply.error) {
      sendOrbStatus('error', reply.error.slice(0, 80));
      return;
    }

    // The panel owns speech synthesis, so let it speak even while hidden.
    if (chatWindow) chatWindow.webContents.send('friday:speak', { ...reply, question });
    sendOrbStatus('ready', 'Ready');
  });

  ipcMain.handle('friday:get-providers', () => publicProviders());

  /**
   * The models a provider's stored key can actually reach. Built on a throwaway
   * AI so the picker can list a provider the user has not switched to yet.
   */
  ipcMain.handle('friday:list-models', async (_event, providerId) => {
    const spec = resolveProvider(providerId);
    const fallback = spec.suggestedModels || [];

    const probe = new AI({
      provider: spec.id,
      apiKey: secrets.getKey(spec.id) || envKeyFor(spec.id),
      ollamaHost: settings.ollamaHost || spec.defaultHost,
    });

    if (!probe.configured) return { ok: false, models: fallback, needsKey: true };

    try {
      const models = await probe.listModels();
      return models.length ? { ok: true, models } : { ok: false, models: fallback };
    } catch (error) {
      return {
        ok: false,
        models: fallback,
        error: errors.classify(describe(error), { name: spec.name, provider: spec.id }),
      };
    }
  });

  /** Only ever used for the "get a key" links on the provider cards. */
  ipcMain.handle('friday:open-external', (_event, url) => {
    const allowed = publicProviders().map((p) => p.keyUrl).filter(Boolean);
    if (allowed.includes(url)) shell.openExternal(url);
  });

  /**
   * Switch provider, and optionally store a key for it. The key arrives from
   * the renderer once, goes straight into the encrypted store, and is never
   * sent back.
   */
  ipcMain.handle('friday:set-provider', (_event, { provider, apiKey, model, ollamaHost } = {}) => {
    const spec = resolveProvider(provider);

    if (typeof apiKey === 'string' && apiKey.trim()) {
      const saved = secrets.setKey(spec.id, apiKey.trim());
      if (!saved.ok) return { ok: false, error: saved.error };
    }

    settings.provider = spec.id;
    if (model) settings.models[spec.id] = model;
    if (ollamaHost) settings.ollamaHost = ollamaHost;
    persistSettings();

    ai.configure(providerConfig());

    return { ok: true, configured: ai.configured, model: ai.describeModel };
  });

  /** Forget a stored key. .env keys are not ours to delete, so say so. */
  ipcMain.handle('friday:forget-key', (_event, provider) => {
    const spec = resolveProvider(provider);
    secrets.setKey(spec.id, '');
    ai.configure(providerConfig());
    return {
      ok: true,
      stillKeyed: Boolean(envKeyFor(spec.id)),
    };
  });

  /** A real round trip, so the user finds out here rather than mid-question. */
  ipcMain.handle('friday:test-provider', async () => {
    if (!ai.configured) return { ok: false, error: 'No API key saved for this provider yet.' };
    try {
      const reply = await ai.ask({ question: 'Reply with the word ready.', image: null, history: [], mode: 'chat' });
      if (reply.degraded === 'no-key') return { ok: false, error: reply.speech };
      return { ok: true, model: ai.describeModel };
    } catch (error) {
      // Keep the provider's own wording too: the friendly text is a guess
      // based on pattern matching, and a wrong guess is worse than no guess
      // if it hides what actually happened.
      return { ok: false, error: friendlyError(error), detail: describe(error) };
    }
  });

  ipcMain.handle('friday:save-settings', (_event, patch) => {
    const previousInterval = settings.intervalMs;
    Object.assign(settings, patch);
    persistSettings();

    capture.setBlocklist(settings.blocklist);
    capture.setTargetDisplay(settings.displayId);
    eachOverlay((overlay) => overlay.webContents.send('friday:skin', currentSkin()));
    if (settings.intervalMs !== previousInterval && !paused) capture.start(settings.intervalMs);
    return settings;
  });

  ipcMain.handle('friday:open-settings', (_event, pane) => {
    const panes = {
      screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
      accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    };
    if (panes[pane]) return shell.openExternal(panes[pane]);
  });

  ipcMain.on('friday:set-mode', (_event, next) => {
    mode = next;
    // Chat Only should not keep capturing in the background.
    if (mode === 'chat') capture.stop();
    else if (!paused) capture.start(settings.intervalMs);
  });

  ipcMain.on('friday:clear', () => clearOverlays());
  ipcMain.on('friday:toggle-pause', () => setPaused(!paused));

  ipcMain.on('friday:speech-ended', (_event, autoClearAfterMs) => {
    toOverlay('friday:speech-end', autoClearAfterMs);
    // The overlay clears itself after the delay; mirror that here so the next
    // capture knows it no longer needs to hide anything.
    setTimeout(() => { overlayHasContent = false; }, (autoClearAfterMs || 0) + 400);
  });

  ipcMain.on('friday:pointer-state', (_event, state) => toOverlay('friday:pointer-state', state));
}

// ---------------------------------------------------------------- startup

// A second copy would fight over the hotkeys and double the API calls.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (chatWindow) {
      chatWindow.show();
      chatWindow.focus();
    }
  });

  app.whenReady().then(() => {
    loadSettings();

    ai = new AI(providerConfig());

    voice = new Voice({
      ai,
      whisperBin: process.env.WHISPER_BIN,
      whisperModel: process.env.WHISPER_MODEL,
    });

    capture = new Capture({
      hideDuringCapture,
      onDisplayLost: handleDisplayLost,
    });
    capture.setBlocklist(settings.blocklist);
    capture.setTargetDisplay(settings.displayId);

    syncOverlays();
    createOrbWindow();
    // Friday lives as the ball. The panel only opens itself when there is
    // nothing configured yet and the user has to be asked something.
    createChatWindow({ showOnReady: !ai.configured });
    registerIpc();
    registerHotkeys();

    if (!paused) capture.start(settings.intervalMs);

    screen.on('display-added', syncOverlays);
    screen.on('display-removed', () => {
      syncOverlays();
      // Re-resolve now rather than at the next question, so the user is told
      // straight away instead of quietly getting a different screen.
      if (settings.displayId !== null) capture.targetDisplay();
    });
    screen.on('display-metrics-changed', syncOverlays);

    app.on('activate', () => {
      showPanel(true);
    });
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  // The overlay is a window too, so closing the chat panel must not quit.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (capture) capture.stop();
  });
}
