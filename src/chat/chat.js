// Chat panel: transcript, mic recording, text-to-speech and settings.
//
// This renderer owns the microphone and the speech synthesiser. Recording is
// toggle-style rather than hold-to-talk because Electron's globalShortcut only
// reports key-down, never key-up (see docs/PROGRESS.md).

const log = document.getElementById('log');
const input = document.getElementById('input');
const sendButton = document.getElementById('send');
const micButton = document.getElementById('mic');
const statusEl = document.getElementById('status');
const modesEl = document.getElementById('modes');
const settingsEl = document.getElementById('settings');
const envEl = document.getElementById('env');
const setupEl = document.getElementById('setup');

let mode = 'guide';  // 'guide' watches the screen, 'chat' does not
let paused = false;
let busy = false;
let speakEnabled = true;

/** Provider descriptors from main, and which card is selected right now. */
let providers = [];
let chosen = null;

// ---- transcript ----

function addMessage(kind, text, meta) {
  const node = document.createElement('div');
  node.className = `msg ${kind}`;
  node.textContent = text;

  if (meta) {
    const detail = document.createElement('div');
    detail.className = 'steps';
    detail.textContent = meta;
    node.append(detail);
  }

  log.append(node);
  log.scrollTop = log.scrollHeight;
  return node;
}

function addThinking() {
  const node = document.createElement('div');
  node.className = 'msg friday';
  node.innerHTML = '<span class="thinking"><i></i><i></i><i></i></span>';
  log.append(node);
  log.scrollTop = log.scrollHeight;
  return node;
}

function setStatus(text, state = 'ready') {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

// ---- asking ----

async function ask(question) {
  const text = question.trim();
  if (!text || busy) return;

  busy = true;
  input.value = '';
  addMessage('user', text);
  const placeholder = addThinking();
  setStatus('Thinking…', 'thinking');

  try {
    const reply = await window.friday.ask({ question: text, mode });
    placeholder.remove();

    if (reply.error) {
      addMessage('error', reply.error);
      setStatus('Error', 'error');
      return;
    }

    const stepCount = reply.steps ? reply.steps.length : 0;
    addMessage(
      'friday',
      reply.speech,
      stepCount ? `Pointing at ${stepCount} ${stepCount === 1 ? 'thing' : 'things'} on screen` : null,
    );

    if (reply.degraded === 'unparsable') {
      addMessage('system', 'Friday replied in plain text, so there is nothing to draw.');
    }

    if (speakEnabled) speak(reply.speech, reply.auto_clear_after_ms);
    else window.friday.speechEnded(reply.auto_clear_after_ms);

    setStatus(paused ? 'Paused' : 'Ready', paused ? 'paused' : 'ready');
  } catch (error) {
    placeholder.remove();
    addMessage('error', error.message || String(error));
    setStatus('Error', 'error');
  } finally {
    busy = false;
  }
}

// ---- text to speech ----

/** English voices this Mac has, and the one the user picked (if any). */
let voices = [];
let preferredVoiceURI = null;

function loadVoices() {
  voices = window.speechSynthesis.getVoices().filter((voice) => voice.lang.startsWith('en'));
  renderVoiceOptions();
}

/**
 * macOS defaults to a compressed, robotic voice. The downloadable Premium and
 * Enhanced ones sound dramatically better, so prefer them when present.
 */
function pickVoice() {
  if (!voices.length) return null;

  const picked = voices.find((voice) => voice.voiceURI === preferredVoiceURI);
  if (picked) return picked;

  const quality = (voice) => {
    if (/premium/i.test(voice.name)) return 0;
    if (/enhanced/i.test(voice.name)) return 1;
    return 2;
  };
  return [...voices].sort((a, b) => quality(a) - quality(b))[0];
}

function renderVoiceOptions() {
  const select = document.getElementById('voice');
  if (!select) return;

  select.replaceChildren();
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Best available';
  select.append(auto);

  for (const voice of voices) {
    const option = document.createElement('option');
    option.value = voice.voiceURI;
    option.textContent = voice.name;
    select.append(option);
  }
  select.value = preferredVoiceURI || '';
}

// Voices load asynchronously; the list is often empty on first call.
window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
loadVoices();

function speak(text, autoClearAfterMs) {
  window.speechSynthesis.cancel();
  if (!text) return window.friday.speechEnded(autoClearAfterMs);

  const utterance = new SpeechSynthesisUtterance(text);
  const voice = pickVoice();
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  }
  utterance.rate = 1.0;
  utterance.pitch = 1.0;

  // The overlay waits for this before starting its auto-clear countdown, so a
  // long answer is never cut off by a short step list.
  const done = () => window.friday.speechEnded(autoClearAfterMs);
  utterance.onend = done;
  utterance.onerror = done;

  window.friday.pointerState('talking');
  window.speechSynthesis.speak(utterance);
}

