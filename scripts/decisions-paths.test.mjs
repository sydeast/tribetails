#!/usr/bin/env node --test
/**
 * Tests for scripts/decisions-paths.mjs (#1047). Run:
 *   node --test scripts/decisions-paths.test.mjs
 *
 * The fixture cases pin each parsing rule against a fake tree, so they do not
 * depend on what the repo holds today. The last case runs the real check on
 * the real docs/DECISIONS.md against the tracked tree: that is the one that
 * fails a PR which deletes an enforcing file without updating DECISIONS.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DECISIONS,
  ROOT,
  checkPaths,
  findProblems,
  formatProblem,
  makeKind,
  parseEnforcedIn,
} from './decisions-paths.mjs';

const SCRIPT = path.join(ROOT, 'scripts', 'decisions-paths.mjs');

/** A fake tree: the set stands in for `git ls-files`. */
const TREE = new Set(['a/one.ts', 'a/two.ts', 'b/deep/three.kt', 'docs/runbook.md']);
const kind = makeKind('/nowhere', TREE);

test('the preamble sentence about "Enforced in" is not an entry', () => {
  const { entries, problems } = parseEnforcedIn('- "Enforced in" names files, not lines. Line numbers rot.\n');
  assert.equal(entries.length, 0);
  assert.equal(problems.length, 0);
});

test('backticked, comma-separated paths are parsed and prose between them ignored', () => {
  const md = '### X-1: A ruling\n- Enforced in: `a/one.ts`, `a/two.ts` (the gate), and `b/deep/three.kt`\n';
  const { entries } = parseEnforcedIn(md);
  assert.deepEqual(entries[0].paths, ['a/one.ts', 'a/two.ts', 'b/deep/three.kt']);
  assert.deepEqual(checkPaths(entries, kind), []);
});

test('each entry is attributed to the nearest decision heading above it', () => {
  const md = [
    '### FIRST-1: One',
    '- Enforced in: `a/gone.ts`',
    '### D-2026-01-01-SECOND: Two',
    '- Ruling: "x: y"',
    '- Enforced in: `a/one.ts`, `b/missing.kt`',
  ].join('\n');
  const { problems } = findProblems(md, kind);
  assert.deepEqual(
    problems.map((p) => [p.id, p.path, p.line]),
    [
      ['FIRST-1', 'a/gone.ts', 2],
      ['D-2026-01-01-SECOND', 'b/missing.kt', 5],
    ],
  );
  assert.match(formatProblem(problems[0]), /^FIRST-1\tline 2\ta\/gone\.ts\tfile does not exist$/);
});

test('a line marked historical is skipped, a superseded one without the mark is not', () => {
  const md = [
    '### OLD-1: Old',
    '- Superseded by: NEW-1',
    '- Enforced in (historical): `a/deleted-long-ago.ts`',
    '### OLD-2: Also old',
    '- Superseded by: NEW-1',
    '- Enforced in (Historical, pre-#900): `a/also-gone.ts`',
    '### OLD-3: Superseded but still cited',
    '- Superseded by: NEW-1',
    '- Enforced in: `a/still-checked.ts`',
  ].join('\n');
  const { entries, problems } = findProblems(md, kind);
  assert.equal(entries.filter((e) => e.historical).length, 2);
  assert.deepEqual(problems.map((p) => p.id), ['OLD-3']);
});

test('a non-historical note is still checked', () => {
  const md = '### N-1: Noted\n- Enforced in (server side): `a/gone.ts`\n';
  assert.deepEqual(findProblems(md, kind).problems.map((p) => p.path), ['a/gone.ts']);
});

test('a trailing slash means a directory with at least one tracked file', () => {
  const md = '### D-1: Dirs\n- Enforced in: `b/deep/`, `b/`, `c/empty/`\n';
  const { problems } = findProblems(md, kind);
  assert.deepEqual(
    problems.map((p) => [p.path, p.reason]),
    [['c/empty/', 'directory has no tracked files']],
  );
});

test('a directory written without the slash, or a file written with one, is reported', () => {
  const md = '### D-2: Shapes\n- Enforced in: `b/deep`, `a/one.ts/`\n';
  const { problems } = findProblems(md, kind);
  assert.deepEqual(
    problems.map((p) => [p.path, p.reason]),
    [
      ['b/deep', 'is a directory; write it with a trailing slash'],
      ['a/one.ts/', 'is a file; drop the trailing slash'],
    ],
  );
});

test('a file-name prefix is not mistaken for a directory', () => {
  // `a/on` is a prefix of `a/one.ts` but not a directory holding it.
  const md = '### D-3: Prefix\n- Enforced in: `a/on/`, `a/on`\n';
  assert.equal(findProblems(md, kind).problems.length, 2);
});

test('an entry with no backticked path fails rather than passing empty', () => {
  const md = '### E-1: Empty\n- Enforced in: the invoice callables\n';
  const { problems } = findProblems(md, kind);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].id, 'E-1');
  assert.match(problems[0].reason, /no backticked path/);
});

test('an entry wrapped onto a second line is reported', () => {
  const md = '### W-1: Wrapped\n- Enforced in: `a/one.ts`,\n  `a/gone.ts`\n';
  const { problems } = findProblems(md, kind);
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /wraps onto the next line/);
});

test('absolute and parent-relative paths are refused', () => {
  const md = '### P-1: Paths\n- Enforced in: `/etc/hosts`, `a/../a/one.ts`\n';
  assert.equal(findProblems(md, kind).problems.length, 2);
});

test('the CLI names each missing path with its decision ID and exits 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decisions-paths-'));
  try {
    const good = fs.readFileSync(DECISIONS, 'utf8').split('\n').find((l) => /^- Enforced in: `/.test(l));
    const md = [
      '### CLI-OK: Real path',
      good,
      '### CLI-BROKEN: Deliberately broken',
      '- Enforced in: `mytribe/functions/src/this/does/not/exist.ts`',
    ].join('\n');
    const file = path.join(dir, 'DECISIONS.md');
    fs.writeFileSync(file, md);
    const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /CLI-BROKEN\tline 4\tmytribe\/functions\/src\/this\/does\/not\/exist\.ts\tfile does not exist/);
    assert.doesNotMatch(r.stderr, /CLI-OK/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every Enforced-in path in docs/DECISIONS.md exists in the repo', () => {
  const { entries, problems } = findProblems(fs.readFileSync(DECISIONS, 'utf8'), makeKind());
  // Guard the guard: a parser that matched nothing would pass here vacuously.
  assert.ok(entries.filter((e) => !e.historical).length > 50, `only ${entries.length} entries parsed`);
  assert.deepEqual(
    problems.map(formatProblem),
    [],
    `docs/DECISIONS.md names paths that do not exist. Update each entry, or mark ` +
      `it "- Enforced in (historical):" if the ruling no longer stands:\n` +
      problems.map((p) => `  ${formatProblem(p)}`).join('\n'),
  );
});
