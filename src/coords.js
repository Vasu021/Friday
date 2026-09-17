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

/**
 * The display id a desktopCapturer source belongs to, as a string.
 *
 * macOS reports `display_id` as a string, and some Electron/macOS combinations
 * leave it empty for the non-primary screens. The source id is always shaped
 * `screen:<display_id>:<index>`, so it is a reliable second try.
 *
 * @returns {string|null} null when the source cannot be tied to a display.
 */
function sourceDisplayId(source) {
  if (!source) return null;

  const reported = source.display_id;
  if (reported !== undefined && reported !== null && String(reported) !== '' && String(reported) !== '0') {
    return String(reported);
  }

  const fromId = /^screen:(\d+):/.exec(String(source.id || ''));
  return fromId ? fromId[1] : null;
}

/**
 * Pair the screen we want with the capturer source that actually shows it.
 *
 * Getting this wrong is worse than failing: if the image comes from one screen
 * while the caller believes it came from another, every box_2d is mapped onto
 * the wrong monitor and the drawings land on a screen the user never asked
 * about. So a source is only ever returned together with the display it really
 * shows, and an unidentifiable source is refused rather than guessed at.
 *
 * @param {Array} sources   desktopCapturer screen sources
 * @param {object} wanted   the display we asked to capture
 * @param {Array} displays  every attached display
 * @returns {{source: object, display: object, substituted: boolean} | null}
 */
function pickSource(sources, wanted, displays) {
  const list = Array.isArray(sources) ? sources.filter(Boolean) : [];
  if (list.length === 0 || !wanted) return null;

  const exact = list.find((s) => sourceDisplayId(s) === String(wanted.id));
  if (exact) return { source: exact, display: wanted, substituted: false };

  // One screen, one source: no other reading is possible, so an empty or
  // mismatched display_id is not a reason to refuse.
  const all = Array.isArray(displays) ? displays : [];
  if (list.length === 1 && all.length === 1) {
    return { source: list[0], display: all[0], substituted: all[0].id !== wanted.id };
  }

  // The wanted screen has no source of its own. Take the first source we can
  // actually identify, and report it as the display it shows -- never as the
  // one that was asked for.
  for (const source of list) {
    const id = sourceDisplayId(source);
    const display = all.find((d) => String(d.id) === id);
    if (display) return { source, display, substituted: display.id !== wanted.id };
  }

  return null;
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
  sourceDisplayId,
  pickSource,
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
