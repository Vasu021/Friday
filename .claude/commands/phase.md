---
description: Start work on a build phase from docs/PLAN.md
argument-hint: <phase number, e.g. 1>
---

Read `docs/PLAN.md` (especially §9 "Build roadmap") and `CLAUDE.md`, then
implement **Phase $1** — and only that phase.

Before writing code:
1. Summarise what Phase $1 must deliver and which files from §8 it touches.
2. Note anything that must NOT move yet (later phases).

While building:
- Keep to the file structure in §8; do not add files outside it without saying why.
- Keep the code plain JS, small, and commented only where the reason isn't obvious.

When done:
- Tell me exactly how to test it by hand.
- Update the phase checklist in `README.md`.
- **Stop.** Do not start the next phase.
