// Screen coordinate conversion. Everything that turns an AI-reported box into
// pixels on a real display goes through here (CLAUDE.md), so the Retina and
// multi-monitor rules live in exactly one place.
//
// Three coordinate spaces are in play:
//
//   box_2d    [ymin, xmin, ymax, xmax] on a 0-1000 scale, relative to the
//             captured image of ONE display. This is what Gemini returns.
//   image px  pixels in the captured bitmap. On a Retina display the bitmap is
//             `scaleFactor` times bigger than the display's DIP size.
//   DIP       device-independent points. Electron window bounds, `screen`
//             coordinates and CSS pixels in a renderer all use these.
//
// The important consequence: because box_2d is NORMALIZED, the Retina scale
// factor cancels out when converting box_2d -> DIP. scaleFactor only matters
// when something hands us raw image pixels (OCR snapping, Phase 5), which is
// what `imageToDip` is for.

const BOX_SCALE = 1000;

/**
 * Validate and clean a raw box_2d from the model.
 * Returns null for anything unusable so callers can skip the step rather than
 * drawing a highlight in the wrong place.
 * @returns {[number, number, number, number] | null} [ymin, xmin, ymax, xmax]
 */
function normalizeBox(box) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const nums = box.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;

  let [ymin, xmin, ymax, xmax] = nums.map((n) => clamp(n, 0, BOX_SCALE));

  // Models occasionally swap the corners; treat it as a typo rather than a
  // reason to drop the step.
  if (ymin > ymax) [ymin, ymax] = [ymax, ymin];
  if (xmin > xmax) [xmin, xmax] = [xmax, xmin];

  // A zero-area box is a point, not a region. Give it a small footprint so the
  // highlight is still visible.
  if (ymax - ymin < 1) ymax = Math.min(BOX_SCALE, ymin + 1);
  if (xmax - xmin < 1) xmax = Math.min(BOX_SCALE, xmin + 1);

  return [ymin, xmin, ymax, xmax];
}

/**
 * box_2d -> a rectangle in DIPs, relative to the display's own top-left.
 * These are the coordinates an overlay renderer covering that display uses
 * directly as CSS pixels.
 */
function boxToLocalRect(box, display) {
  const normalized = normalizeBox(box);
  if (!normalized) return null;

  const [ymin, xmin, ymax, xmax] = normalized;
  const { width, height } = display.bounds;

  return {
    x: (xmin / BOX_SCALE) * width,
    y: (ymin / BOX_SCALE) * height,
    width: ((xmax - xmin) / BOX_SCALE) * width,
    height: ((ymax - ymin) / BOX_SCALE) * height,
  };
}

/**
 * box_2d -> a rectangle in DIPs in the global screen space, where a secondary
 * monitor may sit at a negative offset. Use this for anything that talks to
 * the `screen` module; use boxToLocalRect for drawing inside an overlay.
 */
function boxToScreenRect(box, display) {
  const rect = boxToLocalRect(box, display);
  if (!rect) return null;
  return { ...rect, x: rect.x + display.bounds.x, y: rect.y + display.bounds.y };
}

/** Raw captured-image pixels -> DIPs. Only needed for OCR-style pixel input. */
function imageToDip(point, display) {
  const scale = display.scaleFactor || 1;
  return { x: point.x / scale, y: point.y / scale };
}

/** The DIP size a capture of this display should produce at full resolution. */
function imageSizeFor(display) {
  const scale = display.scaleFactor || 1;
  return {
    width: Math.round(display.bounds.width * scale),
    height: Math.round(display.bounds.height * scale),
  };
}

function centerOf(rect) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * Grow a rect by `padding` on every side, kept inside `bounds` if given.
 * Vision models miss by a few pixels, so highlights are drawn slightly larger
 * than the reported box (PLAN.md 4.4 v1).
 */
function padRect(rect, padding, bounds) {
  let x = rect.x - padding;
  let y = rect.y - padding;
  let width = rect.width + padding * 2;
  let height = rect.height + padding * 2;

  if (bounds) {
    const maxX = bounds.width;
    const maxY = bounds.height;
    if (x < 0) { width += x; x = 0; }
    if (y < 0) { height += y; y = 0; }
    if (x + width > maxX) width = maxX - x;
    if (y + height > maxY) height = maxY - y;
  }

  return { x, y, width: Math.max(0, width), height: Math.max(0, height) };
}

/** The display containing `point`, falling back to the first one. */
function displayForPoint(point, displays) {
  const hit = displays.find(
    (d) =>
      point.x >= d.bounds.x &&
      point.x < d.bounds.x + d.bounds.width &&
      point.y >= d.bounds.y &&
      point.y < d.bounds.y + d.bounds.height,
  );
  return hit || displays[0];
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/**
 * Which display to capture.
 *
 * A pinned display that is no longer attached must not break capture, so this
 * falls back to the cursor's display and reports the loss for the caller to
 * surface.
 *
 * @param {Array} displays  every attached display
 * @param {number|null} targetId  the pinned display, or null to follow the cursor
 * @param {{x: number, y: number}} cursor
 * @returns {{display: object, lost: boolean}}
 */
function chooseDisplay(displays, targetId, cursor) {
  if (targetId === null || targetId === undefined) {
    return { display: displayForPoint(cursor, displays), lost: false };
  }

  const pinned = displays.find((display) => display.id === targetId);
  if (pinned) return { display: pinned, lost: false };

  return { display: displayForPoint(cursor, displays), lost: true };
}

module.exports = {
  BOX_SCALE,
  chooseDisplay,
  normalizeBox,
  boxToLocalRect,
  boxToScreenRect,
  imageToDip,
  imageSizeFor,
  centerOf,
  padRect,
  displayForPoint,
  clamp,
};
