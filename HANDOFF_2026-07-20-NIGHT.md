# Handoff, 2026-07-20 night

Follows `HANDOFF_2026-07-20-EVENING.md`. That one is still accurate about the
app; this one is mostly about the repos, plus one approved spec.

Nothing was deployed. No app behavior changed except user-facing punctuation.

## Start here

`web/_reference/STATE_OF_THE_UNION_2026-07-20.md` is now current and was two
days stale before tonight. The 07-19 and 07-20 sessions never bumped it.

## What shipped

**The monorepo is real and current.** `github.com/sydeast/tribetails` at
`0bc2b55`. All three prefixes verified byte-identical to their source repos by
blob hash, 2,852 files, zero differences.

**`git subtree pull` does not work here and never will.** `subtree add` rewrote
the source commits under each prefix, so the monorepo and the source repos share
no ancestry and git refuses the merge. What works, per prefix:

    git fetch <source-path> master
    git merge -X subtree=<prefix> -X theirs --allow-unrelated-histories \
      --no-edit -m "Sync <prefix>/ from source repo" FETCH_HEAD

All three prefixes are now LINKED, so the next sync is an ordinary merge and the
`--allow-unrelated-histories` flag is no longer needed. Verify with
`git merge-base HEAD FETCH_HEAD`.

**Two landmines removed.**

The owner's personal number was in two tracked docs, `HANDOFF_2026-07-20.md` and
`docs/2026-07-20-twilio-state-dump.md`, that the earlier `.env.example`
redaction never touched, plus four pushed commits. Purged from history in both
the monorepo and this repo. Verified 0 occurrences across every reachable blob.
`twilio-service/.env.example` is now untracked and gitignored, and keeps the
real number on disk for local use.

The 754MB heap dump came back. `android/java_pid68499.hprof` had been tracked
since this repo's first commit with nothing ignoring it, so the first sync
attempt pulled it into the monorepo and would have blocked the push a second
time. Untracked, `*.hprof` ignored, purged from history. `.git` went 264M to
93M. **Fix the source repo, not just the monorepo**, or every future sync
re-imports it.

**Em dashes are out of user-facing copy**, 24 files across MyTribe and AuntieOS.
Repunctuated, not reworded, so the Auntie voice is unchanged. Internal
diagnostics (exception text, Sentry `reportMessage`, JVM stubs) and the bare
em dash used as a null placeholder in tables were deliberately left alone; the
latter is a design decision, not a punctuation one. About 450 tracked files
still contain one in comments, test names, and docs.

**A test that had been red since MyTribe's first commit is green.** The PII
scrub renamed Daniels to foster but left `assertEquals("D", avatarInitial("
'foster"))`. `avatarInitial` takes the first letter-or-digit and uppercases it,
so the answer is "F". The implementation was right and the test was wrong. Note
that memory claiming "suites stayed green" after the scrub was false.

## Approved spec, not yet implemented

`auntieos-admin/docs/specs/2026-07-20-auntie-draft-buttons-design.md`

The previous handoff said KinTale "is not wired" and needs "backend
`communication_type` handling plus the React picker". Both halves were wrong:

- There is no KinTale communication type and none should be added. `visit_report`
  IS the KinTale type; `generate.js:55` calls it "Auntie's KinTale format".
- KinTale generation already ships in the Kotlin composer
  (`KinTaleComposeScreen.kt:320`). The React `KinTaleCompose.tsx` has zero
  generate wiring. The gap was a port, not a feature.

What the owner actually wants: the generator is a DRAFT tool that never sends,
and today it lives on one screen offering only Email and Text, so drafting
anything else means generate, copy, navigate, paste. The fix is a generate
button beside every compose box. Build KinTale body first, it is the only one in
daily use.

KinTale generate also produces a title drawn from the body, reusing
`TITLE_INSTRUCTION` (already exported at `aiBackfillTaleTitles.ts:41`) so live
titles and backfilled titles read the same. Stamp `titleGeneratedByAi`; never
overwrite a title the operator typed.

One backend change: make `recipient` optional rather than type-gated. Broadcast
is `communication_type: 'email'` yet has no single recipient, so type-gating
would reject it.

Out of scope by owner decision: templates, internal business notes. The 200/day
rate limit STAYS; an earlier draft argued to remove it on a wrong assumption
about usage volume.

## Open, in the order I would take them

1. **Implementation plan for the KinTale generate button**, then build it.
   `KinTaleCompose` already has a title input wired through state and save, so
   the button only sets `draft.title` when blank. The one gap:
   `titleGeneratedByAi` does not exist in `auntieos-admin` at all and
   `saveKinTaleDraft` writes a fixed field list, so carrying the marker means
   adding it to `KinTaleDraft` and the write path.
2. **Build and distribute a new APK.** Still not done since the `updatedAt` and
   versionCode fixes.
3. **Blog generation is broken.** `generateRecipient` returns `""` for
   recipient-less types and `generate.js:116` rejects empty unconditionally, so
   the Compose Communicate screen's Blog option always 400s. The `recipient`
   change above fixes it.
4. **Parity**, web + mobile only, desktop paused. See the SOTU for the real gaps.
5. **Golden screenshots record instead of assert**, so they guard nothing, and
   running `:composeApp:jvmTest` rewrites them. They will follow you into a
   commit if you `git add -A`. I had to split six of them back out tonight.
6. **`ALLOWED_TYPES` is duplicated five ways** with no test binding them.

## Gotchas that cost time tonight

- **Heredocs in the Claude Code bash tool silently drop blank lines.** Proven:
  `printf 'A\n\nB\n'` gives 3 lines, the same content via `<<'EOF'` gives 2. A
  commit message built with a heredoc loses its subject break, so git treats the
  entire message as the subject and `git log --oneline` becomes unreadable.
  Several existing commits show the damage. Write the message to a file with the
  Write tool, then `git commit -F`. This bit me twice, the second time through a
  heredoc-delivered python script.
- **Piping gradle to `tail` masks its exit code.** A failing build reported
  success. Redirect to a file and check `$?`.
- `branch-guard.sh` blocks all pushes to `main`/`master` and all force pushes.
  The operator must run them; setting the env var inside the command does not
  work because the hook runs first.
- `destructive-guard.sh` blocks `git reset --hard` (use `--keep` on a clean
  tree) and `rm` on paths it deems sensitive.
- `docs/superpowers/specs/` is gitignored in this repo, so specs written there
  are never committed. Tonight's spec went to `auntieos-admin/docs/specs/`.
- Claude CAN now run git write commands outside the session cwd. The older note
  saying otherwise is stale.
