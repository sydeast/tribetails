/**
 * firebaseAdmin.ts
 *
 * THE ONLY place under mytribe/scripts that write-capable scripts should
 * import firebase-admin's app/Firestore/auth handles from. Every backfill,
 * migration, repair, and writing seed imports `initializeApp`/`getFirestore`
 * (and `Timestamp`/`FieldValue` when it builds one) from HERE instead of
 * directly from 'firebase-admin/app' / 'firebase-admin/firestore', for two
 * reasons (issue #846):
 *
 *   1. Guaranteed same-instance Timestamp/FieldValue, resolved from the
 *      right place regardless of ambient contamination. A plain
 *      `import ... from 'firebase-admin/app'` written IN THIS FILE would
 *      still be resolved from THIS FILE's own location (mytribe/scripts/lib,
 *      which has no node_modules of its own), so it is just as exposed to
 *      the ancestor walk-up described in adminResolveGuard.ts as any script
 *      that imported firebase-admin directly: on the reviewer's probe, that
 *      naive import loaded `Timestamp` from the stray
 *      `/Users/sydeast/node_modules/firebase-admin` copy BEFORE the guard
 *      ever ran, which happened to be safe only because the guard then threw
 *      on the very next call. So the runtime modules are loaded through a
 *      `require` explicitly anchored at `mytribe/functions/package.json`
 *      (via `createRequire`, below), which makes `mytribe/functions/
 *      node_modules` the FIRST node_modules directory that resolution ever
 *      considers, independent of this file's own location or of anything
 *      reachable further up the tree. `initializeApp`/`getFirestore`/
 *      `getAuth`/`getApp`/`Timestamp`/`FieldValue` are then all pulled from
 *      those two anchored requires, so a script's `Timestamp` can never be a
 *      different module instance than the one its Firestore client
 *      serialises against. (That mismatch is exactly issue #846's failure
 *      mode: it passes on a dry run because dry runs only read, and only
 *      breaks the real write.) Compile-time types still come from ordinary
 *      `import type` declarations, which are erased entirely at build time
 *      and never touch module resolution at runtime.
 *
 *   2. One place to guard. `initializeApp`, `getFirestore`, `getAuth`, and
 *      `getApp` are wrapped so the FIRST call to any one of them runs
 *      `assertSingleFirebaseAdminResolution` before doing anything else,
 *      before any Firestore or Auth read or write. Every script already
 *      gates its own `main()` behind `require.main === module` and calls
 *      these only from inside it, so routing through here needs no change
 *      to a script's own logic beyond the import line. `getAuth` is guarded
 *      too, not just `getFirestore`: seed_test_sandbox.ts creates/updates an
 *      Auth user before it ever touches Firestore, so the guard has to be
 *      reachable from that call shape as well, not only from the
 *      getFirestore one. The guard is deliberately NOT run at module load
 *      time: `mytribe/scripts/test/*.test.ts` import a script's pure
 *      functions (parseArgs, planStamp, ...) without ever calling any of
 *      these, and those unit tests must not pay for (or fail on) a
 *      resolution check they never asked for.
 *
 * The anchored `require` above only fixes what THIS module itself binds to;
 * it does not, and should not, change what `assertSingleFirebaseAdminResolution`
 * considers "reachable". A stray copy that is merely reachable (not
 * necessarily loaded) is still the hazard #846 describes, since which copy
 * wins can depend on execution context, so the guard still refuses to start
 * on a machine that carries one even though this file itself no longer ever
 * binds to it.
 *
 * See mytribe/scripts/lib/adminResolveGuard.ts for what the guard actually
 * checks and mytribe/scripts/test/adminResolveGuard.test.ts for its tests.
 */

