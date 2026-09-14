import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  assertSingleFirebaseAdminResolution,
  locateReachableCopies,
  locateLoadedCopies,
  type FsLike,
} from '../lib/adminResolveGuard';

/**
 * These tests never touch the real filesystem's $HOME or the real
 * node_modules trees — see the memory rule "do NOT create or touch
 * $HOME/node_modules" in the issue. Two independent techniques are used:
 *
 *   - A fully in-memory fake `fs` (FsLike) plus a fake require.cache key
 *     list, injected straight into the guard. Fast, and exercises the exact
 *     pass/fail branches.
 *   - A real temporary directory tree (fixtures below) exercised through the
 *     REAL fs, to prove the ancestor-walk + NODE_PATH enumeration logic
 *     works against an actual filesystem, not just against a mock that
 *     happens to agree with the implementation's assumptions.
 */

function fakeFs(files: Record<string, string>): FsLike {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      }
      return files[p];
    },
    // No symlinks in the fake world: realpath is identity.
    realpathSync: (p) => p,
  };
}

function pkgJson(dir: string, version: string): Record<string, string> {
  return { [path.join(dir, 'package.json')]: JSON.stringify({ name: 'firebase-admin', version }) };
}

describe('assertSingleFirebaseAdminResolution (dependency-injected)', () => {
  const EXPECTED_ROOT = '/repo/mytribe/functions/node_modules';
  const CORRECT_DIR = path.join(EXPECTED_ROOT, 'firebase-admin');
  const STRAY_DIR = '/home/operator/node_modules/firebase-admin';

  it('passes when the only reachable copy is inside the expected root', () => {
    const files = pkgJson(CORRECT_DIR, '14.3.0');
    const logs: string[] = [];
    const report = assertSingleFirebaseAdminResolution({
      fromDir: '/repo/mytribe/scripts/lib',
      expectedRoot: EXPECTED_ROOT,
      cacheKeys: [path.join(CORRECT_DIR, 'lib', 'index.js')],
      fsImpl: fakeFs(files),
      log: (m) => logs.push(m),
    });
    expect(report.packages).toEqual([
      { name: 'firebase-admin', version: '14.3.0', resolvedDir: CORRECT_DIR },
    ]);
    expect(logs[0]).toContain('firebase-admin@14.3.0');
    expect(logs[0]).toContain(CORRECT_DIR);
  });

  it('passes when the correct copy is only reachable (not yet loaded) and nothing else is reachable', () => {
    const files = pkgJson(CORRECT_DIR, '14.3.0');
    const report = assertSingleFirebaseAdminResolution({
      fromDir: '/repo/mytribe/scripts/lib',
      expectedRoot: EXPECTED_ROOT,
      cacheKeys: [], // nothing loaded yet
      fsImpl: fakeFs(files),
      log: () => {},
    });
    expect(report.packages[0].resolvedDir).toBe(CORRECT_DIR);
  });

  it('fails, naming both paths and the fix, when resolution points outside the project', () => {
    const files = pkgJson(STRAY_DIR, '13.8.0');
    let thrown: Error | null = null;
    try {
      assertSingleFirebaseAdminResolution({
        fromDir: '/repo/mytribe/scripts/lib',
        expectedRoot: EXPECTED_ROOT,
        cacheKeys: [path.join(STRAY_DIR, 'lib', 'index.js')],
        fsImpl: fakeFs(files),
        now: new Date('2026-09-14T00:00:00Z'),
        log: () => {},
      });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    const msg = thrown!.message;
    expect(msg).toContain(STRAY_DIR);
    expect(msg).toContain(EXPECTED_ROOT);
    expect(msg).toContain('sudo mv ~/node_modules ~/node_modules.stray-20260914');
    expect(msg).toContain('npm ci --prefix mytribe/functions');
    expect(msg).not.toContain('!');
  });

  it('fails, listing both copies, when two versions are reachable', () => {
    const files = {
      ...pkgJson(CORRECT_DIR, '14.3.0'),
      ...pkgJson(STRAY_DIR, '13.8.0'),
    };
    let thrown: Error | null = null;
    try {
      assertSingleFirebaseAdminResolution({
        fromDir: '/repo/mytribe/scripts/lib',
        expectedRoot: EXPECTED_ROOT,
        // Simulate: the stray is what actually got loaded (ancestor walk-up
        // won in the real process), the correct one is merely reachable.
        cacheKeys: [path.join(STRAY_DIR, 'lib', 'index.js')],
        nodePathEnv: EXPECTED_ROOT,
        fsImpl: fakeFs(files),
        now: new Date('2026-09-14T00:00:00Z'),
        log: () => {},
      });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    const msg = thrown!.message;
    expect(msg).toContain(STRAY_DIR);
    expect(msg).toContain('v13.8.0');
    expect(msg).toContain(CORRECT_DIR);
    expect(msg).toContain('v14.3.0');
    expect(msg).toContain('sudo mv ~/node_modules ~/node_modules.stray-20260914');
    expect(msg).not.toContain('!');
  });

  it('fails when two copies are loaded (require-cache disagrees with itself)', () => {
    const files = {
      ...pkgJson(CORRECT_DIR, '14.3.0'),
      ...pkgJson(STRAY_DIR, '13.8.0'),
    };
    expect(() =>
      assertSingleFirebaseAdminResolution({
        fromDir: '/repo/mytribe/scripts/lib',
        expectedRoot: EXPECTED_ROOT,
        cacheKeys: [
          path.join(CORRECT_DIR, 'lib', 'index.js'),
          path.join(STRAY_DIR, 'lib', 'firestore', 'index.js'),
        ],
        fsImpl: fakeFs(files),
        log: () => {},
      }),
    ).toThrow(/more than one location/);
  });

  it('fails with a distinct message when the package is not resolvable at all', () => {
    expect(() =>
      assertSingleFirebaseAdminResolution({
        fromDir: '/repo/mytribe/scripts/lib',
        expectedRoot: EXPECTED_ROOT,
        cacheKeys: [],
        fsImpl: fakeFs({}),
        log: () => {},
      }),
    ).toThrow(/not resolvable at all/);
  });

  it('checks every package passed in, not just the first', () => {
    const files = {
      ...pkgJson(path.join(EXPECTED_ROOT, 'firebase-admin'), '14.3.0'),
      [path.join(EXPECTED_ROOT, '@google-cloud', 'firestore', 'package.json')]: JSON.stringify({
        name: '@google-cloud/firestore',
        version: '8.0.0',
      }),
      [path.join('/home/operator/node_modules', '@google-cloud', 'firestore', 'package.json')]:
        JSON.stringify({ name: '@google-cloud/firestore', version: '7.0.0' }),
    };
    expect(() =>
      assertSingleFirebaseAdminResolution({
        fromDir: '/repo/mytribe/scripts/lib',
        expectedRoot: EXPECTED_ROOT,
        packages: ['firebase-admin', '@google-cloud/firestore'],
        cacheKeys: [],
        nodePathEnv: '/home/operator/node_modules',
        fsImpl: fakeFs(files),
        log: () => {},
      }),
    ).toThrow(/@google-cloud\/firestore.*more than one location/s);
  });
});

describe('locateLoadedCopies / locateReachableCopies (unit)', () => {
  it('locateLoadedCopies finds the nearest node_modules/<pkg> segment for a scoped package', () => {
    const files = {
      [path.join('/a/node_modules/@google-cloud/firestore', 'package.json')]: JSON.stringify({
        version: '8.0.0',
      }),
    };
    const copies = locateLoadedCopies('@google-cloud/firestore', {
      cacheKeys: ['/a/node_modules/@google-cloud/firestore/build/src/index.js'],
      fsImpl: fakeFs(files),
    });
    expect(copies).toEqual([
      {
        dir: path.join('/a/node_modules/@google-cloud/firestore'),
        realDir: path.join('/a/node_modules/@google-cloud/firestore'),
        version: '8.0.0',
        source: 'require-cache',
      },
    ]);
  });

  it('locateReachableCopies always includes the expected root as a candidate even with no ancestor/NODE_PATH hits', () => {
    const files = pkgJson('/only/here/node_modules/firebase-admin', '14.3.0');
    const copies = locateReachableCopies('firebase-admin', {
      fromDir: '/somewhere/else/entirely',
      expectedRoot: '/only/here/node_modules',
      fsImpl: fakeFs(files),
    });
    expect(copies).toHaveLength(1);
    expect(copies[0].source).toBe('expected-root');
  });
});

describe('assertSingleFirebaseAdminResolution (real temp-directory fixture)', () => {
  // Real fs, real directories, all under a fresh mkdtemp — never $HOME.
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function makeFixturePackage(nodeModulesDir: string, pkgName: string, version: string): void {
    const dir = path.join(nodeModulesDir, ...pkgName.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkgName, version }));
  }

  it('passes when the real ancestor walk-up only reaches the expected root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-guard-ok-'));
    tmpDirs.push(root);
    // repo/mytribe/functions/node_modules/firebase-admin  (the only copy)
    // repo/mytribe/scripts/lib                              (fromDir, no node_modules of its own)
    const functionsNodeModules = path.join(root, 'repo', 'mytribe', 'functions', 'node_modules');
    const scriptsLib = path.join(root, 'repo', 'mytribe', 'scripts', 'lib');
    fs.mkdirSync(scriptsLib, { recursive: true });
    makeFixturePackage(functionsNodeModules, 'firebase-admin', '14.3.0');

    const report = assertSingleFirebaseAdminResolution({
      fromDir: scriptsLib,
      expectedRoot: functionsNodeModules,
      cacheKeys: [],
      nodePathEnv: functionsNodeModules,
      log: () => {},
    });
    expect(report.packages[0]).toEqual({
      name: 'firebase-admin',
      version: '14.3.0',
      resolvedDir: path.join(functionsNodeModules, 'firebase-admin'),
    });
  });

  it('fails when a real ancestor node_modules shadows the expected root (the actual #846 shape)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-guard-stray-'));
    tmpDirs.push(root);
    // "home" is a real ANCESTOR of the repo path here, exactly like the
    // operator's actual $HOME is an ancestor of the checkout — this is what
    // makes ancestor walk-up beat NODE_PATH in the real bug.
    const home = root;
    const repo = path.join(home, 'repo');
    const functionsNodeModules = path.join(repo, 'mytribe', 'functions', 'node_modules');
    const scriptsLib = path.join(repo, 'mytribe', 'scripts', 'lib');
    const strayNodeModules = path.join(home, 'node_modules');
    fs.mkdirSync(scriptsLib, { recursive: true });
    makeFixturePackage(functionsNodeModules, 'firebase-admin', '14.3.0');
    makeFixturePackage(strayNodeModules, 'firebase-admin', '13.8.0');

    expect(() =>
      assertSingleFirebaseAdminResolution({
        fromDir: scriptsLib,
        expectedRoot: functionsNodeModules,
        cacheKeys: [],
        nodePathEnv: functionsNodeModules,
        log: () => {},
      }),
    ).toThrow(/more than one location/);
  });
});
