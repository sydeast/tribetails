#!/usr/bin/env node
/**
 * Checks that every "- Enforced in:" path in docs/DECISIONS.md exists (#1047).
 * Run:
 *   node scripts/decisions-paths.mjs [path/to/DECISIONS.md]
 *
 * WHY THIS EXISTS
 * DECISIONS.md names the files that enforce each ruling. Nothing checked
 * those names, so a deletion left them stale: #986 deleted two App Check
 * files that the O-3 and OWNER-1 entries still named until #1044 and #1046
 * fixed them by hand. This script fails on that, and CI runs it on any change
 * under docs/ and on any change that deletes or renames a file.
 *
 * THE RULES
 * - An entry is a line matching `- Enforced in:` or `- Enforced in (<note>):`.
 *   The preamble sentence `"Enforced in" names files` is not an entry.
 * - A note containing "historical" (any case) skips the whole line: those
 *   entries record files that enforced a ruling that no longer stands.
 *   A superseded entry WITHOUT that note is still checked.
 * - Paths are the backticked spans on the line, relative to the repo root.
 *   Commas and any prose between them are ignored. A line with no backticked
 *   span is a failure, not a skip.
 * - A path ending in `/` is a directory: at least one tracked file must sit
 *   under it. Any other path must be a tracked file. A path without the
 *   slash that turns out to be a directory is reported, because the doc's own
 *   rule is that "Enforced in" names files.
 * - One line per entry. A line right after an entry that starts with a
 *   backtick is a wrapped continuation, which would drop paths silently, so
 *   it is reported.
 * - The decision ID is the nearest `### <ID>: <title>` heading above.
 *
 * "Tracked" means `git ls-files`, so an untracked local file cannot hide a
 * missing one. In CI the checkout holds only tracked files, so git and the
 * filesystem agree there. When git is unavailable, the filesystem is used.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DECISIONS = path.join(ROOT, 'docs', 'DECISIONS.md');

const ENTRY = /^\s*-\s*Enforced in(?:\s*\(([^)]*)\))?:\s*(.*)$/;
const HEADING = /^###\s+([^:]+?)\s*:/;

/**
 * Parse every Enforced-in entry. Returns entries (with the paths to check)
 * and problems that are about the markdown itself, not the tree.
 */
export function parseEnforcedIn(markdown) {
  const lines = markdown.split(/\r?\n/);
  const entries = [];
  const problems = [];
  let id = '(no decision heading)';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = HEADING.exec(line);
    if (heading) {
      id = heading[1];
      continue;
    }
    const m = ENTRY.exec(line);
    if (!m) continue;
    const note = m[1] ?? '';
    const lineNo = i + 1;
    if (/historical/i.test(note)) {
      entries.push({ id, line: lineNo, historical: true, paths: [] });
      continue;
    }
    const paths = [...m[2].matchAll(/`([^`]+)`/g)].map((s) => s[1].trim());
    if (paths.length === 0) {
      problems.push({ id, line: lineNo, path: '', reason: 'Enforced in line names no backticked path' });
    }
    const next = lines[i + 1];
    if (next !== undefined && /^\s*`/.test(next)) {
      problems.push({
        id,
        line: lineNo + 1,
        path: '',
        reason: 'Enforced in entry wraps onto the next line; keep it on one line',
      });
    }
    entries.push({ id, line: lineNo, historical: false, paths });
  }
  return { entries, problems };
}

/** Tracked files under root, or null when git cannot answer. */
export function trackedFiles(root = ROOT) {
  const r = spawnSync('git', ['-C', root, 'ls-files', '-z', '--full-name'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  return new Set(r.stdout.split('\0').filter(Boolean));
}

/**
 * Build the existence test: kind(p) returns 'file', 'dir' or null.
 * With a tracked-file set it answers from git; without one, from disk.
 */
export function makeKind(root = ROOT, tracked = trackedFiles(root)) {
  if (tracked) {
    return (p) => {
      const clean = p.replace(/\/+$/, '');
      if (tracked.has(clean)) return 'file';
      const prefix = `${clean}/`;
      for (const f of tracked) if (f.startsWith(prefix)) return 'dir';
      return null;
    };
  }
  return (p) => {
    try {
      const st = fs.statSync(path.join(root, p));
      return st.isDirectory() ? 'dir' : 'file';
    } catch {
      return null;
    }
  };
}

/** Check each entry's paths. Returns a list of problems. */
export function checkPaths(entries, kind) {
  const problems = [];
  for (const e of entries) {
    if (e.historical) continue;
    for (const p of e.paths) {
      const report = (reason) => problems.push({ id: e.id, line: e.line, path: p, reason });
      if (p.startsWith('/') || p.split('/').includes('..')) {
        report('path must be relative to the repo root');
        continue;
      }
      const wantsDir = p.endsWith('/');
      const found = kind(p);
      if (found === null) report(wantsDir ? 'directory has no tracked files' : 'file does not exist');
      else if (!wantsDir && found === 'dir') report('is a directory; write it with a trailing slash');
      else if (wantsDir && found === 'file') report('is a file; drop the trailing slash');
    }
  }
  return problems;
}

/** Parse and check a DECISIONS.md body. */
export function findProblems(markdown, kind) {
  const { entries, problems } = parseEnforcedIn(markdown);
  return { entries, problems: [...problems, ...checkPaths(entries, kind)] };
}

export function formatProblem(p) {
  return `${p.id}\tline ${p.line}\t${p.path || '-'}\t${p.reason}`;
}

// Same guard as ci-run-watch.mjs: compare real paths, because the scratchpad
// and /tmp resolve through a symlink on macOS.
const invokedAs = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invokedAs === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const file = process.argv[2] ? path.resolve(process.argv[2]) : DECISIONS;
  const { entries, problems } = findProblems(fs.readFileSync(file, 'utf8'), makeKind());
  const checked = entries.filter((e) => !e.historical);
  const pathCount = checked.reduce((n, e) => n + e.paths.length, 0);
  if (problems.length > 0) {
    console.error(`${path.relative(ROOT, file)}: ${problems.length} stale Enforced-in path(s):`);
    for (const p of problems) console.error(`  ${formatProblem(p)}`);
    process.exit(1);
  }
  console.log(
    `${path.relative(ROOT, file)}: ${pathCount} paths in ${checked.length} entries exist ` +
      `(${entries.length - checked.length} historical skipped).`,
  );
}
