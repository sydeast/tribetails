/**
 * adminResolveGuard.ts
 *
 * Issue #846: the operator machine can carry a stray, root-owned
 * `$HOME/node_modules/firebase-admin` (observed: v13.8.0, dated 2026-05-06).
 * The project runs firebase-admin 14.x from `mytribe/functions/node_modules`.
 * `mytribe/scripts` has no `node_modules` of its own (see the `//paths`
 * comment in `mytribe/scripts/tsconfig.json`), so a bare `require('firebase-admin')`
 * issued from a file under `mytribe/scripts` walks UP the directory tree
 * looking for a `node_modules/firebase-admin` before it ever consults
 * `NODE_PATH`, and `$HOME` sits on that walk-up path whenever the repo is
 * checked out under the operator's home directory, which it always is here.
 * Verified empirically (see the PR description) that a real ancestor
 * `node_modules` wins over `NODE_PATH`, so `NODE_PATH=node_modules` on the
 * npm scripts does NOT protect against a stray ancestor copy.
 *
 * If a backfill script ends up with a `Timestamp`/`FieldValue` class from a
 * DIFFERENT firebase-admin copy than the one its `Firestore` client instance
 * was constructed from, the real write can be rejected or serialised wrong,
 * while a dry run (reads only) passes clean: the defect only shows up on
 * the write path, which is exactly the run an operator cannot easily retry
 * blind.
 *
 * This module never fixes the stray directory itself (the operator does
 * that by hand (needs an admin password, the directory is root-owned). It
 * only refuses to let a write-capable script proceed while the resolution
 * is unsafe, and says exactly what is wrong and how to fix it.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface FoundCopy {
  /** Absolute path to the package directory (may not be realpath'd). */
  dir: string;
  /** realpath of `dir`, used for de-duplication across search sources. */
  realDir: string;
  version: string;
  /** Where this copy was found: the require cache, an ancestor node_modules, NODE_PATH, or the expected root itself. */
  source: 'require-cache' | 'ancestor' | 'NODE_PATH' | 'expected-root';
}

export interface FsLike {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, enc: 'utf8') => string;
  realpathSync: (p: string) => string;
}

const realFs: FsLike = {
  existsSync: (p) => fs.existsSync(p),
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
  realpathSync: (p) => fs.realpathSync(p),
};

export interface AssertOptions {
  /** Directory to walk up from when enumerating ancestor node_modules. Defaults to this module's own directory. */
  fromDir?: string;
  /** The one directory a resolution is allowed to come from, e.g. mytribe/functions/node_modules. */
  expectedRoot: string;
  /** Package names to check. Defaults to ['firebase-admin']. */
  packages?: string[];
  /** NODE_PATH-style, delimiter-separated list of extra directories. Defaults to process.env.NODE_PATH. */
  nodePathEnv?: string;
  /** Keys to scan for already-loaded copies. Defaults to Object.keys(require.cache). */
  cacheKeys?: string[];
  /** Filesystem access, injectable for tests. Defaults to real fs. */
  fsImpl?: FsLike;
  /** Clock, injectable for tests (used only to format the suggested rename). */
  now?: Date;
  /** Where the success line is printed. Defaults to console.log. Pass a no-op to silence in tests. */
  log?: (message: string) => void;
}

export interface AssertReport {
  packages: Array<{ name: string; version: string; resolvedDir: string }>;
}

