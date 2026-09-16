// Retina and multi-monitor coordinate bugs are listed as a top risk in
// PLAN.md 11, so coords.js is the one module with tests.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeBox,
  boxToLocalRect,
  boxToScreenRect,
  imageToDip,
  imageSizeFor,
  centerOf,
  padRect,
  displayForPoint,
} = require('../src/coords');

// A 1440x900 logical display on a 2x Retina panel.
const retina = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 };
// A 1080p monitor sitting to the LEFT of it, hence the negative origin.
const secondary = { id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };

test('normalizeBox rejects malformed input', () => {
  assert.equal(normalizeBox(null), null);
  assert.equal(normalizeBox([1, 2, 3]), null);
  assert.equal(normalizeBox(['a', 2, 3, 4]), null);
  assert.equal(normalizeBox([1, 2, NaN, 4]), null);
});

test('normalizeBox clamps out-of-range values', () => {
  assert.deepEqual(normalizeBox([-50, 0, 2000, 500]), [0, 0, 1000, 500]);
});

test('normalizeBox repairs swapped corners', () => {
  assert.deepEqual(normalizeBox([800, 600, 200, 100]), [200, 100, 800, 600]);
});

test('normalizeBox gives a zero-area box a visible footprint', () => {
  const box = normalizeBox([500, 500, 500, 500]);
  assert.ok(box[2] > box[0], 'height should be non-zero');
  assert.ok(box[3] > box[1], 'width should be non-zero');
});

test('boxToLocalRect maps the 0-1000 scale onto display DIPs', () => {
  // Top-left quadrant.
  assert.deepEqual(boxToLocalRect([0, 0, 500, 500], retina), {
    x: 0, y: 0, width: 720, height: 450,
  });
  // Dead centre, a tenth of the screen across.
  assert.deepEqual(boxToLocalRect([450, 450, 550, 550], retina), {
    x: 648, y: 405, width: 144, height: 90,
  });
});

test('boxToLocalRect ignores scaleFactor because box_2d is normalized', () => {
  // Same normalized box, same logical size, different scaleFactor -> identical
  // DIP rect. This is the Retina invariant the whole design relies on.
  const oneX = { ...retina, scaleFactor: 1 };
  assert.deepEqual(boxToLocalRect([100, 200, 300, 400], retina), boxToLocalRect([100, 200, 300, 400], oneX));
});

test('boxToScreenRect offsets by the display origin', () => {
  const local = boxToLocalRect([0, 0, 1000, 1000], secondary);
  const global = boxToScreenRect([0, 0, 1000, 1000], secondary);
  assert.equal(local.x, 0);
  assert.equal(global.x, -1920, 'a left-hand monitor has a negative origin');
  assert.equal(global.width, local.width);
});

test('boxToScreenRect and boxToLocalRect agree on the primary display', () => {
  assert.deepEqual(boxToScreenRect([10, 10, 90, 90], retina), boxToLocalRect([10, 10, 90, 90], retina));
});

test('invalid boxes propagate as null instead of NaN rects', () => {
  assert.equal(boxToLocalRect([1, 2], retina), null);
  assert.equal(boxToScreenRect('nope', retina), null);
});

test('imageToDip divides out the Retina scale factor', () => {
  assert.deepEqual(imageToDip({ x: 2880, y: 1800 }, retina), { x: 1440, y: 900 });
  assert.deepEqual(imageToDip({ x: 100, y: 50 }, secondary), { x: 100, y: 50 });
});

test('imageSizeFor reports physical pixels', () => {
  assert.deepEqual(imageSizeFor(retina), { width: 2880, height: 1800 });
  assert.deepEqual(imageSizeFor(secondary), { width: 1920, height: 1080 });
});

test('centerOf finds the middle of a rect', () => {
  assert.deepEqual(centerOf({ x: 10, y: 20, width: 100, height: 40 }), { x: 60, y: 40 });
});

test('padRect grows the rect on every side', () => {
  assert.deepEqual(padRect({ x: 50, y: 50, width: 100, height: 100 }, 10), {
    x: 40, y: 40, width: 120, height: 120,
  });
});

test('padRect stays inside the display bounds', () => {
  const padded = padRect({ x: 0, y: 0, width: 50, height: 50 }, 20, retina.bounds);
  assert.deepEqual(padded, { x: 0, y: 0, width: 70, height: 70 });

  const clipped = padRect({ x: 1400, y: 880, width: 40, height: 20 }, 30, retina.bounds);
  assert.equal(clipped.x + clipped.width <= retina.bounds.width, true);
  assert.equal(clipped.y + clipped.height <= retina.bounds.height, true);
});

test('displayForPoint picks the monitor under the cursor', () => {
  const displays = [retina, secondary];
  assert.equal(displayForPoint({ x: 100, y: 100 }, displays).id, 1);
  assert.equal(displayForPoint({ x: -500, y: 400 }, displays).id, 2);
  // A point on no display falls back rather than throwing.
  assert.equal(displayForPoint({ x: 99999, y: 99999 }, displays).id, 1);
});

// ---- choosing which screen the AI sees ----

const coords = require('../src/coords');

const laptop = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 } };
const external = { id: 2, bounds: { x: 1512, y: 0, width: 2560, height: 1440 } };
const both = [laptop, external];

test('with no pinned screen it follows the cursor', () => {
  const onExternal = coords.chooseDisplay(both, null, { x: 2000, y: 400 });
  assert.equal(onExternal.display.id, 2);
  assert.equal(onExternal.lost, false);

  const onLaptop = coords.chooseDisplay(both, null, { x: 100, y: 100 });
  assert.equal(onLaptop.display.id, 1);
});

test('a pinned screen is captured wherever the cursor happens to be', () => {
  // The whole point: ask about the external monitor while typing on the laptop.
  const result = coords.chooseDisplay(both, 2, { x: 100, y: 100 });
  assert.equal(result.display.id, 2);
  assert.equal(result.lost, false);
});

test('unplugging the pinned screen falls back instead of breaking capture', () => {
  const result = coords.chooseDisplay([laptop], 2, { x: 100, y: 100 });
  assert.equal(result.display.id, 1, 'falls back to the cursor display');
  assert.equal(result.lost, true, 'and reports it so the user can be told');
});

test('an undefined target behaves like following the cursor', () => {
  const result = coords.chooseDisplay(both, undefined, { x: 2000, y: 400 });
  assert.equal(result.display.id, 2);
  assert.equal(result.lost, false);
});

test('display id 0 is honoured rather than treated as "no selection"', () => {
  const zero = { id: 0, bounds: { x: 0, y: 0, width: 800, height: 600 } };
  const result = coords.chooseDisplay([zero, external], 0, { x: 2000, y: 400 });
  assert.equal(result.display.id, 0, '0 is a real id, not a falsy blank');
});
