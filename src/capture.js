// Screen capture: grabs frames, keeps only the latest in memory, downscales
// before upload, and notices when the screen has changed.
//
// Two rules from CLAUDE.md are enforced here:
//   - screenshots NEVER touch disk; the only copy is the Buffer in `latest`.
//   - the overlay must not appear in what the AI sees. setContentProtection
//     usually handles that, but it is unreliable across macOS versions, so
//     `hideDuringCapture` is a belt-and-braces fallback.

const { desktopCapturer, screen } = require('electron');
const { execFile } = require('node:child_process');
const coords = require('./coords');

// ~1280px wide keeps free-tier uploads small without losing UI text (PLAN 4.2).
const TARGET_WIDTH = 1280;
const JPEG_QUALITY = 72;
// Change detection runs on a tiny grayscale thumbnail; 32x32 is enough to spot
// "the user switched apps" while costing nothing.
const DIFF_SIZE = 32;

class Capture {
  constructor({ onFrame, hideDuringCapture, onDisplayLost, onWrongScreen } = {}) {
    this.onFrame = onFrame || (() => {});
    this.hideDuringCapture = hideDuringCapture || null;
    this.onDisplayLost = onDisplayLost || (() => {});
    // The system handed back a different screen than the one we asked for.
    this.onWrongScreen = onWrongScreen || (() => {});
    // Only warn when the substitution changes, not on every tick.
    this.lastSubstitution = null;
    // null means "whichever display the cursor is on".
    this.targetDisplayId = null;
    this.latest = null;
    this.paused = false;
    this.blocklist = [];
    this.timer = null;
    this.busy = false;
    this.lastSignature = null;
    this.lastChangeScore = 0;
    this.lastSkipReason = null;
  }

  start(intervalMs = 2500) {
    this.stop();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setPaused(paused) {
    this.paused = paused;
    // Drop the held frame so a paused app is not sitting on a stale screenshot.
    if (paused) this.latest = null;
  }

  setBlocklist(apps) {
    this.blocklist = (apps || []).map((a) => a.toLowerCase().trim()).filter(Boolean);
  }

  /**
   * Pin capture to one display, or pass null to follow the cursor.
   * @param {number|null} displayId
   */
  setTargetDisplay(displayId) {
    this.targetDisplayId = Number.isFinite(displayId) ? displayId : null;
    // A different screen means the change-detection baseline is meaningless.
    this.lastSignature = null;
    this.latest = null;
    this.lastSubstitution = null;
  }

  /**
   * Which display to grab. A pinned display that has been unplugged falls
   * back to the cursor rather than failing every capture from then on.
   */
  targetDisplay() {
    const { display, lost } = coords.chooseDisplay(
      screen.getAllDisplays(),
      this.targetDisplayId,
      screen.getCursorScreenPoint(),
    );

    if (lost) {
      const previous = this.targetDisplayId;
      this.targetDisplayId = null;
      this.onDisplayLost(previous);
    }

    return display;
  }

  async tick() {
    if (this.paused || this.busy) return;
    this.busy = true;
    try {
      const blocked = await this.blockedApp();
      if (blocked) {
        this.latest = null;
        this.lastSkipReason = `blocked: ${blocked}`;
        return;
      }
      this.lastSkipReason = null;
      const frame = await this.captureNow();
      if (frame) this.onFrame(frame);
    } catch (error) {
      // desktopCapturer throws a message-less error when Screen Recording is
      // not granted, so fall back to something the user can act on.
      this.lastSkipReason =
        (error && error.message) || 'screen capture was refused (check Screen Recording permission)';
    } finally {
      this.busy = false;
    }
  }

  /**
   * Capture the target display -- the pinned one, or whichever the cursor is
   * on. Returns the frame and also stores it as `latest`; callers that need a
   * guaranteed-fresh frame (a question was just asked) should await this
   * rather than read `latest`.
   */
  async captureNow() {
    if (this.paused) return null;

    const display = this.targetDisplay();
    const { width: fullWidth, height: fullHeight } = coords.imageSizeFor(display);

    // Ask the OS for a already-downscaled thumbnail: cheaper than grabbing the
    // full Retina bitmap and resizing it ourselves.
    const scale = Math.min(1, TARGET_WIDTH / fullWidth);
    const thumbnailSize = {
      width: Math.round(fullWidth * scale),
      height: Math.round(fullHeight * scale),
    };

    const restore = this.hideDuringCapture ? await this.hideDuringCapture() : null;
    let sources;
    try {
      sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize,
        fetchWindowIcons: false,
      });
    } finally {
      if (restore) await restore();
    }