function stopSpeaking() {
  window.speechSynthesis.cancel();
  window.friday.speechEnded(0);
}

// ---- microphone ----

let recorder = null;
let chunks = [];
let stream = null;
let silenceTimer = null;
let audioContext = null;

async function startRecording() {
  if (recorder) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    addMessage('error', 'Friday cannot reach the microphone. Grant Microphone access in System Settings and restart.');
    return;
  }

  chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: pickMimeType() });
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  recorder.onstop = handleRecordingStopped;
  recorder.start();

  micButton.classList.add('recording');
  setStatus('Listening…', 'listening');
  watchForSilence();
}

function stopRecording() {
  if (!recorder) return;
  clearTimeout(silenceTimer);
  silenceTimer = null;
  if (recorder.state !== 'inactive') recorder.stop();
  micButton.classList.remove('recording');
}

async function handleRecordingStopped() {
  const mimeType = recorder ? recorder.mimeType : 'audio/webm';
  const blob = new Blob(chunks, { type: mimeType });

  // Release the mic promptly; the OS indicator staying on is alarming.
  for (const track of stream.getTracks()) track.stop();
  if (audioContext) { audioContext.close(); audioContext = null; }
  recorder = null;
  stream = null;
  chunks = [];

  if (blob.size < 1200) {           // barely any audio: treat as a misfire
    setStatus(paused ? 'Paused' : 'Ready', paused ? 'paused' : 'ready');
    return;
  }

  setStatus('Transcribing…', 'thinking');
  try {
    const buffer = await blob.arrayBuffer();
    const transcript = await window.friday.transcribe({
      buffer: new Uint8Array(buffer),
      mimeType: mimeType.split(';')[0],
    });

    if (!transcript || !transcript.trim()) {
      addMessage('system', 'Friday did not catch that.');
      setStatus(paused ? 'Paused' : 'Ready', paused ? 'paused' : 'ready');
      return;
    }
    ask(transcript);
  } catch (error) {
    addMessage('error', `Transcription failed: ${error.message || error}`);
    setStatus('Error', 'error');
  }
}

/** Stop on ~1.6s of quiet so the user does not have to press the key twice. */
function watchForSilence() {
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  const samples = new Uint8Array(analyser.frequencyBinCount);
  let quietSince = null;
  const startedAt = Date.now();

  const poll = () => {
    if (!recorder || recorder.state !== 'recording') return;

    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += (sample - 128) ** 2;
    const level = Math.sqrt(sum / samples.length) / 128;

    const speaking = level > 0.022;
    if (speaking) quietSince = null;
    else if (quietSince === null) quietSince = Date.now();

    // Always give the user a moment to start talking.
    const settled = Date.now() - startedAt > 900;
    if (settled && quietSince && Date.now() - quietSince > 1600) return stopRecording();
    if (Date.now() - startedAt > 30000) return stopRecording();   // hard cap

    silenceTimer = setTimeout(poll, 120);
  };
  poll();
}

function pickMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function toggleRecording() {
  if (recorder) stopRecording();
  else startRecording();
}

