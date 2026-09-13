import { doc } from 'firebase/firestore';
import { setDoc } from '../lib/firestoreWrite';
import { auth, db } from '../lib/firebase';
import {
  COVERAGE_PACKAGE_COLLECTION,
  COVERAGE_PACKAGE_DOC_ID,
  type CoveragePackageConfig,
} from './coveragePackage';

/**
 * Write side of the Coverage Package Builder config, paired with
 * `getCoveragePackageConfig` in `./coveragePackage.ts`. Mirrors
 * `saveBusinessSettings`: a direct client SDK `setDoc`, gated by
 * `firestore.rules` (`coverage_package_config` → `allow write: if isAuntie()`),
 * with an `updatedAt`/`updatedBy` stamp from the signed-in operator.
 *
 * Only the visit menu (`durations`) is persisted. Coverage rules are per-client
 * and live with the in-progress quote, never in this global doc. `merge: true`
 * leaves any legacy `rules` field on an old doc untouched (it is ignored on read).
 *
 * Fail-loud: a permission-denied, offline, or network write error propagates to
 * the caller's Save handler, which shows it beside the control the operator used.
 */
export interface SaveStamp {
  updatedAt: string;
  updatedBy: string;
}

export async function saveCoveragePackageConfig(
  config: CoveragePackageConfig,
): Promise<SaveStamp> {
  const updatedAt = new Date().toISOString();
  const updatedBy = auth.currentUser?.email ?? auth.currentUser?.uid ?? '';
  await setDoc(
    doc(db, COVERAGE_PACKAGE_COLLECTION, COVERAGE_PACKAGE_DOC_ID),
    { durations: config.durations, updatedAt, updatedBy },
    { merge: true },
  );
  return { updatedAt, updatedBy };
}
