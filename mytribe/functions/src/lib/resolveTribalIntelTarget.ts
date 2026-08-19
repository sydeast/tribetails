import { HttpsError } from 'firebase-functions/v2/https';
import { db } from './firestoreAdmin';

/**
 * Server-side proof that a Tribal Intel entry points at something that exists.
 *
 * ── WHY THIS MODULE EXISTS (issue #460) ───────────────────────────────────
 * `targetKinfolkId` was only ever checked with `z.string().min(1)`, so any
 * non-blank string passed. Rows imported from the old system store a person's
 * NAME in `kinfolkRef` ("Jane Halbrook") where rows written by the callables
 * store an id. The editor seeds its picker from that string, no option matches
 * it, and `min(1)` happily accepted the name straight back on save. The entry
 * then sat in Firestore pointing at nothing any reader could resolve: the
 * nightly Python pipeline looks the value up as a document id
 * (`reconcile_comms.py#_resolve_kinfolk`, which reads `targetKinfolkId` OR
 * `kinfolkRef`) and silently skips the note when the lookup misses, so intel
 * an operator deliberately filed never reaches the dossier.
 *
 * A length check cannot tell a name from an id. Only a read can, so this
 * module does the read.
 *
 * ── WHAT "RESOLVES" MEANS, exactly ────────────────────────────────────────
 * The anchor must be a live `kinfolk/{id}` document. All three target types
 * (issue #393's HOUSEHOLD | KINFOLK | KIN) resolve through that one collection
 * because `families/{kinfolkId}` is provisioned under the SAME id as its
 * `kinfolk/{kinfolkId}` record (`triggers/familyProvision.ts`), and because
 * `kinfolk/{id}` is the exact lookup the nightly pipeline performs. Checking
 * what the pipeline checks is what makes "it resolves" mean "the note will
 * actually land".
 *
 * ── WHERE EACH TARGET NOW GOES, and why the check did not have to grow ────
 * Issue #461 has landed. The three target types route to three destinations,
 * and #460 left the HOUSEHOLD branch below as the one place that would change:
 *
 *   HOUSEHOLD  ->  household_bank/{householdId}   (upsert_household_bank)
 *   KINFOLK    ->  dossiers/{kinfolkId}           (upsert_dossier)
 *   KIN        ->  the_411/411_{kinId}            (upsert_kin411)
 *
 * The answer that branch needed is that a household has no identifier of its
 * own. The household id IS the anchoring kinfolk id, the same id
 * `household_data.kinfolkId` and `families/{id}` already use, so
 * `household_bank/{householdId}` is keyed by the very id the anchor read above
 * has already proved. #461 added a third destination, not a third reference to
 * validate, which is why the check did not grow a branch.
 *
 * `families/{id}` existence is still deliberately NOT checked, now for a
 * settled reason rather than a deferred one: it is not the record a household
 * note routes to. Neither is the bank checked, and that is the load-bearing
 * decision here. `upsert_household_bank` CREATES the bank when a household has
 * none, exactly as `upsert_dossier` and `upsert_kin411` create theirs, so
 * every household starts without one. Requiring it to exist would refuse the
 * first household-targeted note ever filed against a household, which is the
 * same bug #460 warned about one collection over. Once the anchor resolves,
 * nothing else about a HOUSEHOLD save can fail to resolve.
 *
 * What #461 DID change is the cost of getting this wrong. A targeted note now
 * lands in exactly one record and has no second destination to fall back on: a
 * KIN note that once also reached the household's dossier now reaches only the
 * pet's 411. This check is what keeps that one destination real at write time;
 * `reconcile_comms.py` marks the note `error` rather than `applied` if the pet
 * is deleted between the save and the nightly run.
 *
 * ── WHAT IT NEVER DOES ────────────────────────────────────────────────────
 * It never repairs a bad reference in passing. A save carrying a name is
 * REFUSED with a message naming the picker to use; guessing which household a
 * typed name meant is the sweep script's job
 * (`mytribe/scripts/backfillTribalIntelTargetIds.ts`), where a human reads the
 * plan first and an ambiguous name is left alone rather than resolved.
 */

/** The three targets, verbatim from the callables' own enum. */
export type TribalIntelTargetType = 'HOUSEHOLD' | 'KINFOLK' | 'KIN';

/** The reference fields this module judges. */
export interface TribalIntelTargetRef {
  targetType: TribalIntelTargetType;
  targetKinfolkId: string;
  targetKinId?: string | undefined;
}

