#!/usr/bin/env node
/**
 * Watches main's HEAD for a commit `ci.yml` never ran for, and dispatches it
 * before the release gate (scripts/release.sh step 0b) finds out first.
 *
 *   node scripts/ci-run-watch.mjs
 *
 * WHY THIS EXISTS (issue #838)
 * On 2026-09-13, PR #837's merge landed on main as `92786e7` during a GitHub
 * outage: the operator's merge request came back as a gateway error, but the
 * merge had actually completed server-side. It is a genuine GitHub merge, not
 * one made to look like one: `gh api repos/{owner}/{repo}/commits/92786e7
 * --jq .commit.verification` reports `verified: true`, signed with RSA key
 * `B5690EEEBB952194`, which is one of the two keys published at
 * `https://github.com/web-flow.gpg`, GitHub's own merge-commit identity.
 * But the bookkeeping a normal merge performs alongside that git write never
 * finished: PR #837 was never marked merged (`gh pr view 837` shows it
 * CLOSED, `mergedAt`/`mergeCommit` both null; the operator closed it by hand
 * after confirming the commit had landed via `git merge-base --is-ancestor`),
 * and the `push` event `ci.yml`'s `on: push` listens for never fired.
 * `gh api repos/{owner}/{repo}/commits/92786e7/check-suites` shows exactly
 * ONE check suite for this SHA: the 19:45 `workflow_dispatch` run
 * (34778646429) the operator started by hand hours later. A push-triggered
 * run creates its own suite, so its total absence is proof no push event was
 * ever delivered for this commit, not merely a hint. `main-channel.yml` (also
 * `on: push`, and PR #837 touched `mytribe/web/src/lib/moneyIdempotency.ts`,
 * matching its path filter) shows the same zero runs for this SHA, so the
 * absence is not specific to ci.yml's own config. The commit's message
 * carries no `[skip ci]` marker, `ci.yml`'s `push` concurrency group keys on
 * `github.run_id` (unique per run, so it cannot itself have swallowed the
 * run), and the repository requires no status checks (`branches/main/
 * protection` 404s), so none of those repo-side knobs caused it either.
 * Nobody noticed until `scripts/release.sh` refused hours later with "GitHub
 * reports no check runs at all". This exists to notice in minutes instead of
 * at release time.
 *
 * WHY A SCHEDULE, NOT A PUSH OR CHECK-SUITE TRIGGER
 * Whatever swallowed 92786e7's `push` event runs through the same delivery
 * pipeline a `push`- or `check_suite`-triggered watcher would depend on. A
 * schedule is independent of it: cron ticks come from GitHub's scheduler, not
 * from a webhook the same outage could also drop.
 *
 * WHY THIS ASKS `actions/workflows/ci.yml/runs?head_sha=<sha>` AND NOT
 * `commits/<sha>/check-runs` (PR #856 review; the first version of this
 * script used the latter, and it was broken).
 * `commits/<sha>/check-runs` counts EVERY check run on a commit, regardless
 * of which workflow created it. In production that total is never zero: this
 * very workflow's own "watch" job puts a check run on main's HEAD before its
 * script step even runs (a workflow run is attributed to the commit it
 * evaluated against, schedule triggers included), and `main-channel.yml`'s
 * push-triggered run does too. Reading that count made the first version of
 * this script return 'ok' unconditionally and never dispatch anything.
 * `actions/workflows/ci.yml/runs?head_sha=<sha>` is scoped to ci.yml
 * specifically, so a run of any OTHER workflow for the same SHA (this
 * watcher's own, main-channel's, a future one) never appears in it, however
 * many of them exist. That scoping also does double duty as the guard against
 * re-dispatching: a run this watcher already dispatched for a SHA shows up in
 * this same query on the next tick, whatever its status, so there is no
 * separate "already dispatched" check to maintain.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

// How stale a run-less HEAD has to be before this dispatches CI for it. Below
// this, a commit merged 90 seconds ago just hasn't had ci.yml's run created
// yet, and dispatching would race the normal push trigger.
export const DEFAULT_MAX_AGE_MINUTES = 10;

// How often the schedule ticks (`.github/workflows/ci-run-watch.yml`), named
// here only so a comment can point at the one true number instead of a second
// copy of it.
export const SCHEDULE_MINUTES = 20;

/**
 * decideForHead({ commit, ciRuns, nowMs, maxAgeMinutes }) -> { action, sha,
 * ageMinutes, reason }
 *
 * action is one of:
 *   'ok'        ci.yml has at least one run on record for this SHA, of any
 *               event or status: queued, in progress, completed, cancelled,
 *               failed. Nothing to do here either way; a red or pending
 *               verdict is release.sh step 0b's job, not this script's. This
 *               also covers "already dispatched": a run this watcher fired on
 *               a previous tick is a run, so it reads as 'ok' too, and does
 *               not get fired a second time.
 *   'too_new'   no ci.yml run yet, but the commit is younger than
 *               maxAgeMinutes. Its run may simply not exist yet; wait for the
 *               next tick rather than race the normal push trigger.
 *   'dispatch'  no ci.yml run, old enough, nothing on record.
 *
 * `commit`  the response of `gh api repos/{owner}/{repo}/commits/<ref>`
 * `ciRuns`  the response of
 *           `gh api repos/{owner}/{repo}/actions/workflows/ci.yml/runs?head_sha=<sha>`
 * `nowMs`   current time in epoch ms, injected so tests do not race the clock
 * `maxAgeMinutes` defaults to DEFAULT_MAX_AGE_MINUTES
 */
