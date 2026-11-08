/**
 * What an Activity Log entry's description says, in the operator's words
 * (#1747).
 *
 * Four writers used to put a Firestore path in the description: approving a
 * Communicate draft wrote "Approved generated_drafts/<id> (<kinfolkId>)", and
 * the server's KinTale draft callables wrote "Sent draft generated_drafts/<id>
 * as KinTale <reportId> (<kinfolkId>)" and "Deleted draft generated_drafts/<id>
 * (<kinfolkId>)", and deleting an unsent KinTale wrote "Deleted unsent KinTale
 * draft kin_care_reports/<id> (<kinfolkId>)". The Activity Log shows a
 * description as written, so the operator read a collection path and two ids.
 *
 * The writers now write {@link ACTIVITY_WORDS}. The entries already stored are
 * evidence rows and are never rewritten; {@link activityDescriptionWords} reads
 * them as the same words at display time. The ids stay on the entry as its
 * target and payload, which is where the evidence log keeps them.
 *
 * Same sentences as Android (`ui/admin/ActivityLogScreen.kt`), the desktop
 * console (`screens/activity/ActivityLogScreen.kt`) and the server
 * (`mytribe/functions/src/admin/kinTaleDrafts.ts`).
 */
export const ACTIVITY_WORDS = {
  draftApproved: 'Approved an Auntie AI draft',
  kinTaleDraftSent: 'Sent a KinTale draft',
  kinTaleDraftDeleted: 'Deleted a KinTale draft',
} as const;

/** The stored shapes, in full: the path, any ids after it, the household in brackets. */
const STORED_SHAPES: readonly (readonly [RegExp, string])[] = [
  [/^Approved generated_drafts\/\S+(?: \([^)]*\))?$/, ACTIVITY_WORDS.draftApproved],
  [/^Sent draft generated_drafts\/\S+ as KinTale \S+(?: \([^)]*\))?$/, ACTIVITY_WORDS.kinTaleDraftSent],
  [/^Deleted draft generated_drafts\/\S+(?: \([^)]*\))?$/, ACTIVITY_WORDS.kinTaleDraftDeleted],
  [/^Deleted unsent KinTale draft kin_care_reports\/\S+(?: \([^)]*\))?$/, ACTIVITY_WORDS.kinTaleDraftDeleted],
];

/** Any other mention of a draft's path, for a writer this file does not know. */
const DRAFT_PATH = /(?:generated_drafts|kin_care_reports)\/[\w-]+/g;

/** A stored description as the operator reads it. Text with no path passes through. */
export function activityDescriptionWords(description: string): string {
  const text = description.trim();
  for (const [shape, words] of STORED_SHAPES) {
    if (shape.test(text)) return words;
  }
  return text.replace(DRAFT_PATH, 'a draft');
}
