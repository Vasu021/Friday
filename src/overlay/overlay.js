// Overlay renderer: runs a list of steps as a timed sequence, drawing the
// pointer, shapes and bubble, then clears itself.
//
// Steps arrive with `box` still on the 0-1000 scale; main.js also sends the
// display bounds so this file can do the final conversion locally through the
// same maths as coords.js.

const SVG_NS = 'http://www.w3.org/2000/svg';

const shapesLayer = document.getElementById('shapes');
const pointer = document.getElementById('pointer');
const bubble = document.getElementById('bubble');
const watching = document.getElementById('watching');

// Highlights are drawn slightly larger than the reported box, because vision
// models miss by a few pixels (PLAN 4.4 v1).
const HIGHLIGHT_PADDING = 10;
const BOX_SCALE = 1000;

let runToken = 0;
let clearTimer = null;

/** box_2d -> CSS pixels inside this overlay (which covers exactly one display). */
function boxToRect(box) {
  const [ymin, xmin, ymax, xmax] = box;
  const width = window.innerWidth;
  const height = window.innerHeight;
  return {
    x: (xmin / BOX_SCALE) * width,
    y: (ymin / BOX_SCALE) * height,
    width: ((xmax - xmin) / BOX_SCALE) * width,
    height: ((ymax - ymin) / BOX_SCALE) * height,
  };
}

function padded(rect) {
  const x = Math.max(0, rect.x - HIGHLIGHT_PADDING);
  const y = Math.max(0, rect.y - HIGHLIGHT_PADDING);
  return {
    x,
    y,
    width: Math.min(window.innerWidth - x, rect.width + HIGHLIGHT_PADDING * 2),
    height: Math.min(window.innerHeight - y, rect.height + HIGHLIGHT_PADDING * 2),
  };
}

