#!/usr/bin/env bash
# release-progress.sh: the per-commit record a stopped release resumes from
# (#840). SOURCED, never run, by:
#
#   scripts/release.sh     writes it as steps complete, and skips what it records
#   scripts/release-bg.sh  reads it, so a resumed detached run is not refused for
#                          an index change whose step 3 an earlier run already
#                          passed
#
# ONE COPY OF THE RULE, ON PURPOSE. Both scripts ask the same question: did an
# earlier run of THIS commit finish this step? If each kept its own answer, one
# would sooner or later skip on a condition the other no longer accepts, and the
# detached wrapper waving through something release.sh would redo is exactly
# that drift.
#
# The caller sets ROOT (the repo root) before sourcing. The file holds one
# "<full sha> <step>" line per completed step, for one commit at a time. It is
# gitignored and per machine, like .release-state.

PROGRESS_FILE="$ROOT/.release-progress"

# progress_mark <step>: record that <step> completed for HEAD. Lines for any
# other commit are dropped first, so the file only ever describes one release.
# A dry run records nothing: this file makes a later run SKIP work, which is the
# same reason a dry run never writes .release-state.
progress_mark() {
  local key="$1" sha
  if [ "${DRY_RUN:-0}" = "1" ]; then
    return 0
  fi
  sha="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
  [ -n "$sha" ] || return 0
  if [ -f "$PROGRESS_FILE" ] &&
     ! awk -v s="$sha" '$1 != s { other = 1 } END { exit other ? 1 : 0 }' "$PROGRESS_FILE" 2>/dev/null; then
    : > "$PROGRESS_FILE" 2>/dev/null || true
  fi
  if ! grep -qxF "$sha $key" "$PROGRESS_FILE" 2>/dev/null; then
    printf '%s %s\n' "$sha" "$key" >> "$PROGRESS_FILE" 2>/dev/null ||
      printf '\033[33m%s\033[0m\n' "could not record '$key' in .release-progress; a rerun will redo it."
  fi
  return 0
}

# progress_done <step>: true only when ALL of these hold:
#   - RELEASE_NO_RESUME is not 1,
#   - <step> is recorded against the EXACT commit at HEAD (a different commit
#     never skips anything),
#   - the working tree is clean (release.sh refuses a dirty tree at step 0
#     anyway; this rule does not lean on that, and release-bg.sh has no step 0).
progress_done() {
  local key="$1" sha dirty
  [ "${RELEASE_NO_RESUME:-0}" = "1" ] && return 1
  [ -f "$PROGRESS_FILE" ] || return 1
  dirty="$(git -C "$ROOT" status --porcelain 2>/dev/null)" || return 1
  [ -z "$dirty" ] || return 1
  sha="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" || return 1
  grep -qxF "$sha $key" "$PROGRESS_FILE" 2>/dev/null
}
