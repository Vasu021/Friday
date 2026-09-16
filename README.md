# Friday — AI Screen Guide

A macOS desktop app that watches your screen, listens to your voice, answers your
questions, and **points at and draws on your screen** to show you where things are
and what they mean.

> Ask *"Hey Friday, where are my playlists on YouTube?"* — Friday looks at your
> screen, moves a pointer to the left sidebar, circles **You / Library**, and
> explains it out loud. Then it cleans up after itself.

**Status: Phase 0 (setup) complete.** The app boots to a preflight window that
checks your environment. The overlay, capture, and voice pipeline come next —
see [the roadmap](#roadmap).

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
| Gemini API key | free tier — [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |

---

## Setup

```bash
git clone <this repo> && cd Friday
npm install
cp .env.example .env     # then paste your key into GEMINI_API_KEY
npm start
```

The window that opens is the **preflight checklist**. Every row should be green
before you move on. If Screen Recording or Microphone is not `granted`, click
**Open Settings** next to it, enable Friday, and restart the app — macOS only
applies these permissions on a fresh launch.

> macOS asks for Screen Recording the first time the app actually captures, which
> is Phase 2. You can grant it ahead of time from the preflight window.

---

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Launch the app |
| `npm run dev` | Launch with the `--dev` flag |
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
| Push-to-talk | `⌥ Space` (hold) |
| Clear all drawings | `⌥ C` |
| Pause / resume watching | `⌥ P` |
| Show / hide chat panel | `⌥ J` |
| Stop speaking | `Esc` |

*(Wired up in Phases 1–3.)*

---

## Privacy

This app can see your screen, so the defaults are conservative:

- Screenshots are **held in memory only** and never written to disk.
- A frame is sent to the AI **only when you ask a question** — not on a timer.
- A red **watching** dot is visible whenever capture is on; `⌥ P` stops it instantly.
- An app blocklist skips password managers, banking apps, and private browser windows.
- Your API key lives in `.env` (git-ignored); it moves to the macOS keychain in Phase 5.
- For a fully local setup, swap Gemini for an Ollama vision model (`docs/PLAN.md` §3).

Free AI tiers may use submitted data to improve their products. Read your
provider's terms before pointing this at anything sensitive.

---

## Roadmap

- [x] **Phase 0** — Project setup, dependencies, permissions preflight
- [ ] **Phase 1** — Transparent click-through overlay; hard-coded pointer demo; clear hotkey
- [ ] **Phase 2** — Screenshot + typed question → Gemini → parsed JSON → drawn annotations
- [ ] **Phase 3** — Push-to-talk → Whisper → spoken answer, synced with the pointer
- [ ] **Phase 4** — Multi-step guided tours and conversation memory
- [ ] **Phase 5** — Pointer skins, privacy mode, OCR snapping, "Hey Friday" wake word
- [ ] **Phase 6** — `.dmg` packaging

Full detail, architecture, and risk notes: [`docs/PLAN.md`](docs/PLAN.md).

---

## Project layout

```
Friday/
├── src/
│   ├── main.js          # app start, windows, hotkeys, orchestration
│   ├── preload.js       # safe bridge between main and renderer windows
│   ├── prompts/         # the Friday system prompt + JSON rules
│   ├── chat/            # chat panel UI
│   └── overlay/         # pointer animation, shapes, bubbles, auto-clear
├── skins/               # pointer characters (arrow, robot, professor)
├── docs/PLAN.md         # the full project plan
├── CLAUDE.md            # working instructions for Claude Code
└── .claude/             # shared Claude Code settings and slash commands
```

`capture.js`, `ai.js`, `voice.js`, and `coords.js` join `src/` in Phases 2–3.

---

## License

MIT — see [LICENSE](LICENSE).
