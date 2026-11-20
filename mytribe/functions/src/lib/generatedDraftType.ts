/**
 * The type of a `generated_drafts` doc.
 *
 * The collection has two writers that never converged, so the type lives under
 * `communication_type` (the generator) or `communicationType` (migrated docs).
 * The value is compared exactly as stored: no trimming, no case folding, and a
 * value that is not a string matches nothing. `firestore.rules` compares it the
 * same way.
 *
 * A field that is present counts, whatever it holds. A draft whose two
 * spellings disagree has no type.
 */

type DraftData = Record<string, unknown>;

/** Every spelling of the type this draft carries, as stored. */
function storedTypes(draft: DraftData): unknown[] {
  return [draft['communication_type'], draft['communicationType']].filter((v) => v !== undefined);
}

/** True when the draft carries a type and every spelling of it is exactly `wanted`. */
export function draftTypeIsExactly(draft: DraftData, wanted: string): boolean {
  const types = storedTypes(draft);
  return types.length > 0 && types.every((v) => v === wanted);
}

/** A Push draft: what `sendHouseholdPush` sends. */
export function isPushDraft(draft: DraftData): boolean {
  return draftTypeIsExactly(draft, 'push');
}

/**
 * A KinTale draft as the rules define one for an Auntie (`isKinTaleDraftData`
 * in `firestore.rules`): the generator's spelling says exactly `visit_report`,
 * and the older spelling is absent or says the same.
 */
export function isKinTaleDraft(draft: DraftData): boolean {
  return draft['communication_type'] === 'visit_report' && draftTypeIsExactly(draft, 'visit_report');
}
