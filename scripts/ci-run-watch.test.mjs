#!/usr/bin/env node --test
/**
 * Tests for scripts/ci-run-watch.mjs. Run:
 *   node --test scripts/ci-run-watch.test.mjs
 *
 * `decideForHead` takes exactly the JSON shapes `gh api` hands back (a commit,
 * a check-runs page, a workflow-runs page) and a fake `nowMs`, so every branch
 * is reachable with no network and no clock race. The fixtures below are
 * trimmed to the fields the function reads, not full API responses, the same
 * way client-secrets.test.mjs's fake fetcher only ever holds what the
 * resolver asks for.
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

const NO_RUNS = { total_count: 0, check_runs: [] };
const NO_DISPATCHES = { total_count: 0, workflow_runs: [] };

test('a check run already exists for HEAD: ok, nothing to do', () => {
  const checkRuns = {
    total_count: 14,
    check_runs: [{ name: 'Portal shared (jvm + android unit + js)', status: 'completed', conclusion: 'success' }],
  };

  const decision = decideForHead({
    commit: commitFixture(),
    checkRuns,
    workflowRuns: NO_DISPATCHES,
    // Same day this really happened, hours after the commit. Old enough that
    // "too new" could not explain a false pass here.
    nowMs: COMMITTED_AT_MS + 6 * 60 * 60 * 1000,
  });

  assert.equal(decision.action, 'ok');
  assert.equal(decision.sha, SHA);
});

test('no check runs, and HEAD is older than the threshold: dispatch', () => {
  const decision = decideForHead({
    commit: commitFixture(),
    checkRuns: NO_RUNS,
    workflowRuns: NO_DISPATCHES,
    nowMs: COMMITTED_AT_MS + (DEFAULT_MAX_AGE_MINUTES + 1) * 60 * 1000,
  });

  assert.equal(decision.action, 'dispatch');
  assert.equal(decision.sha, SHA);
  assert.match(decision.reason, /zero check runs/);
});

test('no check runs, but HEAD is younger than the threshold: wait, do not dispatch', () => {
  const decision = decideForHead({
    commit: commitFixture(),
    checkRuns: NO_RUNS,
    workflowRuns: NO_DISPATCHES,
    nowMs: COMMITTED_AT_MS + 90 * 1000, // 1.5 minutes old
  });

  assert.equal(decision.action, 'too_new');
});

test('exactly at the threshold counts as old enough (>=, not >)', () => {
  const decision = decideForHead({
    commit: commitFixture(),
    checkRuns: NO_RUNS,
    workflowRuns: NO_DISPATCHES,
    nowMs: COMMITTED_AT_MS + DEFAULT_MAX_AGE_MINUTES * 60 * 1000,
  });

  assert.equal(decision.action, 'dispatch');
});

test('no check runs, old enough, but a workflow_dispatch run for this SHA already exists: do not dispatch again', () => {
  const workflowRuns = {
    total_count: 1,
    workflow_runs: [
      {
        id: 34778646429,
        event: 'workflow_dispatch',
        head_sha: SHA,
        status: 'in_progress',
      },
    ],
  };

  const decision = decideForHead({
    commit: commitFixture(),
    checkRuns: NO_RUNS,
    workflowRuns,
    nowMs: COMMITTED_AT_MS + (DEFAULT_MAX_AGE_MINUTES + 30) * 60 * 1000,
  });

  assert.equal(decision.action, 'already_dispatched');
});

test('a workflow_dispatch run exists but for a DIFFERENT SHA: does not count as this one already being handled', () => {
  const workflowRuns = {
    total_count: 1,
    workflow_runs: [
      { id: 1, event: 'workflow_dispatch', head_sha: 'deadbeef', status: 'completed' },
    ],
  };

  const decision = decideForHead({
    commit: commitFixture(),
    checkRuns: NO_RUNS,
    workflowRuns,
    nowMs: COMMITTED_AT_MS + (DEFAULT_MAX_AGE_MINUTES + 1) * 60 * 1000,
  });

  assert.equal(decision.action, 'dispatch');
});

test('a PUSH-triggered run for this SHA does not count as "already dispatched" (that is the trigger that failed to fire)', () => {
  const workflowRuns = {
    total_count: 1,
    workflow_runs: [{ id: 1, event: 'push', head_sha: SHA, status: 'completed' }],
  };

  const decision = decideForHead({
    commit: commitFixture(),
    checkRuns: NO_RUNS,
    workflowRuns,
    nowMs: COMMITTED_AT_MS + (DEFAULT_MAX_AGE_MINUTES + 1) * 60 * 1000,
  });

  // If a push run genuinely completed for this SHA, its check runs would have
  // shown up in `checkRuns` already (NO_RUNS would be a lie). This case is
  // here to pin the field this reads (`event`), not to claim it is reachable.
  assert.equal(decision.action, 'dispatch');
});
