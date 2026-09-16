// The floating ball. Friday's resting state: a small always-on-top dot that
// expands on hover into a one-line prompt, and opens the full panel on click.
//
// The window is resized by the main process to exactly fit whichever state is
// showing, so there is never an invisible rectangle swallowing clicks around
// the ball.

const ball = document.getElementById('ball');
const tray = document.getElementById('tray');
const quick = document.getElementById('quick');
const hint = document.getElementById('hint');

let expanded = false;
let busy = false;

// ---- expanding ----

function expand() {
  if (expanded) return;
  expanded = true;
  document.body.classList.add('expanded');
  window.friday.orbExpand(true);
  // The window has to grow before the input can take focus inside it.
  setTimeout(() => quick.focus(), 60);
}

function collapse() {
  // Never collapse out from under someone mid-sentence.
  if (!expanded || quick.value.trim()) return;
  expanded = false;
  document.body.classList.remove('expanded');
  quick.blur();
  window.friday.orbExpand(false);
}

document.body.addEventListener('mouseenter', expand);
document.body.addEventListener('mouseleave', collapse);

// ---- click vs drag ----
//
// A plain click opens the panel; a drag moves the ball. They are told apart
// by distance, because a drag region would stop the click reaching us at all.

const DRAG_THRESHOLD = 3;

let pointerDown = false;
let dragged = false;
let last = null;

ball.addEventListener('mousedown', (event) => {
  pointerDown = true;
  dragged = false;
  last = { x: event.screenX, y: event.screenY };
});

window.addEventListener('mousemove', (event) => {
  if (!pointerDown) return;

  const dx = event.screenX - last.x;
  const dy = event.screenY - last.y;
  if (!dragged && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;

  dragged = true;
  last = { x: event.screenX, y: event.screenY };
  window.friday.orbMove({ dx, dy });
});

window.addEventListener('mouseup', () => {
  if (pointerDown && !dragged) window.friday.togglePanel();
  pointerDown = false;
});

// ---- asking from the tray ----

quick.addEventListener('keydown', async (event) => {
  if (event.key === 'Escape') {
    quick.value = '';
    collapse();
    return;
  }
  if (event.key !== 'Enter') return;

  const question = quick.value.trim();
  if (!question || busy) return;

  quick.value = '';
  window.friday.askFromOrb(question);
});

// ---- state from main ----

window.friday.onOrbStatus(({ state, text, watching }) => {
  busy = state === 'thinking';
  ball.dataset.state = state;
  hint.textContent = text;
  document.body.classList.toggle('watching', Boolean(watching));

  // A finished answer means the tray has done its job.
  if (state === 'ready' && !quick.value.trim() && !quick.matches(':focus')) collapse();
});