/** ⌥Space reaches here too, so the disabled button alone is not enough. */
async function guardedToggleRecording() {
  if (micButton.disabled) {
    const { env } = await window.friday.getSettings();
    addMessage('system', env.voiceReason || 'Voice is unavailable with this provider.');
    return;
  }
  toggleRecording();
}

// ---- provider setup ----
//
// The picker is built from whatever providers.js declares, so a new backend
// shows up here without touching this file. Keys go one way: typed here,
// handed to main, encrypted, never read back.

const keyInput = document.getElementById('api-key');
const modelSelect = document.getElementById('model');
const modelCustom = document.getElementById('model-custom');
const hostInput = document.getElementById('ollama-host');
const resultEl = document.getElementById('setup-result');

/** Sentinel option letting someone name a model the list does not have. */
const CUSTOM_MODEL = '__custom__';

/**
 * Fill the model dropdown, keeping `selected` available even when the live
 * list does not contain it (an account-specific or brand-new name).
 */
function fillModels(names, selected) {
  const all = [...new Set([...(names || []), selected].filter(Boolean))];

  modelSelect.replaceChildren();
  for (const name of all) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    modelSelect.append(option);
  }

  const other = document.createElement('option');
  other.value = CUSTOM_MODEL;
  other.textContent = 'Other — type a name…';
  modelSelect.append(other);

  modelSelect.value = all.includes(selected) ? selected : (all[0] || CUSTOM_MODEL);
  syncCustomModelField();
}

function syncCustomModelField() {
  modelCustom.hidden = modelSelect.value !== CUSTOM_MODEL;
}

function chosenModel() {
  const name = modelSelect.value === CUSTOM_MODEL ? modelCustom.value.trim() : modelSelect.value;
  return name || chosen.defaultModel;
}

function setModelHint(text) {
  document.getElementById('model-hint').textContent = text;
}

/**
 * Replace the suggested names with what this key can really reach. Runs in the
 * background so picking a provider stays instant.
 */
async function refreshModels(provider, keep) {
  setModelHint('Checking which models your key can use…');
  const result = await window.friday.listModels(provider.id);

  // The user may have clicked a different provider while this was in flight.
  if (!chosen || chosen.id !== provider.id) return;

  fillModels(result.models, keep);

  if (result.ok) setModelHint(`${result.models.length} models available to this key.`);
  else if (result.needsKey) {
    setModelHint(provider.setupHint || 'Save a key to see the models your account can use.');
  } else {
    setModelHint(result.error || provider.setupHint || 'Showing suggested models.');
  }
}

async function openSetup({ firstRun = false } = {}) {
  const { env } = await window.friday.getSettings();
  if (!providers.length) providers = await window.friday.getProviders();

  document.getElementById('setup-title').textContent =
    firstRun ? 'Choose your AI' : 'Change your AI';
  document.getElementById('setup-cancel').hidden = firstRun;

  renderProviders(env);
  selectProvider(env.provider || providers[0].id, env);

  setResult(null);
  settingsEl.hidden = true;
  setupEl.hidden = false;
  setupEl.scrollTop = 0;   // otherwise it reopens wherever it was left
}

/**
 * Close whatever panel is covering the transcript.
 * @returns {boolean} whether anything was actually closed, so Escape can fall
 *   through to "stop talking" when there was no panel open.
 */
function closePanels() {
  let closed = false;

  if (!settingsEl.hidden) {
    settingsEl.hidden = true;
    closed = true;
  }

  // On first run the setup screen has no Cancel and nothing behind it yet,
  // so it must not be dismissable.
  const dismissable = !document.getElementById('setup-cancel').hidden;
  if (!setupEl.hidden && dismissable) {
    setupEl.hidden = true;
    closed = true;
  }

  if (closed) input.focus();
  return closed;
}

