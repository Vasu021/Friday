# Friday — build status

Last updated: 2026-09-16 (provider picker + keychain)

Tracks [`PLAN.md`](PLAN.md) §9. Legend: **Done** = built and checked as far as
this machine allows · **Partial** = usable, with a named gap · **Not started**.

> **Scope note.** `CLAUDE.md` says to build one phase at a time and stop for
> testing. That was overridden by a direct instruction to build the whole tool
> in one pass, so Phases 1–5 landed together without a test gate between them.
> Nothing here has been committed.

---

## At a glance

| Phase | Status | Notes |
|---|---|---|
| 0 — Setup | **Done** | Deps installed, build config, preflight |
| 1 — Overlay proof of concept | **Done** | Not visually confirmed — see *Unverified* |
| 2 — See and answer | **Done (blocked on verification)** | Capture path untestable here |
| 3 — Voice | **Done, with a deviation** | Toggle-to-talk, not hold |
| 4 — Guided explanations | **Done** | Multi-step tours + memory |
| 5 — Polish | **Partial** | No OCR snapping, no wake word. Keychain done |
| 6 — Package | **Partial** | Config written, `.dmg` never built |

---

## ⚠️ Read this first — what I could not verify

Three things blocked end-to-end testing on this machine. None indicate a known
bug; they mean **nobody has watched this app actually work yet.**

1. ~~**Screen Recording is `denied`.**~~ **Resolved.** Screen Recording is now
   granted and a real frame has been captured — confirmed by `scoreChange()`
   running, which sits behind a non-empty-thumbnail guard.
2. **No live round trip to any provider.** The request-building and
   response-parsing code is covered by unit tests against recorded shapes, but
   no real answer has come back from Gemini, Claude, OpenAI or Ollama. The
   setup screen's **Save and test** button does exactly this check.
3. **No visual confirmation.** The app boots clean with zero renderer or preload
   errors, but I cannot see the screen, so the overlay's pointer, shapes and
   bubble have never been looked at by anyone.

**Everything else below is written and syntax-clean; treat "Done" as "built and
unit-tested", not "seen working".**

### How to verify, in order

```bash
npm test                 # 45 unit tests, no permissions or network needed
npm run dev              # renderer errors print to the terminal in --dev
```

Friday asks for a provider and key on first launch — no `.env` step.

Then, in the app:

1. Open **⚙ Settings**. Click **Fix** next to Screen Recording, enable Friday,
   and **restart** — macOS only applies the permission on a fresh launch.
2. Type *"where are my playlists"* on a YouTube page. Expect a spoken answer and
   a circle around the left sidebar.
3. Press **⌥Space**, say something, stop talking. It auto-stops after ~1.6s of
   silence and asks the question.
4. Press **⌥C** mid-answer — every drawing should vanish at once.
5. Press **⌥P**. The red *watching* dot should disappear and questions should be
   refused until you resume.

---

## What is done

### Phase 1 — Overlay
- One transparent, frameless, click-through overlay **per display**, rebuilt on
  monitor add/remove/resize.
- `alwaysOnTop('screen-saver')` so it sits above full-screen apps;
  `focusable: false` + `showInactive()` so it never steals focus.
- `setContentProtection(true)` to keep the overlay out of captures, **plus** a
  fallback that hides the overlays during a grab — but only when something is
  actually drawn, so there is no periodic flicker while idle.
- Shapes: `circle`, `box`, `arrow`, `underline`, `text_label`, drawn as SVG with
  a stroke-dash draw-in animation. Highlights are padded ~10px because vision
  models miss by a few pixels (PLAN §4.4 v1).
- Pointer with `idle` / `moving` / `pointing` / `thinking` / `talking` states,
  a positioned speech bubble that keeps itself on screen, and the red *watching*
  dot. Honours `prefers-reduced-motion`.

### Phase 2 — See and answer
- `capture.js`: grabs the display **under the cursor**, downscales to ~1280px
  wide, JPEG q72. Frames are held in memory only and never written to disk.
