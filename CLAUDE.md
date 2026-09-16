# Project: Friday — AI Screen Guide

A macOS desktop app that watches the screen, answers voice/text questions,
and points at and draws on the screen to explain things.

The full plan is in `docs/PLAN.md`. Read it before starting any work.
User-facing setup instructions live in `README.md`.

## Stack
- Electron with plain HTML/CSS/JavaScript (no framework unless needed)
- A user-chosen vision model for vision + reasoning: Gemini (free tier),
  Ollama (local, no key), Anthropic Claude, or OpenAI
- Whisper (whisper.cpp) for speech-to-text; built-in `speechSynthesis` for TTS
- electron-builder for the `.dmg`
- Target: macOS first

## Commands
- `npm start` — run the app
- `npm run pack` — unpacked build into `dist/` (quick build check)
- `npm run dist:mac` — build the `.dmg`

## How to work
- Build one phase at a time (see "Build roadmap" in `docs/PLAN.md` §9) and stop
  after each phase so I can test it. `/phase <n>` starts one.
- After finishing a phase, tick its box in the README roadmap.
- Keep the file structure from `docs/PLAN.md` §8; keep the project small.
- The assistant's name and wake word is "Friday".
- The user picks their AI provider and enters the key in the app's setup UI on
  first launch. Keys are encrypted via Electron `safeStorage` (`src/secrets.js`)
  and never reach the renderer. `.env` still works as a fallback. Never
  hard-code or commit a key.
- Providers are declared in `src/providers.js`; adding one means an entry there
  plus a `call<Name>` method in `src/ai.js`. The setup UI builds itself from
  that registry, so it needs no changes.
- The overlay must be transparent, click-through, and always on top, and
  must not appear in the screenshots sent to the AI.
- Friday's resting state is the orb (`src/orb/`), not the chat panel. The orb
  window is resized to fit its visible content — a transparent window still
  swallows clicks in its empty area. Closing the panel hides it rather than
  destroying it, because the panel owns `speechSynthesis`.
- All screen coordinate conversion goes through `src/coords.js`
  (handle Retina scale factor and multiple monitors).
- Screenshots stay in memory only; never write them to disk.
- AI replies must follow the JSON format in `docs/PLAN.md` §4.3; parse
  defensively and fall back to text-only answers if parsing fails.

## Current state
Phases 0-4 are built and Phase 5 is partial. See `docs/PROGRESS.md` for the
authoritative status, the deviations from the plan, and what is still open.

Verified working end to end against Gemini: real capture, a real round trip,
spoken answers, and correct on-screen pointing.
`npm test` (75 unit tests) passes.

Still outstanding: OCR snapping, the "Hey Friday" wake word, proactive tips,
and the `.dmg` build.