/**
 * The noun each target goes by in the picker the operator is looking at
 * (`TribalIntelForm.tsx` / `TrainingDocumentsScreen.kt` both label the anchor
 * field "Kinfolk" under a KINFOLK target and "Household" otherwise). Both
 * clients word their own stale-target warning the same way
 * (`tribalIntelStaleTargetMessage`), so a refusal that arrives from the server
 * reads as the same complaint rather than a second, different one.
 */
function anchorNoun(targetType: TribalIntelTargetType): string {
  return targetType === 'KINFOLK' ? 'kinfolk' : 'household';
}

/**
 * A `/` cannot appear in a Firestore document id: `collection().doc(value)`
 * throws a raw SDK error on one rather than reporting "no such document", and
 * that error would surface to the operator as an `internal`. Rejected up front
 * so every bad reference leaves through the same door.
 */
function isImpossibleDocumentId(value: string): boolean {
  return value === '' || value.includes('/');
}

function refusal(message: string, path: string): HttpsError {
  // Same detail shape the zod path already returns, so a client that reads
  // `validationErrors` to place a message beside its field keeps working. The
  // top-level message is written for a human, because that is what the
  // callable SDK surfaces as `error.message` on all three clients.
  return new HttpsError('invalid-argument', message, {
    validationErrors: [{ path, message }],
  });
}

/** The refusal for an anchor that is not a kinfolk id. Exported for the tests that assert its wording. */
export function unresolvedAnchorMessage(targetType: TribalIntelTargetType, value: string): string {
  const noun = anchorNoun(targetType);
  return `This entry points at "${value}", which is not a ${noun} on the roster. Pick the right ${noun} and save again.`;
}

/** The refusal for a pet reference that is not a kin id. */
export function unresolvedKinMessage(value: string): string {
  return `This entry points at "${value}", which is not a pet on the roster. Pick the right pet and save again.`;
}

/** The refusal for a pet that belongs to a different household than the anchor. */
export function kinHouseholdMismatchMessage(kinId: string, ownerId: string, anchorId: string): string {
  return (
    `The pet "${kinId}" belongs to household "${ownerId}", not "${anchorId}". ` +
    'Pick a pet from the household this entry names, or change the household.'
  );
}

/**
 * Throws `invalid-argument` unless the reference resolves. Returns nothing on
 * success: callers only need to know the save may proceed.
 *
 * Two reads at most, both by document id, so this adds a single round trip to
 * a household or kinfolk save and two to a pet save.
 */
export async function assertTribalIntelTargetResolves(ref: TribalIntelTargetRef): Promise<void> {
  const anchorId = ref.targetKinfolkId.trim();
  if (isImpossibleDocumentId(anchorId)) {
    throw refusal(unresolvedAnchorMessage(ref.targetType, ref.targetKinfolkId), 'targetKinfolkId');
  }

  const anchorSnap = await db().collection('kinfolk').doc(anchorId).get();
  if (!anchorSnap.exists) {
    throw refusal(unresolvedAnchorMessage(ref.targetType, anchorId), 'targetKinfolkId');
  }

  // HOUSEHOLD and KINFOLK are both fully anchored by the id just proved above.
  // The difference between them is who the note is ABOUT and which record it
  // folds into (the household's bank versus that person's dossier), not where
  // it points, so neither has a second document to check. In particular a
  // HOUSEHOLD save must NOT require `household_bank/{anchorId}` to exist: the
  // pipeline creates it on first write, so demanding it here would refuse the
  // first household note ever filed. See the header for the full reasoning.
  if (ref.targetType !== 'KIN') return;

  const kinId = (ref.targetKinId ?? '').trim();
  if (isImpossibleDocumentId(kinId)) {
    throw refusal(unresolvedKinMessage(ref.targetKinId ?? ''), 'targetKinId');
  }

  const kinSnap = await db().collection('kin').doc(kinId).get();
  if (!kinSnap.exists) {
    throw refusal(unresolvedKinMessage(kinId), 'targetKinId');
  }

  // The pet must belong to the household the entry names, or the note would be
  // filed against one family and fold into another family's 411.
  //
  // Checked ONLY when the kin doc actually carries an owner. A `kin` row with a
  // blank `kinfolkId` is an orphan the roster already can't place, and refusing
  // to save intel about it would punish the operator for a data defect in a
  // different collection. The pet exists, the household exists, and the entry
  // says they go together: that is as much as this callable can honestly judge.
  const owner = str((kinSnap.data() ?? {})['kinfolkId']);
  if (owner !== '' && owner !== anchorId) {
    throw refusal(kinHouseholdMismatchMessage(kinId, owner, anchorId), 'targetKinId');
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
