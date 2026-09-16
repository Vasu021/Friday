# Project: Friday — AI Screen Guide

A macOS desktop app that watches the screen, answers voice/text questions,
and points at and draws on the screen to explain things.

The full plan is in `docs/PLAN.md`. Read it before starting any work.
User-facing setup instructions live in `README.md`.

## Stack
- Electron with plain HTML/CSS/JavaScript (no framework unless needed)
- Google Gemini API (free tier, Flash-tier vision model) for vision + reasoning
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
- The API key comes from `.env` (`GEMINI_API_KEY`); never hard-code or commit it.
- The overlay must be transparent, click-through, and always on top, and
  must not appear in the screenshots sent to the AI.
- All screen coordinate conversion goes through `src/coords.js`
  (handle Retina scale factor and multiple monitors).
- Screenshots stay in memory only; never write them to disk.
- AI replies must follow the JSON format in `docs/PLAN.md` §4.3; parse
  defensively and fall back to text-only answers if parsing fails.

## Current state
Phase 0 (setup) is done: dependencies installed, build config in place, and
`npm start` opens a preflight window that reports the Electron version, whether
`GEMINI_API_KEY` loaded, and the macOS Screen Recording / Microphone permission
status. `src/main.js` and `src/chat/` hold only that preflight code — Phase 1
replaces it with the real windows and hotkeys.
