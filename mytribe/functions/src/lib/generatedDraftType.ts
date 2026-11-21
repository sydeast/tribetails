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

/** The two message types `sendGeneratedDraft` sends, and the channel each goes out on. */
export type DraftMessageChannel = 'email' | 'sms';

/** The channel an Email or Text draft goes out on, or null for every other type. */
export function draftMessageChannel(draft: DraftData): DraftMessageChannel | null {
  if (draftTypeIsExactly(draft, 'email')) return 'email';
  if (draftTypeIsExactly(draft, 'sms')) return 'sms';
  return null;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** A type either spelling carries. Looser than `draftTypeIsExactly` on purpose: see `draftWentOut`. */
function carriesType(draft: DraftData, wanted: readonly string[]): boolean {
  return storedTypes(draft).some((v) => typeof v === 'string' && wanted.includes(v));
}

/**
 * #2428: where an Email or Text draft stands.
 *
 *   unsent    nobody has approved it. It can be sent.
 *   sending   `sendGeneratedDraft` holds it (`sendClaimedAt`) and has not
 *             stamped an answer. Either the send is in flight, or it got no
 *             answer (`sendUnconfirmedAt`, or a claim left by a call that
 *             died), so the provider may have taken the message.
 *   approved  approved with no stamp. Every client before #2428 approved a
 *             draft with its own write and sent it straight afterwards, so this
 *             is a message that went out the old way.
 *   sent      `sendGeneratedDraft` stamped `sentAt`: the provider took it.
 *
 * Only `unsent` is ever sent. The other three are the same answer to "may this
 * go out": no. There is nothing on the provider's side that would catch a
 * second copy, so a draft that might have gone is never tried again.
 */
export type DraftSendState = 'unsent' | 'sending' | 'approved' | 'sent';

export function draftSendState(draft: DraftData): DraftSendState {
  if (text(draft['sentAt']) !== '') return 'sent';
  if (text(draft['status']).toLowerCase() !== 'approved') return 'unsent';
  return text(draft['sendClaimedAt']) !== '' ? 'sending' : 'approved';
}

/**
 * #2428: true when this draft is the record of something a household was sent,
 * or may have been. Such a draft is kept: `deleteGeneratedDraft` refuses it.
 *
 *   a KinTale          sent as a `kin_care_reports` doc (`publishedReportId`)
 *   an Email or Text   approved, which is when it goes out (`draftSendState`)
 *   a Push             on the household's notifications list or their phone
 *                      (`pushOutcome` `sent` or `listed`)
 *
 * A held Push, and one whose send never answered, reached nobody and stay
 * deletable. A type counts when EITHER spelling carries it: keeping a draft
 * that could have been deleted costs nothing, and deleting the record of a
 * message somebody received cannot be undone.
 */
export function draftWentOut(draft: DraftData): boolean {
  if (text(draft['publishedReportId']) !== '') return true;
  if (carriesType(draft, ['email', 'sms']) && draftSendState(draft) !== 'unsent') return true;
  const pushed = text(draft['pushOutcome']);
  return carriesType(draft, ['push']) && (pushed === 'sent' || pushed === 'listed');
}

/**
 * A KinTale draft as the rules define one for an Auntie (`isKinTaleDraftData`
 * in `firestore.rules`): the generator's spelling says exactly `visit_report`,
 * and the older spelling is absent or says the same.
 */
export function isKinTaleDraft(draft: DraftData): boolean {
  return draft['communication_type'] === 'visit_report' && draftTypeIsExactly(draft, 'visit_report');
}