function renderProviders(env) {
  const list = document.getElementById('provider-list');
  list.replaceChildren();

  for (const provider of providers) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'provider';
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', String(provider.id === env.provider));
    card.dataset.id = provider.id;

    const name = document.createElement('div');
    name.className = 'provider-name';
    name.append(provider.name);

    // Tell people what they are in for before they commit to a provider.
    if (env.keyed[provider.id] || !provider.needsKey) name.append(badge('Ready', 'ready'));
    if (!provider.supportsSTT) name.append(badge('No voice', 'novoice'));

    const blurb = document.createElement('div');
    blurb.className = 'provider-blurb';
    blurb.textContent = provider.blurb;

    card.append(name, blurb);
    card.addEventListener('click', () => selectProvider(provider.id, env));
    list.append(card);
  }
}

function badge(text, kind) {
  const node = document.createElement('span');
  node.className = `badge ${kind}`;
  node.textContent = text;
  return node;
}

function selectProvider(id, env) {
  chosen = providers.find((p) => p.id === id) || providers[0];

  for (const card of document.querySelectorAll('.provider')) {
    card.setAttribute('aria-checked', String(card.dataset.id === chosen.id));
  }

  document.getElementById('provider-config').hidden = false;
  document.getElementById('key-row').hidden = !chosen.needsKey;
  document.getElementById('host-row').hidden = !chosen.needsHost;

  document.getElementById('key-label').textContent = chosen.keyLabel;
  keyInput.value = '';
  keyInput.placeholder = env.keyed[chosen.id]
    ? 'A key is already saved — leave blank to keep it'
    : `Paste your ${chosen.keyLabel.toLowerCase()}`;

  const hint = document.getElementById('key-hint');
  hint.replaceChildren();
  if (chosen.keyUrl) {
    const link = document.createElement('a');
    link.href = chosen.keyUrl;
    link.textContent = 'Get a key ↗';
    link.title = chosen.keyUrl;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      window.friday.openExternal(chosen.keyUrl);
    });
    hint.append(link);
  }

  hostInput.value = env.ollamaHost || chosen.defaultHost || '';

  // Show the suggested names immediately, then swap in the real list.
  const current = modelFor(chosen, env);
  fillModels(chosen.suggestedModels, current);
  refreshModels(chosen, current);
}