import { createRequire } from 'module';
import * as path from 'path';
import type { App } from 'firebase-admin/app';
import type * as FirebaseAdminApp from 'firebase-admin/app';
import type { Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type * as FirebaseAdminFirestore from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';
import type * as FirebaseAdminAuth from 'firebase-admin/auth';
import { assertSingleFirebaseAdminResolution } from './adminResolveGuard';

const FUNCTIONS_DIR = path.resolve(__dirname, '..', '..', 'functions');
const EXPECTED_ROOT = path.join(FUNCTIONS_DIR, 'node_modules');

// Anchored at mytribe/functions/package.json (a real, existing file), so the
// FIRST node_modules directory this require ever considers is
// mytribe/functions/node_modules itself: there is no walk-up to shadow,
// because the anchor already sits exactly where the walk-up is supposed to
// end. This is the runtime resolution every backfill:*/seed:* npm script
// already gets from running with cwd=mytribe/functions; createRequire just
// gives this shared module that same guarantee regardless of ITS OWN
// location (mytribe/scripts/lib) or of what NODE_PATH happens to be set to.
const requireFromFunctions = createRequire(path.join(FUNCTIONS_DIR, 'package.json'));

const _app = requireFromFunctions('firebase-admin/app') as typeof FirebaseAdminApp;
const _firestore = requireFromFunctions('firebase-admin/firestore') as typeof FirebaseAdminFirestore;
const _auth = requireFromFunctions('firebase-admin/auth') as typeof FirebaseAdminAuth;

const _getApps = _app.getApps;
const _initializeApp = _app.initializeApp;
const _getApp = _app.getApp;
const _applicationDefault = _app.applicationDefault;
const _deleteApp = _app.deleteApp;

const _getFirestore = _firestore.getFirestore;
const FieldValue = _firestore.FieldValue;
const Timestamp = _firestore.Timestamp;

const _getAuth = _auth.getAuth;

let guarded = false;
function ensureGuard(): void {
  if (guarded) return;
  assertSingleFirebaseAdminResolution({ fromDir: __dirname, expectedRoot: EXPECTED_ROOT });
  guarded = true;
}

/** Guarded: runs the resolve check (once) before the real firebase-admin/app initializeApp. */
export function initializeApp(
  ...args: Parameters<typeof _initializeApp>
): ReturnType<typeof _initializeApp> {
  ensureGuard();
  return _initializeApp(...args);
}

// getFirestore is overloaded upstream (no args / app / databaseId / both);
// Parameters<typeof _getFirestore> alone would collapse to just the LAST
// overload, so the zero-arg and single-arg call shapes every script actually
// uses are declared explicitly here too.
/** Guarded: runs the resolve check (once) before the real firebase-admin/firestore getFirestore. */
export function getFirestore(): Firestore;
export function getFirestore(app: App): Firestore;
export function getFirestore(databaseId: string): Firestore;
export function getFirestore(app: App, databaseId: string): Firestore;
export function getFirestore(arg1?: App | string, arg2?: string): Firestore {
  ensureGuard();
  if (arg1 === undefined) return _getFirestore();
  if (arg2 !== undefined) return _getFirestore(arg1 as App, arg2);
  return typeof arg1 === 'string' ? _getFirestore(arg1) : _getFirestore(arg1);
}

/** Guarded: runs the resolve check (once) before the real firebase-admin/auth getAuth. seed_test_sandbox.ts writes through this before it ever calls getFirestore. */
export function getAuth(...args: Parameters<typeof _getAuth>): ReturnType<typeof _getAuth> {
  ensureGuard();
  return _getAuth(...args);
}

/** Guarded: runs the resolve check (once) before the real firebase-admin/app getApp. */
export function getApp(...args: Parameters<typeof _getApp>): ReturnType<typeof _getApp> {
  ensureGuard();
  return _getApp(...args);
}

// Read-only / no-Firestore-or-Auth-I/O helpers: passed through unguarded.
// They don't touch Firestore or Auth themselves, and gating them would make
// ordinary cleanup code (deleteApp in a test's afterAll, getApps().length
// checks) pay for a check that initializeApp/getFirestore/getAuth/getApp
// already cover.
export const getApps = _getApps;
export const applicationDefault = _applicationDefault;
export const deleteApp = _deleteApp;

// `const Timestamp = _firestore.Timestamp` only binds the VALUE (the class
// itself, for `new Timestamp(...)` / `Timestamp.now()`); scripts also use
// `Timestamp`/`FieldValue` as a TYPE in field annotations (e.g.
// `recordedAt: Timestamp`), which a plain const cannot provide. The `export
// type` lines below merge in that type meaning under the same names, exactly
// as a native `import { Timestamp } from 'firebase-admin/firestore'` would
// give for free.
export { FieldValue, Timestamp };
export type Timestamp = FirebaseAdminFirestore.Timestamp;
export type FieldValue = FirebaseAdminFirestore.FieldValue;
export type { Firestore, QueryDocumentSnapshot };
// Auth-touching emulator tests (issue #860, qaSandboxScripts.emulator.test.ts)
// need this type the same way they need getAuth() itself: through this
// shared module, never a direct `firebase-admin/auth` import, so
// emulatorTestImports.test.ts (#870) has nothing to flag.
export type { Auth };
