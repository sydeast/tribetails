import { FieldValue } from 'firebase-admin/firestore';
import { db } from './firestoreAdmin';

/**
 * Entry state of the reconcile pipeline's state machine
 * (`auntieos-admin/web/functions-python/reconcile_comms.py`):
 *
 *   pending -> in_progress -> applied | skipped | error
 *
 * The pipeline finds work with `.where('reconcileStatus','==','pending')`
 * (reconcile_comms.py:704). Firestore's `==` matches only documents that HAVE
 * the field, so a report created without it is not "pending", it is invisible:
 * it never reconciles and nothing reports the omission.
 *
 * `backfill_kincare_reconcile_status.py` was written as a one-off for legacy
 * docs, on the assumption that everything created since carries the field. The
 * Android client creates reports straight from the device
 * (`KinCareRepository.createKinCareReport`) and never writes it, so that
 * assumption expires on every new KinTale and the "one-off" would have to be
 * re-run forever. Seeding it server-side at create is what closes that.
 */
export const RECONCILE_PENDING = 'pending';

export type SeedReconcileOutcome = 'seeded' | 'already-present' | 'demo-skipped' | 'missing';

/**
 * Stamps `reconcileStatus: 'pending'` on a just-created KinTale, and ONLY when
 * the field is absent.
 *
 * Absence-conditioned inside a transaction rather than a blind merge, because a
 * trigger retry replays the original create snapshot: the pipeline may already
 * have claimed the doc and moved it to `in_progress`, and re-stamping `pending`
 * over that claim would hand the same report to a second pass — two Claude
 * calls, two dossier notes, no error. The doc is re-read here so the write is
 * decided on current state, not on what the event carried.
 *
 * Demo fixtures are left alone, matching the backfill's own `_demo` skip
 * (backfill_kincare_reconcile_status.py:85-87): seeding them would feed seed
 * data to the reconcile pipeline.
 */
export async function seedReconcileStatus(reportId: string): Promise<SeedReconcileOutcome> {
  const ref = db().doc(`kin_care_reports/${reportId}`);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data() as Record<string, unknown> | undefined;
    if (!data) return 'missing';
    if (data['_demo'] === true) return 'demo-skipped';
    if ('reconcileStatus' in data) return 'already-present';

    tx.set(
      ref,
      {
        reconcileStatus: RECONCILE_PENDING,
        // Distinct from the backfill's `_reconcileStatusBackfillAt` so an
        // operator can tell a trigger-seeded doc from a migrated one.
        _reconcileStatusSeededAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return 'seeded';
  });
}