/** Keep the model the user is already running when they reopen the picker. */
function modelFor(provider, env) {
  if (provider.id === env.provider && env.model) return env.model.replace(/^ollama\//, '');
  return provider.defaultModel;
}

function setResult(text, kind = 'busy', detail = null) {
  resultEl.hidden = !text;
  resultEl.replaceChildren();
  resultEl.className = `setup-result ${kind}`;
  if (!text) return;

  resultEl.append(text);

  // The provider's own words, for when the friendly guess above is wrong.
  if (detail && detail !== text) {
    const raw = document.createElement('small');
    raw.textContent = detail;
    resultEl.append(raw);
  }
}

async function saveProvider() {
  const button = document.getElementById('setup-save');
  button.disabled = true;
  setResult(`Saving and testing ${chosen.name}…`, 'busy');

  const saved = await window.friday.setProvider({
    provider: chosen.id,
    apiKey: keyInput.value,
    model: chosenModel(),
    ollamaHost: chosen.needsHost ? hostInput.value.trim() : undefined,
  });

  if (!saved.ok) {
    setResult(saved.error, 'bad');
    button.disabled = false;
    return;
  }

  keyInput.value = '';

  if (!saved.configured) {
    setResult(`${chosen.name} still needs a key before Friday can use it.`, 'bad');
    button.disabled = false;
    return;
  }

  // The key exists now, so the real model list is finally reachable.
  refreshModels(chosen, chosenModel());

  const test = await window.friday.testProvider();
  button.disabled = false;

  if (!test.ok) {
    setResult(test.error, 'bad', test.detail);
    return;
  }

  setResult(`${chosen.name} answered. Friday is using ${test.model}.`, 'ok');
  setupEl.hidden = true;
  await loadSettings();
  addMessage('system', `Friday is now using ${chosen.name} (${test.model}).`);
}

// ---- settings ----

async function loadSettings() {
  const settings = await window.friday.getSettings();
  speakEnabled = settings.speak;

  document.getElementById('speak').checked = settings.speak;
  preferredVoiceURI = settings.voice || null;
  renderVoiceOptions();
  document.getElementById('interval').value = String(settings.intervalMs);
  document.getElementById('blocklist').value = settings.blocklist.join(', ');

  const skinSelect = document.getElementById('skin');
  skinSelect.replaceChildren();
  for (const skin of settings.skins) {
    const option = document.createElement('option');
    option.value = skin.id;
    option.textContent = skin.name;
    skinSelect.append(option);
  }
  skinSelect.value = settings.skin;

  document.getElementById('provider-current').textContent = settings.env.configured
    ? `${settings.env.providerName} · ${settings.env.model}`
    : `${settings.env.providerName} — no key`;

  renderDisplayOptions(settings.env.displays, settings.displayId);
  applyVoiceAvailability(settings.env);
  renderEnv(settings.env);
}

/**
 * The screen picker. "Follow my cursor" is the default because it is what
 * most people want on a laptop; pinning matters once several monitors are
 * attached and the question is about one of them in particular.
 */
function renderDisplayOptions(displays, selectedId) {
  const select = document.getElementById('display');
  select.replaceChildren();

  const follow = document.createElement('option');
  follow.value = '';
  follow.textContent = 'Follow my cursor';
  select.append(follow);

  for (const display of displays || []) {
    const option = document.createElement('option');
    option.value = String(display.id);
    option.textContent = display.label;
    select.append(option);
  }

  select.value = selectedId === null || selectedId === undefined ? '' : String(selectedId);

  const count = (displays || []).length;
  document.getElementById('display-hint').textContent =
    count > 1
      ? `${count} screens detected. Friday only ever captures the one chosen here.`
      : 'Only one screen detected.';
}

/** A provider that cannot hear should not leave a live-looking mic button. */
function applyVoiceAvailability(env) {
  micButton.disabled = !env.voiceAvailable;
  micButton.title = env.voiceAvailable
    ? 'Push to talk (⌥ Space)'
    : env.voiceReason || 'Voice is unavailable with this provider';
}

function renderEnv(env) {
  envEl.replaceChildren();
  const rows = [
    ['Model', env.configured ? env.model : 'no API key', env.configured ? 'ok' : 'bad', null],
    ['Screen Recording', env.screen, env.screen === 'granted' ? 'ok' : 'warn', 'screen'],
    ['Microphone', env.microphone, env.microphone === 'granted' ? 'ok' : 'warn', 'microphone'],
    ['Speech to text', env.sttBackend, env.voiceAvailable ? 'ok' : 'warn', null],
    ['Key storage', env.canEncrypt ? 'encrypted (keychain)' : 'unavailable', env.canEncrypt ? 'ok' : 'warn', null],
  ];

  for (const [label, value, state, pane] of rows) {
    const row = document.createElement('div');
    row.className = `env-row ${state}`;
    const name = document.createElement('span');
    name.textContent = label;
    const detail = document.createElement('span');
    detail.textContent = value;
    row.append(name, detail);

    if (pane && state !== 'ok') {
      const fix = document.createElement('button');
      fix.textContent = 'Fix';
      fix.addEventListener('click', () => window.friday.openSettings(pane));
      row.append(fix);
    }
    envEl.append(row);
  }
}

/** The pinned screen as the picker currently has it; null means follow the cursor. */
function currentDisplayId() {
  const value = document.getElementById('display').value;
  return value ? Number(value) : null;
}

function saveSettings() {
  const patch = {
    speak: document.getElementById('speak').checked,
    voice: document.getElementById('voice').value || null,
    intervalMs: Number(document.getElementById('interval').value),
    displayId: currentDisplayId(),
    skin: document.getElementById('skin').value,
    blocklist: document
      .getElementById('blocklist')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
  speakEnabled = patch.speak;
  preferredVoiceURI = patch.voice;
  window.friday.saveSettings(patch);
}

// ---- wiring ----

sendButton.addEventListener('click', () => ask(input.value));
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') ask(input.value);
});
// Escape closes an open panel first; only with nothing open does it mean
// "stop talking".
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!closePanels()) stopSpeaking();
});

