# Friday — AI Screen Guide

A macOS desktop app that watches your screen, listens to your voice, answers your
questions, and **points at and draws on your screen** to show you where things are
and what they mean.

> Ask *"Hey Friday, where are my playlists on YouTube?"* — Friday looks at your
> screen, moves a pointer to the left sidebar, circles **You / Library**, and
> explains it out loud. Then it cleans up after itself.

**Status: feature-complete MVP, not yet verified end to end.** Every phase
through 5 is built, but Screen Recording was denied and no API key was present
on the build machine, so nobody has watched it take a real screenshot or answer
a real question yet. Read [`docs/PROGRESS.md`](docs/PROGRESS.md) before you
start — it lists exactly what is proven, what is assumed, and how to check.

---

## Why a desktop app

Drawing on top of *any* other app requires a transparent, click-through,
always-on-top window. A website can't do that, and mobile OSes won't allow it.
Full reasoning in [`docs/PLAN.md`](docs/PLAN.md) §2.

---

## Requirements

| | |
|---|---|
| macOS | 12 or newer (Apple Silicon or Intel) |
| Node.js | 20 or newer (`node -v`) |
| An AI provider | Gemini (free tier), Ollama (local, no key), Claude, or OpenAI — Friday asks on first launch |

---

## Setup

```bash
git clone <this repo> && cd Friday
npm install
npm start
```

On first launch Friday asks which AI you want to use and, if that provider
needs one, for an API key. The key is encrypted with the macOS keychain and
stored on this Mac only — there is no `.env` to edit. You can change provider
any time from **⚙ Settings → AI provider → Change**.

| Provider | Key needed | Voice |
|---|---|---|
| **Google Gemini** | yes — free tier | yes |
| **Ollama** (runs on your Mac) | no | needs whisper.cpp |
| **Anthropic Claude** | yes — paid | needs whisper.cpp |
| **OpenAI** | yes — paid | yes |

Claude and Ollama accept images but not audio, so with those the mic button
stays disabled unless you have a local whisper.cpp configured. Friday tells you
this in the UI rather than failing when you press the key.

Then open **⚙ Settings** in the panel. Every row at the bottom should be
green. If Screen Recording or Microphone is not `granted`, click **Fix** next to
it, enable Friday, then **restart the app** — macOS only applies these
permissions on a fresh launch.

Then ask it something about what is on your screen.

---

## The orb

Friday lives as a small ball floating above your other windows, not as a panel
you have to keep around.

| Do this | Get this |
|---|---|
| **Hover** the ball | It opens a prompt — type a question, press Enter |
| **Click** the ball | The full panel opens (click again to send it away) |
| **Drag** the ball | Move it anywhere; the spot is remembered |

The ball shows what Friday is doing without you having to look at anything
else: it pulses while thinking, turns green while listening, goes grey when
paused, and carries a red dot whenever it can see your screen.

Closing the panel does not quit Friday — it goes back to being the ball.
Quit with **⌘Q**.

---

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Launch the app |
| `npm run dev` | Launch with renderer errors printed to the terminal |
| `npm test` | Run the unit tests (no permissions or network needed) |
| `npm run pack` | Build an unpacked app into `dist/` (fast, for testing the build) |
| `npm run dist:mac` | Build the `.dmg` |

Builds are unsigned, which is fine for personal use — right-click → **Open** the
first time. Public distribution needs an Apple Developer account ($99/yr); that
is the only non-free part of this project and it is optional.

---

## How it works

```
screen capture (every 2-3s, in memory)  ─┐
push-to-talk → Whisper → question text  ─┼─→  Gemini (vision)  ─→  JSON
typed question from the chat panel      ─┘                          │
                                                                    ▼
                          speech (TTS)  +  pointer / circles / bubbles on the overlay
```

Gemini replies with strict JSON — a spoken answer plus a list of draw steps with
normalized `box_2d` coordinates. `src/coords.js` turns those into real screen
pixels (handling Retina scaling and multiple monitors), and the overlay animates
them and clears itself when the speech ends. Format details: `docs/PLAN.md` §4.3.

---

## Controls

| Action | Hotkey |
|---|---|
| Talk to Friday | `⌥ Space` (press, then just stop talking) |
| Clear all drawings | `⌥ C` |
| Pause / resume watching | `⌥ P` |
| Show / hide chat panel | `⌥ J` |
| Stop speaking | `Esc` (panel focused) or `⌥ .` |

Two differ from the original plan, for reasons in
[`docs/PROGRESS.md`](docs/PROGRESS.md): **⌥Space is a toggle, not a hold**
(Electron global shortcuts have no key-up event, so recording stops on ~1.6s of
silence), and **`Esc` only works when the chat panel has focus** — the global
equivalent is **⌥.**, because claiming `Esc` system-wide would break every other
app.

---

## Privacy

This app can see your screen, so the defaults are conservative:

- Screenshots are **held in memory only** and never written to disk.
- A frame is sent to the AI **only when you ask a question** — not on a timer.
- A red **watching** dot is visible whenever capture is on; `⌥ P` stops it instantly.
- On a multi-monitor setup, **Settings → Screen Friday watches** pins capture to
  a single display; only that screen is ever sent.
- An app blocklist skips password managers, banking apps, and private browser windows.
- Your API key is **encrypted via the macOS keychain** (Electron `safeStorage`) and never leaves this Mac.
- For a fully local setup, pick **Ollama** in the setup screen — no key, and nothing leaves your machine.

Free AI tiers may use submitted data to improve their products. Read your
provider's terms before pointing this at anything sensitive.

---

## Roadmap

- [x] **Phase 0** — Project setup, dependencies, permissions preflight
- [x] **Phase 1** — Transparent click-through overlay, pointer, shapes, bubbles, clear hotkey
- [x] **Phase 2** — Screenshot + typed question → Gemini → parsed JSON → drawn annotations
- [x] **Phase 3** — Voice in → transcript → spoken answer, synced with the pointer
- [x] **Phase 4** — Multi-step guided tours and conversation memory
- [ ] **Phase 5** — Orb, skins, privacy mode, in-app provider setup, keychain
      storage, screen selection and voice picker done; **OCR snapping and the
      "Hey Friday" wake word are not**
- [ ] **Phase 6** — `.dmg` config written, build never run

Status detail and known gaps: [`docs/PROGRESS.md`](docs/PROGRESS.md).
Architecture and risk notes: [`docs/PLAN.md`](docs/PLAN.md).

---

## Project layout

```
Friday/
├── src/
│   ├── main.js          # app start, windows, hotkeys, orchestration
│   ├── capture.js       # screenshots, change detection, downscaling
│   ├── ai.js            # prompt building, Gemini/Ollama calls, JSON parsing
│   ├── voice.js         # speech-to-text (Gemini, or local whisper.cpp)
│   ├── coords.js        # box_2d → screen pixels (Retina, multi-monitor)
│   ├── preload.js       # safe bridge between main and renderer windows
│   ├── prompts/         # the Friday system prompt + JSON rules
│   ├── chat/            # chat panel, mic, TTS, settings
│   └── overlay/         # pointer animation, shapes, bubbles, auto-clear
├── test/                # unit tests for coords.js and the JSON parser
├── skins/               # pointer skins (arrow, robot, professor)
├── docs/
│   ├── PLAN.md          # the full project plan
│   └── PROGRESS.md      # what is done, what is left, known gaps
├── CLAUDE.md            # working instructions for Claude Code
└── .claude/             # shared Claude Code settings and slash commands
```

---

## License

MIT — see [LICENSE](LICENSE).