export function decideForHead({ commit, ciRuns, nowMs, maxAgeMinutes = DEFAULT_MAX_AGE_MINUTES }) {
  const sha = commit.sha;
  const committedAtRaw = commit.commit?.committer?.date ?? commit.commit?.author?.date;
  const committedAtMs = Date.parse(committedAtRaw);
  const ageMinutes = (nowMs - committedAtMs) / 60000;

  const runs = ciRuns?.workflow_runs ?? [];
  const totalRuns = ciRuns?.total_count ?? runs.length;
  if (totalRuns > 0) {
    return {
      action: 'ok',
      sha,
      ageMinutes,
      reason: `${totalRuns} ci.yml run(s) already on record for ${sha}.`,
    };
  }

  if (!(ageMinutes >= maxAgeMinutes)) {
    return {
      action: 'too_new',
      sha,
      ageMinutes,
      reason: `${sha} is ${ageMinutes.toFixed(1)} min old (< ${maxAgeMinutes}), no ci.yml runs yet. Its run may not exist yet; waiting.`,
    };
  }

  return {
    action: 'dispatch',
    sha,
    ageMinutes,
    reason: `${sha} is ${ageMinutes.toFixed(1)} min old with zero ci.yml runs on record.`,
  };
}

// --- CLI --------------------------------------------------------------

function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

function writeSummary(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  fs.appendFileSync(file, lines.join('\n') + '\n');
}

export async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set.');

  const commit = ghJson(['api', `repos/${repo}/commits/main`]);
  const ciRuns = ghJson([
    'api',
    `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${commit.sha}&per_page=100`,
  ]);

  const decision = decideForHead({ commit, ciRuns, nowMs: Date.now() });
  console.log(`ci-run-watch: ${decision.action}: ${decision.reason}`);

  if (decision.action === 'dispatch') {
    gh(['workflow', 'run', 'ci.yml', '--ref', 'main']);
    console.log(`ci-run-watch: dispatched ci.yml for ${decision.sha}`);
    writeSummary([
      '## CI run watch',
      '',
      `:warning: main's HEAD \`${decision.sha}\` had zero ci.yml runs after ` +
        `${decision.ageMinutes.toFixed(1)} minutes. Dispatched \`ci.yml --ref main\` ` +
        'to give it a verdict. See issue #838 for why this can happen (a GitHub ' +
        'outage can land a merge commit without firing the push event that starts CI).',
    ]);
  }

  return 0;
}

const invokedAs = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invokedAs === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
