#!/usr/bin/env node
/**
 * Watches main's HEAD for a commit CI never judged, and dispatches `ci.yml`
 * for it before the release gate (scripts/release.sh step 0b) finds out first.
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
 * ever delivered for this commit, not merely a hint. (The public events feed,
 * `gh api repos/{owner}/{repo}/events`, also shows no PushEvent for this SHA
 * and no "merged" action for PR #837, consistent with the outage, though
 * that feed is documented as best-effort, so it corroborates rather than
 * proves.) `ci.yml`'s commit message carries no `[skip ci]` marker, its
 * `push` concurrency group keys on `github.run_id` (unique per run, so it
 * cannot itself have swallowed the run), and the repository requires no
 * status checks (`branches/main/protection` 404s), so none of those
 * repo-side knobs caused it either. Nobody noticed until `scripts/release.sh`
 * refused hours later with "GitHub reports no check runs at all". This
 * exists to notice in minutes instead of at release time.
 *
 * WHY A SCHEDULE, NOT A PUSH OR CHECK-SUITE TRIGGER
 * Whatever swallowed 92786e7's `push` event runs through the same delivery
 * pipeline a `push`- or `check_suite`-triggered watcher would depend on. A
 * schedule is independent of it: cron ticks come from GitHub's scheduler, not
 * from a webhook the same outage could also drop.
 *
 * THE GUARD AGAINST RE-DISPATCHING THE SAME SHA
 * Rather than persist state anywhere, this asks `ci.yml`'s own run history: if
 * a `workflow_dispatch` run already exists for the SHA in question, another
 * dispatch is refused. That run's own check runs (or its continued absence)
 * are what the NEXT scheduled tick will see.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

// How stale a check-run-less HEAD has to be before this dispatches CI for it.
// Below this, a commit merged 90 seconds ago just hasn't had its check suite
// created yet, and dispatching would race the normal push trigger.
export const DEFAULT_MAX_AGE_MINUTES = 10;

// How often the schedule ticks (`.github/workflows/ci-run-watch.yml`), named
// here only so a comment can point at the one true number instead of a second
// copy of it.
export const SCHEDULE_MINUTES = 20;

/**
 * decideForHead({ commit, checkRuns, workflowRuns, nowMs, maxAgeMinutes })
 *   -> { action, sha, ageMinutes, reason }
 *
 * action is one of:
 *   'ok'                 at least one check run exists for this SHA. Nothing
 *                        to do; CI answered, whatever the answer was. (A red
 *                        or pending verdict is release.sh step 0b's job, not
 *                        this script's.)
 *   'too_new'            no check run yet, but the commit is younger than
 *                        maxAgeMinutes. Its check suite may simply not exist
 *                        yet; wait for the next tick.
 *   'already_dispatched' no check run yet, but a `workflow_dispatch` run for
 *                        this exact SHA is already on record. Do not fire a
 *                        second one; wait for it to report.
 *   'dispatch'           no check run, old enough, never dispatched before.
 *
 * `commit`       the response of `gh api repos/{owner}/{repo}/commits/<ref>`
 * `checkRuns`    the response of
 *                `gh api repos/{owner}/{repo}/commits/<sha>/check-runs`
 * `workflowRuns` the response of
 *                `gh api repos/{owner}/{repo}/actions/workflows/ci.yml/runs?event=workflow_dispatch`
 * `nowMs`        current time in epoch ms, injected so tests do not race the
 *                clock
 * `maxAgeMinutes` defaults to DEFAULT_MAX_AGE_MINUTES
 */
export function decideForHead({
  commit,
  checkRuns,
  workflowRuns,
  nowMs,
  maxAgeMinutes = DEFAULT_MAX_AGE_MINUTES,
}) {
  const sha = commit.sha;
  const committedAtRaw = commit.commit?.committer?.date ?? commit.commit?.author?.date;
  const committedAtMs = Date.parse(committedAtRaw);
  const ageMinutes = (nowMs - committedAtMs) / 60000;

  const totalCheckRuns = checkRuns?.total_count ?? 0;
  if (totalCheckRuns > 0) {
    return {
      action: 'ok',
      sha,
      ageMinutes,
      reason: `${totalCheckRuns} check run(s) already recorded for ${sha}.`,
    };
  }

  const runs = workflowRuns?.workflow_runs ?? [];
  const alreadyDispatched = runs.some(
    (run) => run.head_sha === sha && run.event === 'workflow_dispatch',
  );
  if (alreadyDispatched) {
    return {
      action: 'already_dispatched',
      sha,
      ageMinutes,
      reason: `A workflow_dispatch run for ${sha} is already on record; waiting for it to report rather than firing a second one.`,
    };
  }

  if (!(ageMinutes >= maxAgeMinutes)) {
    return {
      action: 'too_new',
      sha,
      ageMinutes,
      reason: `${sha} is ${ageMinutes.toFixed(1)} min old (< ${maxAgeMinutes}), no check runs yet. Its check suite may not exist yet; waiting.`,
    };
  }

  return {
    action: 'dispatch',
    sha,
    ageMinutes,
    reason: `${sha} is ${ageMinutes.toFixed(1)} min old with zero check runs and no prior dispatch on record.`,
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
  const checkRuns = ghJson([
    'api',
    `repos/${repo}/commits/${commit.sha}/check-runs?per_page=100`,
  ]);
  const workflowRuns = ghJson([
    'api',
    `repos/${repo}/actions/workflows/ci.yml/runs?event=workflow_dispatch&per_page=30`,
  ]);

  const decision = decideForHead({ commit, checkRuns, workflowRuns, nowMs: Date.now() });
  console.log(`ci-run-watch: ${decision.action}: ${decision.reason}`);

  if (decision.action === 'dispatch') {
    gh(['workflow', 'run', 'ci.yml', '--ref', 'main']);
    console.log(`ci-run-watch: dispatched ci.yml for ${decision.sha}`);
    writeSummary([
      '## CI run watch',
      '',
      `:warning: main's HEAD \`${decision.sha}\` had zero CI check runs after ` +
        `${decision.ageMinutes.toFixed(1)} minutes. Dispatched \`ci.yml --ref main\` ` +
        'to give it a verdict. See issue #838 for why this can happen (a GitHub ' +
        'outage can land a merge commit without firing the push event that starts CI).',
    ]);
  } else if (decision.action === 'already_dispatched') {
    writeSummary([
      '## CI run watch',
      '',
      `:hourglass: main's HEAD \`${decision.sha}\` still has zero CI check runs, ` +
        'but a workflow_dispatch run for it is already on record. Not dispatching again.',
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