function ancestorNodeModulesDirs(fromDir: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(fromDir);
  for (;;) {
    dirs.push(path.join(current, 'node_modules'));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

function nodePathDirs(nodePathEnv: string | undefined): string[] {
  if (!nodePathEnv) return [];
  // Resolved against cwd, same as Node resolves NODE_PATH entries at process
  // start, so a relative NODE_PATH=node_modules (as the npm scripts set)
  // still reports an absolute, readable path in an error message.
  return nodePathEnv
    .split(path.delimiter)
    .filter((s) => s.length > 0)
    .map((s) => path.resolve(s));
}

function readVersion(fsImpl: FsLike, pkgJsonPath: string): string {
  try {
    const parsed: unknown = JSON.parse(fsImpl.readFileSync(pkgJsonPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && 'version' in parsed) {
      const v = (parsed as { version?: unknown }).version;
      if (typeof v === 'string') return v;
    }
  } catch {
    // Unreadable/unparseable package.json: report as unknown rather than throw.
  }
  return 'unknown';
}

function packageDirFor(nodeModulesDir: string, pkgName: string): string {
  // pkgName may be scoped, e.g. '@google-cloud/firestore'.
  return path.join(nodeModulesDir, ...pkgName.split('/'));
}

/** Every reachable installation of `pkgName`: ancestor walk-up, NODE_PATH, and the expected root itself. */
export function locateReachableCopies(
  pkgName: string,
  opts: { fromDir: string; expectedRoot: string; nodePathEnv?: string; fsImpl?: FsLike },
): FoundCopy[] {
  const fsImpl = opts.fsImpl ?? realFs;
  const searchDirs: Array<{ dir: string; source: FoundCopy['source'] }> = [
    ...ancestorNodeModulesDirs(opts.fromDir).map((dir) => ({ dir, source: 'ancestor' as const })),
    ...nodePathDirs(opts.nodePathEnv).map((dir) => ({ dir, source: 'NODE_PATH' as const })),
    { dir: opts.expectedRoot, source: 'expected-root' as const },
  ];

  const found: FoundCopy[] = [];
  const seenReal = new Set<string>();
  for (const { dir, source } of searchDirs) {
    const pkgDir = packageDirFor(dir, pkgName);
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    if (!fsImpl.existsSync(pkgJsonPath)) continue;
    let realDir: string;
    try {
      realDir = fsImpl.realpathSync(pkgDir);
    } catch {
      realDir = pkgDir;
    }
    if (seenReal.has(realDir)) continue;
    seenReal.add(realDir);
    found.push({ dir: pkgDir, realDir, version: readVersion(fsImpl, pkgJsonPath), source });
  }
  return found;
}

/** Nearest `node_modules/<pkgName>` directory enclosing a require.cache entry's file path, if any. */
function packageRootFromModulePath(modulePath: string, pkgName: string): string | null {
  const parts = modulePath.split(path.sep);
  const pkgParts = pkgName.split('/');
  let last: string | null = null;
  for (let i = 0; i <= parts.length - pkgParts.length; i += 1) {
    if (parts[i] !== 'node_modules') continue;
    const candidate = parts.slice(i + 1, i + 1 + pkgParts.length);
    if (candidate.join('/') === pkgParts.join('/')) {
      last = parts.slice(0, i + 1 + pkgParts.length).join(path.sep);
    }
  }
  return last;
}

/** Copies of `pkgName` that Node has ALREADY loaded in this process, per require.cache. */
export function locateLoadedCopies(
  pkgName: string,
  opts: { cacheKeys: string[]; fsImpl?: FsLike },
): FoundCopy[] {
  const fsImpl = opts.fsImpl ?? realFs;
  const found: FoundCopy[] = [];
  const seenReal = new Set<string>();
  for (const key of opts.cacheKeys) {
    const pkgDir = packageRootFromModulePath(key, pkgName);
    if (pkgDir === null) continue;
    let realDir: string;
    try {
      realDir = fsImpl.realpathSync(pkgDir);
    } catch {
      realDir = pkgDir;
    }
    if (seenReal.has(realDir)) continue;
    seenReal.add(realDir);
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    const version = fsImpl.existsSync(pkgJsonPath) ? readVersion(fsImpl, pkgJsonPath) : 'unknown';
    found.push({ dir: pkgDir, realDir, version, source: 'require-cache' });
  }
  return found;
}

function dateStamp(now: Date): string {
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}

function fixInstructions(now: Date): string {
  return [
    'Fix: remove or rename the stray copy, for example:',
    `  sudo mv ~/node_modules ~/node_modules.stray-${dateStamp(now)}`,
    'Then re-run npm ci --prefix mytribe/functions before retrying this script.',
  ].join('\n');
}

function formatCopy(c: FoundCopy): string {
  return `  - ${c.dir} (v${c.version}, via ${c.source})`;
}

/**
 * Fails loudly (throws) unless every package in `options.packages` resolves
 * to exactly one reachable, already-consistent copy, and that copy lives
 * inside `options.expectedRoot`. Call this BEFORE any Firestore read or
 * write, from the one shared module every write-capable script imports its
 * admin/Firestore/Timestamp handles from (`mytribe/scripts/lib/firebaseAdmin.ts`),
 * so a stray copy is caught at startup rather than on the write that matters.
 */
export function assertSingleFirebaseAdminResolution(options: AssertOptions): AssertReport {
  const fromDir = options.fromDir ?? __dirname;
  const expectedRoot = options.expectedRoot;
  const packages = options.packages ?? ['firebase-admin'];
  const nodePathEnv = options.nodePathEnv ?? process.env.NODE_PATH;
  const cacheKeys = options.cacheKeys ?? Object.keys(require.cache ?? {});
  const fsImpl = options.fsImpl ?? realFs;
  const now = options.now ?? new Date();
  const log = options.log ?? ((msg: string) => console.log(msg));

  let expectedRootReal: string;
  try {
    expectedRootReal = fsImpl.realpathSync(expectedRoot);
  } catch {
    expectedRootReal = path.resolve(expectedRoot);
  }

  const report: AssertReport = { packages: [] };

  for (const pkgName of packages) {
    const loaded = locateLoadedCopies(pkgName, { cacheKeys, fsImpl });
    const reachable = locateReachableCopies(pkgName, { fromDir, expectedRoot, nodePathEnv, fsImpl });

    const allByReal = new Map<string, FoundCopy>();
    for (const c of [...loaded, ...reachable]) {
      if (!allByReal.has(c.realDir)) allByReal.set(c.realDir, c);
    }
    const all = [...allByReal.values()];

    if (all.length === 0) {
      throw new Error(
        [
          `firebase-admin resolve guard: '${pkgName}' is not resolvable at all.`,
          '',
          `  expected : ${expectedRoot}`,
          '',
          'Run npm ci --prefix mytribe/functions, then retry.',
        ].join('\n'),
      );
    }

    if (all.length > 1) {
      throw new Error(
        [
          `firebase-admin resolve guard: '${pkgName}' resolves to more than one location.`,
          'That ambiguity is exactly how a backfill write ends up building a',
          'Timestamp/FieldValue from a different firebase-admin copy than the one',
          'the Firestore client uses, so the write can be rejected or serialised',
          'wrong while a dry run (reads only) still passes clean. See issue #846.',
          '',
          '  found:',
          ...all.map(formatCopy),
          `  expected only: ${expectedRoot}`,
          '',
          fixInstructions(now),
        ].join('\n'),
      );
    }

    const winner = all[0];
    const winnerIsExpected =
      winner.realDir === expectedRootReal ||
      winner.realDir.startsWith(expectedRootReal + path.sep);

    if (!winnerIsExpected) {
      throw new Error(
        [
          `firebase-admin resolve guard: '${pkgName}' resolved OUTSIDE the project.`,
          '',
          `  resolved : ${winner.dir} (v${winner.version}, via ${winner.source})`,
          `  expected : ${expectedRoot}`,
          '',
          fixInstructions(now),
        ].join('\n'),
      );
    }

    report.packages.push({ name: pkgName, version: winner.version, resolvedDir: winner.dir });
  }

  for (const p of report.packages) {
    log(`[adminResolveGuard] ${p.name}@${p.version} from ${p.resolvedDir}`);
  }

  return report;
}
