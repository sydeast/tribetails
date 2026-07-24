import { doc, setDoc } from 'firebase/firestore';
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
 * `merge: true`, but the whole config (both `durations` and `rules`) is always
 * written together — the screen holds both in state and saves them as one unit,
 * so there is no sibling field to preserve and no array-merge surprise (Firestore
 * replaces, not merges, an array field under `merge: true`).
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
    { durations: config.durations, rules: config.rules, updatedAt, updatedBy },
    { merge: true },
  );
  return { updatedAt, updatedBy };
}
