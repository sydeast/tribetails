#!/usr/bin/env node --test
/**
 * Tests for scripts/ci-run-watch.mjs. Run:
 *   node --test scripts/ci-run-watch.test.mjs
 *
 * FIXTURES MODEL THE CI.YML-SCOPED QUERY, NOT `commits/{sha}/check-runs`.
 * The first version of this script read `commits/{sha}/check-runs`, which
 * counts every check run on a commit regardless of which workflow created it.
 * In production that is never zero: the watcher's own "watch" job puts a
 * check run on main's HEAD before its own script step runs (any workflow run
 * is attributed to the commit it evaluated against, schedule triggers
 * included), and main-channel.yml's push-triggered run does too. So the old
 * script always saw at least one check run and always returned 'ok', and
 * never dispatched anything. `ciRuns` here is the response of
 * `actions/workflows/ci.yml/runs?head_sha=<sha>`, scoped to ci.yml
 * specifically, so a run of any OTHER workflow for the same SHA never shows
 * up in it, however many of them exist.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_MAX_AGE_MINUTES, decideForHead } from './ci-run-watch.mjs';

const SHA = '92786e77fa8838029a0bd59dfaa05023d96cac02';
const COMMITTED_AT = '2026-09-13T08:45:51Z';
const COMMITTED_AT_MS = Date.parse(COMMITTED_AT);

function commitFixture(overrides = {}) {
  return {
    sha: SHA,
    commit: { committer: { date: COMMITTED_AT } },
    ...overrides,
  };
}

const NO_CI_RUNS = { total_count: 0, workflow_runs: [] };

test('a ci.yml run already exists for HEAD (any status): ok, nothing to do', () => {
  const ciRuns = {
    total_count: 1,
    workflow_runs: [
      { id: 34778646429, event: 'push', head_sha: SHA, status: 'completed', conclusion: 'success' },
    ],
  };

  const decision = decideForHead({
    commit: commitFixture(),
    ciRuns,
    // Same day this really happened, hours after the commit. Old enough that
    // "too new" could not explain a false pass here.
    nowMs: COMMITTED_AT_MS + 6 * 60 * 60 * 1000,
  });

  assert.equal(decision.action, 'ok');
  assert.equal(decision.sha, SHA);
});

test('no ci.yml run, and HEAD is older than the threshold: dispatch', () => {
  const decision = decideForHead({
    commit: commitFixture(),
    ciRuns: NO_CI_RUNS,
    nowMs: COMMITTED_AT_MS + (DEFAULT_MAX_AGE_MINUTES + 1) * 60 * 1000,
  });

  assert.equal(decision.action, 'dispatch');
  assert.match(decision.reason, /zero ci\.yml runs/);
});

test('no ci.yml run, but HEAD is younger than the threshold: wait, do not dispatch', () => {
  const decision = decideForHead({
    commit: commitFixture(),
    ciRuns: NO_CI_RUNS,
    nowMs: COMMITTED_AT_MS + 90 * 1000, // 1.5 minutes old
  });

  assert.equal(decision.action, 'too_new');
});

test('exactly at the threshold counts as old enough (>=, not >)', () => {
  const decision = decideForHead({
    commit: commitFixture(),
    ciRuns: NO_CI_RUNS,
    nowMs: COMMITTED_AT_MS + DEFAULT_MAX_AGE_MINUTES * 60 * 1000,
  });

  assert.equal(decision.action, 'dispatch');
});

test('a previously dispatched ci.yml run for this SHA counts as ok, so the watcher never fires twice', () => {
  const ciRuns = {
    total_count: 1,
    workflow_runs: [
      { id: 1, event: 'workflow_dispatch', head_sha: SHA, status: 'in_progress', conclusion: null },
    ],
  };

  const decision = decideForHead({
    commit: commitFixture(),
    ciRuns,
    nowMs: COMMITTED_AT_MS + (DEFAULT_MAX_AGE_MINUTES + 30) * 60 * 1000,
  });

  assert.equal(decision.action, 'ok');
});

test('a FAILED ci.yml run for this SHA still counts as ok: a red verdict is release.sh step 0b, not this script', () => {
  const ciRuns = {
    total_count: 1,
    workflow_runs: [
      { id: 2, event: 'push', head_sha: SHA, status: 'completed', conclusion: 'failure' },
    ],
  };

  const decision = decideForHead({
    commit: commitFixture(),
    ciRuns,
    nowMs: COMMITTED_AT_MS + (DEFAULT_MAX_AGE_MINUTES + 1) * 60 * 1000,
  });

  assert.equal(decision.action, 'ok');
});

test('the regression this fixes: other workflows ran for this SHA but ci.yml never did: dispatch, not ok', () => {
  // In production, by the time this runs, main-channel.yml has already run
  // for this SHA (a push touching mytribe/web/src/** matches its filter) and
  // the watcher's OWN "watch" job has already put a check run on this exact
  // commit. Neither shows up in `ciRuns`, because that query is scoped to
  // ci.yml specifically. A fix that read commits/{sha}/check-runs instead
  // would see those other runs and wrongly return 'ok' here.
  const decision = decideForHead({
    commit: commitFixture(),
    ciRuns: NO_CI_RUNS,
    nowMs: COMMITTED_AT_MS + (DEFAULT_MAX_AGE_MINUTES + 1) * 60 * 1000,
  });

  assert.equal(decision.action, 'dispatch');
});
