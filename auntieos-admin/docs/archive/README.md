# Archive

Historical docs no longer current. Kept for audit trail.

## What's here

- `handoffs/` — 50 rolling session HANDOFF_*.md files (2026-05-09 to 2026-06-06). Each captured end-of-session state. Superseded by `.remember/remember.md` + the current State of the Union + memory files. (2026-06-09: the 35 stray handoffs that had accumulated at the repo root and in `docs/` were moved here.)
- `auntieOSBugsMay8.md` — May 8 bug audit (31 items). Most closed by Android UI sweep Phases 1-3 + prod data alignment work (2026-05-16 to 2026-05-17). Verified stale 2026-05-17.
- `STATE_OF_THE_UNION_2026-05-01_pre_cleanup.md` — earliest SOTU snapshot, kept for history. (Two byte-identical copies, `_web_mirror` and `_android_mirror`, were deleted 2026-06-09.)
- `plans-shipped/` — 6 superpowers plans all shipped to prod. Kept for design-decision history. Active state in memory + `.remember/now.md`.

## For current state

- **Session buffer:** `AuntieOS/.remember/now.md`
- **Audit trail:** `~/.claude/projects/.../memory/project_prod_data_alignment_audit.md`
- **Memory index:** `~/.claude/projects/.../memory/MEMORY.md`
- **Active plans:** `docs/superpowers/plans/2026-05-17-*.md` (4 plans, all shipped this session)
- **Migration logs:** `docs/migrations/`

## When to read archive

- Researching past decisions / context
- Confirming closure of an old item
- Recovering history that didn't make it into memory

## When NOT to read archive

- Treating archived items as currently open
- Looking for current bug list (use `git ls-files` + memory instead)