micButton.addEventListener('click', guardedToggleRecording);

modesEl.addEventListener('click', (event) => {
  const button = event.target.closest('.mode');
  if (!button) return;
  mode = button.dataset.mode;
  for (const other of modesEl.querySelectorAll('.mode')) {
    other.setAttribute('aria-selected', String(other === button));
  }
  window.friday.setMode(mode);
  addMessage('system', `${button.textContent} mode`);
});

document.getElementById('settings-toggle').addEventListener('click', () => {
  setupEl.hidden = true;
  settingsEl.hidden = !settingsEl.hidden;
  if (!settingsEl.hidden) loadSettings();
});

document.getElementById('settings-close').addEventListener('click', closePanels);

modelSelect.addEventListener('change', () => {
  syncCustomModelField();
  if (!modelCustom.hidden) modelCustom.focus();
});

document.getElementById('provider-change').addEventListener('click', () => openSetup());
document.getElementById('setup-save').addEventListener('click', saveProvider);
document.getElementById('setup-cancel').addEventListener('click', () => {
  setupEl.hidden = true;
});

for (const id of ['speak', 'voice', 'display', 'interval', 'skin', 'blocklist']) {
  document.getElementById(id).addEventListener('change', saveSettings);
}

document.getElementById('clear').addEventListener('click', () => window.friday.clearScreen());
document.getElementById('stop').addEventListener('click', stopSpeaking);
document.getElementById('pause').addEventListener('click', () => window.friday.togglePause());

// ---- events from main ----

window.friday.onPauseChanged((isPaused) => {
  paused = isPaused;
  const button = document.getElementById('pause');
  button.setAttribute('aria-pressed', String(isPaused));
  button.firstChild.textContent = isPaused ? 'Resume ' : 'Pause ';
  setStatus(isPaused ? 'Paused' : 'Ready', isPaused ? 'paused' : 'ready');
  if (isPaused) addMessage('system', 'Capture paused. Friday cannot see your screen.');
});

// A question asked from the orb is answered by main, but this window owns the
// speech synthesiser, so the reply comes back here to be spoken and logged.
window.friday.onSpeak((reply) => {
  if (reply.question) addMessage('user', reply.question);
  const stepCount = reply.steps ? reply.steps.length : 0;
  addMessage(
    'friday',
    reply.speech,
    stepCount ? `Pointing at ${stepCount} ${stepCount === 1 ? 'thing' : 'things'} on screen` : null,
  );

  if (speakEnabled) speak(reply.speech, reply.auto_clear_after_ms);
  else window.friday.speechEnded(reply.auto_clear_after_ms);
});

window.friday.onToggleMic(guardedToggleRecording);
window.friday.onStopSpeaking(stopSpeaking);
window.friday.onNotice((text) => addMessage('system', text));

// Plugging a monitor in while the settings panel is open used to leave the
// screen picker listing yesterday's monitors, so nothing you chose there
// matched a screen that existed.
window.friday.onDisplaysChanged((displays) => {
  if (settingsEl.hidden) return;
  renderDisplayOptions(displays, currentDisplayId());
});

// ---- start ----

(async function start() {
  await loadSettings();
  const env = (await window.friday.getSettings()).env;

  if (!env.configured) {
    // First run, or the key was removed: ask before anything else.
    await openSetup({ firstRun: true });
  } else if (env.screen !== 'granted') {
    addMessage('system', 'Screen Recording is not granted yet. Open Settings (⚙) to fix it, then restart Friday.');
  } else {
    addMessage('system', 'Ask about anything on your screen. ⌥Space to talk, ⌥C to clear drawings.');
  }
  input.focus();
})();