function svg(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/**
 * Set up the draw-in animation. The dash length has to match the path length
 * or the stroke either snaps in or never finishes.
 */
function animateStroke(node) {
  shapesLayer.append(node);
  let length = 1200;
  try {
    if (typeof node.getTotalLength === 'function') length = node.getTotalLength() || length;
  } catch {
    // Firefox-style getTotalLength failures are not worth crashing a step over.
  }
  node.style.setProperty('--len', length);
  node.style.strokeDasharray = length;
  node.style.strokeDashoffset = length;
  return node;
}

function drawCircle(rect) {
  const r = padded(rect);
  return animateStroke(svg('ellipse', {
    class: 'mark',
    cx: r.x + r.width / 2,
    cy: r.y + r.height / 2,
    rx: Math.max(18, r.width / 2),
    ry: Math.max(14, r.height / 2),
  }));
}

function drawBox(rect) {
  const r = padded(rect);
  return animateStroke(svg('rect', {
    class: 'mark',
    x: r.x, y: r.y,
    width: Math.max(10, r.width),
    height: Math.max(10, r.height),
    rx: 8,
  }));
}

function drawUnderline(rect) {
  const r = padded(rect);
  const y = r.y + r.height;
  return animateStroke(svg('path', {
    class: 'mark',
    // A slight sag reads as hand-drawn rather than as a UI border.
    d: `M ${r.x} ${y} Q ${r.x + r.width / 2} ${y + 7}, ${r.x + r.width} ${y}`,
  }));
}

/** An arrow into the target from whichever side has the most room. */
function drawArrow(rect) {
  const target = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const fromLeft = target.x > window.innerWidth / 2;
  const tailLength = Math.min(190, Math.max(90, window.innerWidth * 0.11));

  const tipX = fromLeft ? rect.x - 12 : rect.x + rect.width + 12;
  const tipY = target.y;
  const tailX = fromLeft ? tipX - tailLength : tipX + tailLength;
  const tailY = tipY - tailLength * 0.42;

  const group = svg('g', {});
  const shaft = svg('path', {
    class: 'mark',
    d: `M ${tailX} ${tailY} Q ${(tailX + tipX) / 2} ${(tailY + tipY) / 2 - 26}, ${tipX} ${tipY}`,
  });
  const head = Math.atan2(tipY - (tailY + tipY) / 2, tipX - (tailX + tipX) / 2);
  const size = 15;
  const barb = svg('path', {
    class: 'mark',
    d:
      `M ${tipX - size * Math.cos(head - 0.45)} ${tipY - size * Math.sin(head - 0.45)} ` +
      `L ${tipX} ${tipY} ` +
      `L ${tipX - size * Math.cos(head + 0.45)} ${tipY - size * Math.sin(head + 0.45)}`,
  });

  shapesLayer.append(group);
  group.append(shaft, barb);
  animateStroke(shaft);
  animateStroke(barb);
  return group;
}

function drawLabel(rect, text) {
  if (!text) return null;
  const r = padded(rect);
  const width = Math.max(44, text.length * 7.6 + 18);
  const x = Math.min(window.innerWidth - width - 8, Math.max(8, r.x));
  const y = Math.max(8, r.y - 30);

  const group = svg('g', { class: 'mark', style: 'stroke:none;opacity:1;animation:none' });
  group.append(
    svg('rect', { class: 'label-plate', x, y, width, height: 24, rx: 7 }),
    Object.assign(svg('text', { class: 'mark-label', x: x + 9, y: y + 16.5 }), { textContent: text }),
  );
  shapesLayer.append(group);
  return group;
}

function movePointer(rect, travelMs) {
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  pointer.style.transitionDuration = `${Math.max(180, Math.min(travelMs, 1100))}ms, 220ms`;
  pointer.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  pointer.classList.add('visible');
}

function setPointerState(state) {
  pointer.dataset.state = state;
}

function showBubble(text, rect) {
  if (!text) return hideBubble();
  bubble.textContent = text;
  bubble.classList.add('visible');

  // Measure after the text is in, then keep the bubble on screen and clear of
  // the thing it is pointing at.
  const size = bubble.getBoundingClientRect();
  let left = rect.x + rect.width / 2 - size.width / 2;
  let top = rect.y + rect.height + 30;
  if (top + size.height > window.innerHeight - 12) top = rect.y - size.height - 30;
  if (top < 12) top = 12;
  left = Math.max(12, Math.min(left, window.innerWidth - size.width - 12));

  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
}

function hideBubble() {
  bubble.classList.remove('visible');
}

function clearAll({ immediate = false } = {}) {
  runToken += 1;                       // cancels any sequence mid-flight
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = null;

  hideBubble();
  pointer.classList.remove('visible');
  setPointerState('idle');

  if (immediate) {
    shapesLayer.replaceChildren();
    return;
  }
  for (const node of [...shapesLayer.children]) node.classList.add('fading');
  setTimeout(() => shapesLayer.replaceChildren(), 340);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run a step list as a guided tour, one step at a time. */
async function runSteps(steps, autoClearAfterMs) {
  clearAll({ immediate: true });
  const token = runToken;

  for (const step of steps) {
    if (token !== runToken) return;          // superseded or cleared

    if (step.action === 'clear') {
      clearAll();
      continue;
    }

    const rect = boxToRect(step.box);

    setPointerState('moving');
    movePointer(rect, step.duration_ms * 0.35);
    await wait(Math.min(460, step.duration_ms * 0.3));
    if (token !== runToken) return;

    setPointerState('pointing');

    const shape = step.shape || (step.action === 'move_pointer' ? null : step.action);
    if (shape === 'circle') drawCircle(rect);
    else if (shape === 'box') drawBox(rect);
    else if (shape === 'arrow') drawArrow(rect);
    else if (shape === 'underline') drawUnderline(rect);
    else if (shape === 'text_label') drawLabel(rect, step.label || step.bubble);

    showBubble(step.bubble, rect);

    await wait(step.duration_ms);
  }

  if (token !== runToken) return;
  setPointerState('idle');

  // Auto-clear is scheduled here, but main.js re-triggers it when speech ends
  // so a long answer is never cut short by a short step list.
  clearTimer = setTimeout(() => clearAll(), Math.max(0, autoClearAfterMs));
}

function applySkin(skin) {
  if (!skin) return;
  const root = document.documentElement.style;
  if (skin.accent) root.setProperty('--accent', skin.accent);
  if (skin.art) root.setProperty('--skin-art', skin.art);
  root.setProperty('--skin-radius', skin.radius || '50%');
  if (skin.size) {
    pointer.style.width = `${skin.size}px`;
    pointer.style.height = `${skin.size}px`;
    pointer.style.margin = `${-skin.size / 2}px 0 0 ${-skin.size / 2}px`;
  }
}

// ---- wiring ----

window.friday.onDraw(({ steps, auto_clear_after_ms }) => runSteps(steps, auto_clear_after_ms));
window.friday.onClear(() => clearAll());
window.friday.onPointerState((state) => {
  if (state !== 'idle') pointer.classList.add('visible');
  setPointerState(state);
});
window.friday.onWatching((isWatching) => {
  watching.hidden = !isWatching;
});
window.friday.onSkin(applySkin);

// Speech and drawings finish together: main.js tells us when the answer has
// been fully spoken, and the overlay clears `auto_clear_after_ms` later.
window.friday.onSpeechEnd((autoClearAfterMs) => {
  setPointerState('idle');
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => clearAll(), Math.max(0, autoClearAfterMs));
});