- Cheap 32×32 grayscale change-detection score for future proactive tips.
- `ai.js`: builds the request, calls Gemini with `responseMimeType:
  'application/json'`, and falls back down a model list
  (`gemini-flash-latest` → `2.5-flash` → `2.0-flash`) if a name is retired.
- Defensive parsing, as required by `CLAUDE.md`: strips code fences, walks
  braces to find the outermost JSON object (so trailing prose is ignored),
  validates every step, drops unusable ones, clamps durations, and degrades to a
  **text-only answer** rather than throwing.
- Friendly error text for rate limits, bad keys, and offline.

### Phase 3 — Voice
- **⌥Space** toggles recording. Auto-stops after ~1.6s of silence (WebAudio RMS)
  with a 30s hard cap; sub-1.2KB clips are discarded as misfires.
- Speech-to-text via Gemini by default. A local **whisper.cpp** binary is used
  instead when `WHISPER_BIN` and `WHISPER_MODEL` are set.
- TTS through the built-in `speechSynthesis`. The overlay's auto-clear countdown
  starts when *speech* ends, not when the last step ends, so a long answer is
  never cut off by a short step list.

### Phase 4 — Guided explanations
- Multi-step tours run sequentially with per-step `duration_ms`; a run token
  cancels an in-flight tour if a new answer or a clear arrives.
- Conversation memory: last 12 turns, sent as Gemini `contents` history.
- **Chat Only** sends no screenshot at all and stops the capture timer. Guide
  mode covers the rest: it returns a multi-step tour whenever the answer needs
  one, so the tour behaviour survived the removal of the Explain tab.

### Phase 5 — Polish (partial)
- **The orb.** Friday's resting state is a draggable 64px ball, always on top
  and visible over full-screen apps. Hover expands it leftward into a prompt
  tray (ask without opening anything); click opens the panel; drag moves it and
  the position persists. The ball mirrors state — pulsing while thinking, green
  while listening, grey when paused, with the red *watching* dot.
  - The window is **resized to fit what is showing** rather than being a fixed
    transparent frame, because a transparent window still swallows clicks in
    its empty area. The tray grows leftward so the ball never moves under the
    cursor.
  - The ball is deliberately **not** a `-webkit-app-region: drag` region: drag
    regions swallow click events on macOS, and it has to be both. `orb.js`
    separates click from drag by distance (3px).
  - Closing the panel now **hides** it instead of destroying it — the panel
    owns `speechSynthesis`, which the orb needs to speak answers.
- **Screen selection.** Settings → *Screen Friday watches* pins capture to one
  display, or follows the cursor (the default). Pinning is what lets you ask
  about an external monitor while typing on the laptop. The choice survives a
  restart; unplugging the pinned screen falls back to the cursor and says so
  rather than failing every capture. `coords.chooseDisplay()` holds the
  decision so it is unit-tested; Electron's `screen` API is cross-platform, so
  this works on Windows too.
- **Voice picker.** macOS ships a compressed default voice; Friday now prefers
  Premium/Enhanced voices when installed and lets you choose one explicitly.
- **In-app provider setup.** First launch asks which AI to use — Gemini,
  Ollama, Claude or OpenAI — and takes the key in the UI. No `.env` editing.
  Providers are declared once in `src/providers.js`; the picker builds itself
  from that registry, and `src/ai.js` holds one `call*` method per provider.
- **Keys in the keychain** (PLAN §7, previously outstanding). `src/secrets.js`
  encrypts with Electron `safeStorage`, so what lands on disk is ciphertext
  only this user on this Mac can read. Keys are never sent to the renderer —
  it only learns *whether* one exists. `.env` still works as a fallback.
- Providers that cannot transcribe audio (Claude, Ollama) disable the mic and
  say why, rather than failing at the moment someone presses ⌥Space.
