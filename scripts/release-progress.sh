#!/usr/bin/env bash
# release-progress.sh: the per-commit record a stopped release resumes from
# (#840). SOURCED, never run, by:
#
#   scripts/release.sh     writes it as steps complete, and skips what it records
#   scripts/release-bg.sh  reads it, so a resumed detached run is not refused for
#                          an index change an earlier run already got past
#
# ONE COPY OF THE RULE, ON PURPOSE. Both scripts ask the same question: did an
# earlier run of THIS commit finish this step? If each kept its own answer, one
# would sooner or later skip on a condition the other no longer accepts, and the
# detached wrapper waving through something release.sh would redo is exactly
# that drift.
#
# THE COMMIT IS RELEASE_SHA, NEVER A FRESH READ OF HEAD. The caller pins it once
# when it starts. A release runs 20 to 40 minutes in a checkout the agent shell
# and the operator's terminal both use, so reading HEAD at the moment of marking
# would record commit B as done for work commit A deployed. Nothing here falls
# back to HEAD: with RELEASE_SHA unset, nothing is recorded and nothing resumes.
#
# The caller sets ROOT (the repo root) and RELEASE_SHA before using these. The
# file holds one "<full sha> <step>" line per completed step, for one commit at a
# time. It is gitignored and per machine, like .release-state.

PROGRESS_FILE="$ROOT/.release-progress"

# Diagnostics go to stderr, and not through the callers' colour helpers, so the
# file works the same from either script.
progress_say() {
  printf '\033[33m%s\033[0m\n' "$*" >&2
}

progress_sha_ok() {
  if [ -z "${RELEASE_SHA:-}" ]; then
    progress_say "release-progress: RELEASE_SHA is not set, so nothing is recorded or resumed."
    return 1
  fi
  return 0
}

# progress_mark <step>: record that <step> completed for RELEASE_SHA. Lines for
# any other commit are dropped first, so the file only ever describes one
# release. A dry run records nothing: this file makes a later run SKIP work,
# which is the same reason a dry run never writes .release-state.
progress_mark() {
  local key="$1"
  if [ "${DRY_RUN:-0}" = "1" ]; then
    return 0
  fi
  progress_sha_ok || return 0
  if [ -f "$PROGRESS_FILE" ] &&
     ! awk -v s="$RELEASE_SHA" '$1 != s { other = 1 } END { exit other ? 1 : 0 }' "$PROGRESS_FILE" 2>/dev/null; then
    : > "$PROGRESS_FILE" 2>/dev/null || true
  fi
  if ! grep -qxF "$RELEASE_SHA $key" "$PROGRESS_FILE" 2>/dev/null; then
    printf '%s %s\n' "$RELEASE_SHA" "$key" >> "$PROGRESS_FILE" 2>/dev/null ||
      progress_say "could not record '$key' in .release-progress; a rerun will redo it."
  fi
  return 0
}

# progress_forget <step>: drop <step> for RELEASE_SHA, when a later result
# supersedes it (a verified deploy replacing an unverified one).
progress_forget() {
  local key="$1" tmp
  if [ "${DRY_RUN:-0}" = "1" ] || [ -z "${RELEASE_SHA:-}" ] || [ ! -f "$PROGRESS_FILE" ]; then
    return 0
  fi
  tmp="$PROGRESS_FILE.tmp.$$"
  grep -vxF "$RELEASE_SHA $key" "$PROGRESS_FILE" > "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$PROGRESS_FILE" 2>/dev/null || rm -f "$tmp"
  return 0
}

# progress_has <step>: whether <step> is recorded for RELEASE_SHA. A plain
# lookup for wording ("confirmed" or not); it decides no skip and prints nothing.
progress_has() {
  if [ -z "${RELEASE_SHA:-}" ] || [ ! -f "$PROGRESS_FILE" ]; then
    return 1
  fi
  grep -qxF "$RELEASE_SHA $1" "$PROGRESS_FILE" 2>/dev/null
}

# progress_done <step>: true only when ALL of these hold:
#   - <step> is recorded against RELEASE_SHA (a different commit never skips),
#   - RELEASE_NO_RESUME is not 1,
#   - the working tree is clean (release.sh refuses a dirty tree at step 0
#     anyway; this rule does not lean on that, and release-bg.sh has no step 0).
#
# With no record for <step> at all it says nothing. With a record that it
# refuses to resume from, it prints which check failed, so an operator who
# expected a resume can see why it did not happen.
progress_done() {
  local key="$1" recorded dirty
  progress_sha_ok || return 1
  [ -f "$PROGRESS_FILE" ] || return 1
  if grep -qxF "$RELEASE_SHA $key" "$PROGRESS_FILE" 2>/dev/null; then
    recorded="$RELEASE_SHA"
  else
    recorded="$(awk -v k="$key" '$2 == k { print $1; exit }' "$PROGRESS_FILE" 2>/dev/null || true)"
  fi
  [ -n "$recorded" ] || return 1

  if [ "${RELEASE_NO_RESUME:-0}" = "1" ]; then
    progress_say "not resuming '$key': RELEASE_NO_RESUME=1 is set, so it runs again."
    return 1
  fi
  if [ "$recorded" != "$RELEASE_SHA" ]; then
    progress_say "not resuming '$key': it is recorded for ${recorded:0:7}, and this release is ${RELEASE_SHA:0:7}. A different commit never resumes."
    return 1
  fi
  if ! dirty="$(git -C "$ROOT" status --porcelain 2>/dev/null)"; then
    progress_say "not resuming '$key': git status could not be read, so the tree cannot be shown to be clean."
    return 1
  fi
  if [ -n "$dirty" ]; then
    progress_say "not resuming '$key': the working tree is not clean:"
    git -C "$ROOT" status --short >&2 2>/dev/null || true
    return 1
  fi
  return 0
}