    // Which source actually shows which screen. Never assume the source we get
    // back is the screen we asked for: if the image comes from one monitor
    // while `frame.display` names another, every box_2d is mapped onto the
    // wrong screen and the drawings land where the user never looked.
    const picked = coords.pickSource(sources, display, screen.getAllDisplays());
    if (!picked) {
      this.lastSkipReason =
        'the system returned no capture source that could be matched to a screen';
      return null;
    }

    const { source, display: captured, substituted } = picked;
    if (source.thumbnail.isEmpty()) return null;

    if (substituted) this.noteSubstitution(display, captured);
    else this.lastSubstitution = null;

    const image = source.thumbnail;
    const size = image.getSize();
    const frame = {
      // The display this image is really of -- what the overlay routing and
      // every coordinate conversion downstream keys off.
      display: captured,
      requestedDisplay: display,
      width: size.width,
      height: size.height,
      // Held in memory only. Never written to disk.
      jpeg: image.toJPEG(JPEG_QUALITY),
      capturedAt: Date.now(),
    };

    frame.changeScore = this.scoreChange(image);
    this.lastChangeScore = frame.changeScore;
    this.latest = frame;
    return frame;
  }

  /**
   * macOS gave us a different screen than the one asked for. Say so once per
   * change: the capture still works, but it is not the screen that was pinned,
   * and silently answering about the wrong monitor is the confusing outcome.
   */
  noteSubstitution(wanted, got) {
    const key = `${wanted.id}->${got.id}`;
    if (this.lastSubstitution === key) return;
    this.lastSubstitution = key;
    this.onWrongScreen({ wanted, got });
  }

  /**
   * Mean per-pixel brightness difference against the previous frame, 0..1.
   * Used by proactive mode to decide whether the screen changed enough to be
   * worth an API call (PLAN 4.2).
   */
  scoreChange(image) {
    const small = image.resize({ width: DIFF_SIZE, height: DIFF_SIZE, quality: 'good' });
    const bitmap = small.getBitmap(); // BGRA
    const signature = new Uint8Array(DIFF_SIZE * DIFF_SIZE);
    for (let i = 0, p = 0; i < bitmap.length; i += 4, p += 1) {
      // Rough luma; the exact weights do not matter for a difference check.
      signature[p] = (bitmap[i] + bitmap[i + 1] + bitmap[i + 2]) / 3;
    }

    const previous = this.lastSignature;
    this.lastSignature = signature;
    if (!previous || previous.length !== signature.length) return 1;

    let total = 0;
    for (let i = 0; i < signature.length; i += 1) total += Math.abs(signature[i] - previous[i]);
    return total / signature.length / 255;
  }

  /**
   * Name of the frontmost app if it is on the blocklist (password managers,
   * banking apps, private windows). Resolves to null when we cannot tell --
   * this needs Accessibility permission, and failing open is the right call for
   * a feature the user can also solve with the pause hotkey.
   */
  blockedApp() {
    if (this.blocklist.length === 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile(
        'osascript',
        ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'],
        { timeout: 1000 },
        (error, stdout) => {
          if (error) return resolve(null);
          const name = stdout.trim();
          const hit = this.blocklist.some((b) => name.toLowerCase().includes(b));
          resolve(hit ? name : null);
        },
      );
    });
  }

  /** Base64 JPEG of the newest frame, for the Gemini inlineData part. */
  latestAsBase64() {
    if (!this.latest) return null;
    return {
      data: this.latest.jpeg.toString('base64'),
      mimeType: 'image/jpeg',
      display: this.latest.display,
      width: this.latest.width,
      height: this.latest.height,
      capturedAt: this.latest.capturedAt,
    };
  }
}

module.exports = { Capture, TARGET_WIDTH };