- Three pointer skins (`arrow`, `robot`, `professor`) as `skin.json` + CSS, so
  they render with no binary art to ship. The schema takes an image/Lottie path
  later without changing the loader.
- Pause/privacy mode with the visible red dot; pausing also drops the held frame
  so a paused app is not sitting on a stale screenshot.
- App blocklist matched against the frontmost app name via `osascript`. **Fails
  open** if Accessibility is not granted — it is a convenience on top of the
  pause hotkey, not a security boundary.
- Settings panel: skin, speak on/off, capture interval, blocklist, plus live
  permission status with a deep link to the right System Settings pane.
- Settings persist to `userData/settings.json`.

### Testing
- **45 unit tests**, `npm test`, no permissions or network needed.
  - `test/coords.test.js` (15) — the Retina invariant (a normalized box gives
    the same DIP rect at 1× and 2×), negative-origin second monitors, corner
    repair, clamping, padding inside bounds.
  - `test/ai.test.js` (15) — clean JSON, fenced JSON, JSON wrapped in prose,
    truncated JSON, prose-only, brace-inside-string, step capping.
  - `test/providers.test.js` (15) — the registry contract, provider/key
    resolution, STT capability per provider, client invalidation on switch,
    and that no credential-shaped field reaches the renderer.

---

## What is left

### Deliberately skipped
| Item | Why |
|---|---|
| **OCR snapping** (PLAN §4.4 v2) | Tesseract.js is a heavy dependency and slow per frame. The padded-highlight approach (v1) ships first; worth adding only if pointing proves too imprecise in real use. |
| **Set-of-Marks prompting** (§4.4 v3) | Depends on element detection that does not exist yet. |

### Blocked on you
| Item | What is needed |
|---|---|
| **"Hey Friday" wake word** | No off-the-shelf model exists. Needs a Picovoice console account for a custom keyword, or an openWakeWord training run. Cannot be done without your account. |
| **`.dmg` build** | `electron-builder.yml` is written but `npm run dist:mac` has never been run. |

### Still to do
| Item | Notes |
|---|---|
| **Proactive tips** | The change-detection score is computed and unused; nothing sends a frame unprompted. |
| **Gemini Live API** | Future idea (§12), would replace the whole STT/TTS path. |
| **Windows / Linux** | macOS-only paths: `osascript` blocklist, the System Settings deep links, `titleBarStyle: 'hiddenInset'`. |

---

## Deviations from the plan

Each of these is a considered trade-off, not an oversight.

1. **Push-to-talk is toggle, not hold.** Electron's `globalShortcut` only
   reports key-*down* — there is no key-up event, so "hold ⌥Space" is not
   achievable with it. ⌥Space starts recording and silence detection ends it.
   True hold-to-talk needs a native key-event listener (`uiohook-napi`) and
   Accessibility permission.
2. **`Esc` to stop speaking works only when the chat panel has focus.**
   Registering `Esc` as a *global* shortcut would swallow it system-wide and
   break every other app. **⌥.** is the global equivalent.
3. **Speech-to-text defaults to Gemini, not whisper.cpp.** PLAN §4.5 prefers
   local Whisper, but that needs a binary and a model file installed by hand.
   Gemini works with the key you already have; whisper.cpp takes over when
   `WHISPER_BIN` and `WHISPER_MODEL` are set.
4. **The whisper.cpp path writes a temp `.wav`.** The no-disk rule in
   `CLAUDE.md` covers screenshots; a local binary has no other way to receive
   audio. It is written `0o600` and deleted in a `finally` block. Screenshots
   still never touch disk.
5. **There is no Explain mode.** PLAN 5 lists it as a third mode, but it only
   ever added one line to the prompt asking for a guided tour -- and guide mode
   already returns multi-step tours on its own. Two modes say the real
   distinction: Friday either looks at your screen or it does not. Removed at
   the user's request.
6. **Skins are CSS, not artwork.** No original character art exists yet, and
   PLAN §4.6 rules out shipping a copyrighted one.
