import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * #912: `lib/firestoreAdmin.ts` is the ONLY code that may reach for a
 * `firebase-admin` service handle.
 *
 * Nothing initializes the Admin SDK at module load. The single `initializeApp`
 * in the tree is the lazy `ensureApp()` inside `lib/firestoreAdmin.ts`, which
 * runs on the first `db()` / `auth()` / `getAdmin()` call. Every v2 function
 * deploys as its own Cloud Run service, so no sibling function warms the app in
 * that process either.
 *
 * A bare `getFirestore()` / `getAuth()` / `getMessaging()` / `getStorage()` —
 * no app argument — resolves the DEFAULT app and throws "The default Firebase
 * app does not exist" whenever it is reached before any guarded accessor on that
 * request path. `confirmSecureReset` threw on every single request that way
 * (#903). This scan fails the moment a source file imports one of those four
 * getters from `firebase-admin/*` again, so the next one cannot be introduced
 * silently and then survive until someone reads a production log.
 *
 * Comments are stripped first, so a comment naming a getter (this file's own
 * prose included) does not trip it.
 *
 * WHAT IS DELIBERATELY NOT FLAGGED. `FieldValue`, `Timestamp`, `FieldPath` and
 * the exported types (`type Firestore`, `type Transaction`, `type App`) are
 * plain values and types that touch no app, so importing them from
 * `firebase-admin/firestore` stays fine and the detector tests below pin that.
 * So does the root `firebase-admin` namespace (`admin.firestore()`), which is
 * how `auntieos-admin/web/functions` works and which resolves against the app
 * that tree's `index.js` initializes itself.
 *
 * WHY A SCAN AND NOT AN ESLINT RULE. Same reason as the #910 reader guard in
 * `clientIpReaders.test.ts`: the two function trees carry two ESLint configs
 * (`mytribe/functions` is TypeScript, `auntieos-admin/web/functions` is plain
 * CommonJS with no lint script at all), so a `no-restricted-imports` rule would
 * have to be registered twice and would still miss the `require()` spelling.
 * One vitest file scans both trees, runs in the suite CI already gates on, and
 * names the offending file, the specifier and the getter.
 */
const REPO = resolve(__dirname, '../../..');

/**
 * Every deployed functions tree.
 *
 * `auntieos-admin/web/functions` has no guarded accessor of its own: its
 * `index.js` calls `admin.initializeApp()` directly. That call is NOT a licence
 * for a modular getter there, because `index.js` `require`s its siblings
 * (`./generate`, `./rateLimit`, ...) on the lines ABOVE it — so a module-scope
 * `getFirestore()` in any of them would run before the app exists, exactly like
 * the mytribe case. It holds zero modular imports today; the root-holds-source
 * and MUST_SCAN checks below are what keep scanning it from being a no-op.
 *
 * `auntieos-admin/twilio-service/functions` is Twilio-hosted, not Firebase, and
 * loads no firebase-admin at all.
 */
const ROOTS = ['mytribe/functions/src', 'auntieos-admin/web/functions'];

/**
 * Not our source: vendored code and the test scaffolds that mock these modules
 * on purpose.
 *
 * NOT `lib` or `dist`. `mytribe/functions/lib` is the build output, but it sits
 * beside `src` rather than inside it, so skipping the name would only ever hide
 * `src/lib` — which is where the one allowed file lives and where a second copy
 * of it would appear.
 */
const SKIP_DIRS = new Set(['node_modules', 'test', 'tests', '__tests__']);

/** Proof the walk reaches nested directories in both trees, `src/lib` included. */
const MUST_SCAN = [
  'mytribe/functions/src/lib/firestoreAdmin.ts',
  'mytribe/functions/src/membership/acceptInvite.ts',
  'auntieos-admin/web/functions/generate.js',
];

const ACCESSORS = ['getFirestore', 'getAuth', 'getMessaging', 'getStorage'];

/** The one file allowed to reach for a service handle, with the reason. */
const ALLOWED = new Map<string, string>([
  [
    'mytribe/functions/src/lib/firestoreAdmin.ts',
    'home of ensureApp(); every getter here is called WITH the app it just initialized',
  ],
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...sourceFiles(full));
    } else if (/\.(ts|js|mjs|cjs)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/** Drops block and line comments, keeping `://` inside URLs. */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/**
 * The binding clause of an `import ... from 'firebase-admin/x'`. The clause is
 * bounded by `[^;'"]` so it can span newlines (multi-line brace lists are the
 * normal spelling) without ever running back through an earlier statement's
 * specifier or terminator and dragging an unrelated name in with it.
 */
const IMPORT_RE = /import\s+([^;'"]*?)\s*from\s*['"]firebase-admin\/([^'"]+)['"]/g;
/** The same, for `const { getAuth } = require('firebase-admin/auth')`. */
const REQUIRE_RE = /(?:const|let|var)\s+([^;'"=]*?)\s*=\s*require\(\s*['"]firebase-admin\/([^'"]+)['"]\s*\)/g;
/** And for the one-liner `require('firebase-admin/auth').getAuth()`. */
const INLINE_REQUIRE_RE = /require\(\s*['"]firebase-admin\/([^'"]+)['"]\s*\)\s*\.\s*(\w+)/g;

/**
 * Every banned getter a file pulls in, as `specifier: getter`.
 *
 * A namespace import of a SUBPATH (`import * as x from 'firebase-admin/auth'`)
 * is reported too: the only thing that module exports worth namespacing is its
 * getter, and the name it is called through is invisible to a text scan.
 */
export function accessorsIn(text: string): string[] {
  const code = stripComments(text);
  const found = new Set<string>();
  for (const [, clauseRaw, spec] of code.matchAll(IMPORT_RE)) {
    const clause = clauseRaw.trim();
    if (/^type\b/.test(clause)) continue; // `import type { ... }` binds no value
    if (/^\*\s+as\b/.test(clause)) {
      found.add(`firebase-admin/${spec}: * as (namespace import)`);
      continue;
    }
    for (const name of ACCESSORS) {
      if (new RegExp(`(^|[^\\w$])${name}\\b`).test(clause)) found.add(`firebase-admin/${spec}: ${name}`);
    }
  }
  for (const [, clause, spec] of code.matchAll(REQUIRE_RE)) {
    for (const name of ACCESSORS) {
      if (new RegExp(`(^|[^\\w$])${name}\\b`).test(clause)) found.add(`firebase-admin/${spec}: ${name}`);
    }
  }
  for (const [, spec, name] of code.matchAll(INLINE_REQUIRE_RE)) {
    if (ACCESSORS.includes(name)) found.add(`firebase-admin/${spec}: ${name}`);
  }
  return [...found].sort();
}

describe('#912 only lib/firestoreAdmin.ts reaches for a firebase-admin service handle', () => {
  it('the patterns catch every spelling they are for, and ignore comments', () => {
    expect(accessorsIn("import { getAuth } from 'firebase-admin/auth';")).toEqual([
      'firebase-admin/auth: getAuth',
    ]);
    expect(accessorsIn("import {\n  getFirestore,\n  FieldValue,\n} from 'firebase-admin/firestore';")).toEqual([
      'firebase-admin/firestore: getFirestore',
    ]);
    expect(accessorsIn("import { getMessaging } from 'firebase-admin/messaging';")).toEqual([
      'firebase-admin/messaging: getMessaging',
    ]);
    expect(accessorsIn("import { getStorage } from 'firebase-admin/storage';")).toEqual([
      'firebase-admin/storage: getStorage',
    ]);
    expect(accessorsIn("const { getAuth } = require('firebase-admin/auth');")).toEqual([
      'firebase-admin/auth: getAuth',
    ]);
    expect(accessorsIn("const auth = require('firebase-admin/auth').getAuth();")).toEqual([
      'firebase-admin/auth: getAuth',
    ]);
    expect(accessorsIn("import * as adminAuth from 'firebase-admin/auth';")).toEqual([
      'firebase-admin/auth: * as (namespace import)',
    ]);
    // A preceding import of a same-named symbol from somewhere else must not be
    // dragged into the firebase-admin clause by a greedy match.
    expect(
      accessorsIn("import { getAuth } from './lib/firestoreAdmin';\nimport { FieldValue } from 'firebase-admin/firestore';"),
    ).toEqual([]);
    // Values and types that need no app.
    expect(accessorsIn("import { FieldValue, Timestamp } from 'firebase-admin/firestore';")).toEqual([]);
    expect(accessorsIn("import type { Transaction } from 'firebase-admin/firestore';")).toEqual([]);
    expect(accessorsIn("import { initializeApp, getApps, type App } from 'firebase-admin/app';")).toEqual([]);
    // The root namespace resolves against whatever app the tree initialized.
    expect(accessorsIn("const admin = require('firebase-admin');\nadmin.firestore();")).toEqual([]);
    // Comments, including this guard's own prose.
    expect(accessorsIn("// never import { getAuth } from 'firebase-admin/auth'\nconst a = 1;")).toEqual([]);
    expect(accessorsIn("/** not `import { getStorage } from 'firebase-admin/storage'` */\nconst a = 1;")).toEqual([]);
    // Our own accessors keep their names.
    expect(accessorsIn("import { db, getAdmin } from '../lib/firestoreAdmin';")).toEqual([]);
  });

  it('every root exists and holds source, so the scan cannot pass on an empty tree', () => {
    for (const root of ROOTS) {
      expect(sourceFiles(resolve(REPO, root)).length, `${root} holds source files`).toBeGreaterThan(0);
    }
  });

  it('the walk reaches nested directories, so a skip-list edit cannot quietly shrink it', () => {
    const scanned = new Set(
      ROOTS.flatMap((root) => sourceFiles(resolve(REPO, root))).map((f) =>
        relative(REPO, f).split('\\').join('/'),
      ),
    );
    for (const rel of MUST_SCAN) expect(scanned, `${rel} is scanned`).toContain(rel);
  });

  it('the allowed file really imports all four getters, so the patterns are not dead', () => {
    const text = readFileSync(resolve(REPO, 'mytribe/functions/src/lib/firestoreAdmin.ts'), 'utf8');
    expect(accessorsIn(text)).toEqual([
      'firebase-admin/auth: getAuth',
      'firebase-admin/firestore: getFirestore',
      'firebase-admin/messaging: getMessaging',
      'firebase-admin/storage: getStorage',
    ]);
  });

  it('every allowed file is still there, so a stale entry cannot hide a new importer', () => {
    for (const rel of ALLOWED.keys()) {
      expect(() => statSync(resolve(REPO, rel)), `${rel} still exists`).not.toThrow();
    }
  });

  it('no other source file imports getFirestore, getAuth, getMessaging or getStorage from firebase-admin', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const root of ROOTS) {
      for (const file of sourceFiles(resolve(REPO, root))) {
        scanned += 1;
        const rel = relative(REPO, file).split('\\').join('/');
        if (ALLOWED.has(rel)) continue;
        const found = accessorsIn(readFileSync(file, 'utf8'));
        if (found.length > 0) offenders.push(`${rel}: ${found.join(', ')}`);
      }
    }
    expect(scanned, 'the scan found source files').toBeGreaterThan(100);
    expect(offenders, 'use db() / getAdmin() from lib/firestoreAdmin.ts').toEqual([]);
  });
});
