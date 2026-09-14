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
 *   1. Guaranteed same-instance Timestamp/FieldValue. Both are imported once,
 *      in this one file, from the same resolution of 'firebase-admin/firestore'
 *      that `getFirestore` itself comes from — so a script's `Timestamp` can
 *      never be a different module instance than the one its Firestore client
 *      serialises against. (That mismatch is exactly issue #846's failure
 *      mode: it passes on a dry run because dry runs only read, and only
 *      breaks the real write.)
 *
 *   2. One place to guard. `initializeApp` and `getFirestore` are wrapped so
 *      the FIRST call to either one runs `assertSingleFirebaseAdminResolution`
 *      before doing anything else — before any Firestore read or write. Every
 *      script already gates its own `main()` behind
 *      `require.main === module` and calls `initializeApp`/`getFirestore`
 *      only from inside it, so routing through here needs no change to a
 *      script's own logic beyond the import line. The guard is deliberately
 *      NOT run at module load time: `mytribe/scripts/test/*.test.ts` import a
 *      script's pure functions (parseArgs, planStamp, ...) without ever
 *      calling initializeApp/getFirestore, and those unit tests must not pay
 *      for (or fail on) a resolution check they never asked for.
 *
 * See mytribe/scripts/lib/adminResolveGuard.ts for what the guard actually
 * checks and mytribe/scripts/test/adminResolveGuard.test.ts for its tests.
 */

import {
  getApps as _getApps,
  initializeApp as _initializeApp,
  getApp as _getApp,
  applicationDefault as _applicationDefault,
  deleteApp as _deleteApp,
  type App,
} from 'firebase-admin/app';
import {
  getFirestore as _getFirestore,
  FieldValue,
  Timestamp,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { getAuth as _getAuth } from 'firebase-admin/auth';
import * as path from 'path';
import { assertSingleFirebaseAdminResolution } from './adminResolveGuard';

const EXPECTED_ROOT = path.resolve(__dirname, '..', '..', 'functions', 'node_modules');

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

// Read-only / no-Firestore-I/O helpers: passed through unguarded. They don't
// touch Firestore themselves, and gating them would make ordinary cleanup
// code (deleteApp in a test's afterAll, getApps().length checks) pay for a
// check that initializeApp/getFirestore already cover.
export const getApps = _getApps;
export const getApp = _getApp;
export const applicationDefault = _applicationDefault;
export const deleteApp = _deleteApp;
export const getAuth = _getAuth;

export { FieldValue, Timestamp };
export type { Firestore, QueryDocumentSnapshot };
