# Archive

Historical docs no longer current. Kept for audit trail.

## What's here

Counts below are as of 2026-08-04.

- `handoffs/`, 70 rolling session HANDOFF_*.md files (2026-05-09 to 2026-07-20). Each captured end-of-session state. Superseded by `.remember/` plus the memory files. This directory is gitignored, so it exists in the main checkout and not inside a git worktree; the three 2026-07-20 files are tracked, having been added before the ignore landed. (2026-06-09: the 35 stray handoffs that had accumulated at the repo root and in `docs/` were moved here.)
- `2026-07-20-twilio-state-dump.md`, Twilio state as of 2026-07-20. The current Twilio doc is `docs/twilio/README.md` at the repo root.
- `auntieOSBugsMay8.md` — May 8 bug audit (31 items). Most closed by Android UI sweep Phases 1-3 + prod data alignment work (2026-05-16 to 2026-05-17). Verified stale 2026-05-17.
- `STATE_OF_THE_UNION_2026-05-01_pre_cleanup.md` — earliest SOTU snapshot, kept for history. (Two byte-identical copies, `_web_mirror` and `_android_mirror`, were deleted 2026-06-09.)
- `plans-shipped/`, superpowers plans shipped to prod. Kept for design-decision history.

## For current state

- **Operations:** `docs/RUNBOOK.md` at the repo root. Setup, scripts, the release run, troubleshooting.
- **Live work list:** `docs/punchlists/PUNCHLIST_2026-07-31-remaining.md`
- **Session buffer:** `.remember/now.md`
- **Memory index:** `~/.claude/projects/.../memory/MEMORY.md`
- **Plans:** `docs/superpowers/plans/`. All historical; each carries a banner saying what it was true of. Nothing in there is open work.

## When to read archive

- Researching past decisions / context
- Confirming closure of an old item
- Recovering history that didn't make it into memory

## When NOT to read archive

- Treating archived items as currently open
- Looking for current bug list (use `git ls-files` + memory instead)
