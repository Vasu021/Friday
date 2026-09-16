// Phase 0: render the preflight checklist. The real chat UI lands in Phase 2.

const list = document.getElementById('checks');

function addCheck(status, label, detail, fixPane) {
  const li = document.createElement('li');
  li.className = `check ${status}`;

  const name = document.createElement('span');
  name.className = 'label';
  name.textContent = label;
  li.append(name);

  if (detail) {
    const note = document.createElement('span');
    note.className = 'detail';
    note.textContent = detail;
    li.append(note);
  }

  if (fixPane) {
    const button = document.createElement('button');
    button.textContent = 'Open Settings';
    button.addEventListener('click', () => window.friday.openSettings(fixPane));
    li.append(button);
  }

  list.append(li);
}

// 'granted' is the only status that means we can actually capture.
function permissionStatus(value) {
  return value === 'granted' ? 'ok' : 'warn';
}

async function run() {
  const info = await window.friday.preflight();
  list.replaceChildren();

  addCheck('ok', 'Electron', `v${info.electron} · Node ${info.node}`);
  addCheck(
    info.platform === 'darwin' ? 'ok' : 'warn',
    'Platform',
    info.platform === 'darwin' ? 'macOS' : `${info.platform} (macOS is the target)`,
  );
  addCheck(
    info.hasApiKey ? 'ok' : 'bad',
    'GEMINI_API_KEY',
    info.hasApiKey ? 'loaded from .env' : 'missing — copy .env.example to .env',
  );
  addCheck(
    permissionStatus(info.screen),
    'Screen Recording',
    info.screen,
    info.screen === 'granted' ? null : 'screen',
  );
  addCheck(
    permissionStatus(info.microphone),
    'Microphone',
    info.microphone,
    info.microphone === 'granted' ? null : 'microphone',
  );
}

run();
