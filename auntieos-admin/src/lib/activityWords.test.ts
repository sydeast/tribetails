import { describe, expect, it } from 'vitest';
import { visitTransitionWords as serverVisitTransitionWords } from '../../../mytribe/functions/src/lib/activityWords';
import { ACTIVITY_WORDS, activityDescriptionWords, visitTransitionWords } from './activityWords';
/**
 * #1797: the web clock tap writes its own Activity Log sentence. It must be the
 * server's words, so this runs the same inputs through both and pins fixed
 * strings besides, so a change to one side fails here.
 */
describe('visitTransitionWords (web mirror of the server helper)', () => {
  const cases: [string, string, string, string][] = [
    ['ON_MY_WAY', 'SCHEDULED', 'ON_MY_WAY', 'Marked the visit on the way: scheduled to on the way'],
    ['ARRIVED', 'ON_MY_WAY', 'ARRIVED', 'Marked the arrival: on the way to arrived'],
    ['DEPARTED', 'ARRIVED', 'DEPARTED', 'Marked the departure: arrived to departed'],
    ['UNDO_ARRIVAL', 'ARRIVED', 'ON_MY_WAY', 'Undid the arrival: arrived to on the way'],
  ];
  it.each(cases)('%s reads as words, equal to the server', (action, from, to, words) => {
    expect(visitTransitionWords(action, from, to)).toBe(words);
    expect(serverVisitTransitionWords(action, from, to)).toBe(words);
  });
  it('carries no session id or raw status key', () => {
    const text = visitTransitionWords('DEPARTED', 'ARRIVED', 'DEPARTED');
    expect(text).not.toMatch(/vis_|session|->|[A-Z]{4,}/);
  });
});


/**
 * #1747: the stored Activity Log rows that name `generated_drafts/<id>` read as
 * words. These are the exact shapes the three writers stored before the fix.
 */
describe('activityDescriptionWords', () => {
  it('reads a stored Communicate approval as words, whatever the household bracket says', () => {
    expect(activityDescriptionWords('Approved generated_drafts/aB3dE9 (kf-robyn)')).toBe('Approved an Auntie AI draft');
    expect(activityDescriptionWords('Approved generated_drafts/aB3dE9 (no kinfolk)')).toBe('Approved an Auntie AI draft');
    expect(activityDescriptionWords('Approved generated_drafts/aB3dE9 (no-kinfolk)')).toBe('Approved an Auntie AI draft');
  });

  it('reads the stored KinTale draft send and delete as words', () => {
    expect(activityDescriptionWords('Sent draft generated_drafts/d1 as KinTale rep_77 (kf-robyn)')).toBe(
      'Sent a KinTale draft',
    );
    expect(activityDescriptionWords('Deleted draft generated_drafts/d1 (no household)')).toBe('Deleted a KinTale draft');
    expect(activityDescriptionWords('Deleted unsent KinTale draft kin_care_reports/r1 (kf-robyn)')).toBe(
      'Deleted a KinTale draft',
    );
  });

  it('never leaves a draft path in any other text', () => {
    expect(activityDescriptionWords('Restored generated_drafts/d1 by hand')).toBe('Restored a draft by hand');
  });

  it('passes text with no path through untouched', () => {
    expect(activityDescriptionWords('  signed in ')).toBe('signed in');
    expect(activityDescriptionWords('')).toBe('');
  });

  it('the words the writers now store read as themselves', () => {
    for (const words of Object.values(ACTIVITY_WORDS)) {
      expect(activityDescriptionWords(words)).toBe(words);
    }
  });
});

/**
 * #1752: the other writers that put an id or a catalog key in the sentence.
 * Each stored shape and the words it reads as. The same pairs are in the
 * Android and desktop `ActivityWordsTest`, and the right-hand side is what the
 * server writes now (`mytribe/functions/test/activityWords.test.ts`), except
 * that an old notification row names its key in words.
 */
const STORED_ID_SHAPES: readonly (readonly [string, string])[] = [
  ["Notification kincare.booking.confirm delivered via email", "Delivered \"Kincare booking confirm\" by email"],
  ["Notification invoice.new dispatched to email, push", "Sent \"Invoice new\" by email and push notification"],
  ["Notification (unknown key) dispatched to sms", "Sent a notification by text message"],
  ["Notification kincare.changed archived", "Archived \"Kincare changed\""],
  ["Notification n8Xq2LmP0aZ restored to the active inbox", "Restored a notification to the notifications list"],
  ["Notification kincare.changed viewed", "Viewed \"Kincare changed\""],
  ["Notification kincare.changed marked unread", "Marked \"Kincare changed\" unread"],
  ["COMPLETE on session s_9fK2: SCHEDULED -> COMPLETED", "Completed the visit: scheduled to completed"],
  ["APPROVE on session s_9fK2: PENDING -> SCHEDULED", "Approved the visit: requested to scheduled"],
  ["ARRIVED on session s_9fK2: ON_MY_WAY -> ARRIVED", "Marked the arrival: on the way to arrived"],
  ["COMPLETE on session s_9fK2: already COMPLETED, no write", "Did not complete the visit: the visit was already completed"],
  ["COMPLETE refused: session 's_9fK2' not found", "Could not complete the visit: the visit was not found"],
  ["DEPARTED refused: unreadable status on session 's_9fK2'", "Could not mark the departure: the visit's status could not be read"],
  ["APPROVE refused: illegal from CANCELLED", "Could not approve the visit: the visit is cancelled"],
  ["COMPLETE refused: session 's_9fK2' has no arrival or departure recorded", "Could not complete the visit: no arrival or departure recorded"],
  ["COMPLETE refused: session 's_9fK2' arrival was recorded 2400m from the household (radius 200m)", "Could not complete the visit: arrival was recorded 2400m from the household (radius 200m)"],
  ["APPROVE refused: That time overlaps another visit.", "Could not approve the visit: That time overlaps another visit."],
  ["Arrival location check on session s_9fK2: outside", "Arrival location check: outside the household radius"],
  ["Account credit of 2500 cents given to household kf_rivera", "Gave $25.00 account credit"],
  ["Admin created 4 visit(s) (weekly) for kf_rivera", "Created 4 visits (weekly)"],
  ["Assigned orphan KinTale r_77 to kinfolk The Rivera Home (kf_rivera)", "Assigned a KinTale from Needs triage to The Rivera Home"],
  ["Marked orphan KinTale r_77 as duplicate of r_12", "Marked a KinTale in Needs triage as a duplicate"],
  ["Archived orphan KinTale r_77 as bad data: test row", "Archived a KinTale from Needs triage as bad data: test row"],
  ["Invoice PDF generated for inv_3Qp", "Made the PDF for an invoice"],
  ["Kinfolk downloaded invoice PDF for inv_3Qp", "Household downloaded the PDF for an invoice"],
  ["Vet clinic archive refused: 'vc_12' not found", "Vet clinic archive refused: the clinic was not found"],
  ["Edited session s_9fK2: serviceType, kinIds, kinNames", "Edited a visit: service, kin"],
  ["Synced visit s_9fK2 to Google Calendar (updated)", "Synced a visit to Google Calendar (updated)"],
  ["AI tale titles applied from batch b_1 (3 applied, 1 skipped, 0 errored)", "Applied AI KinTale titles (3 applied, 1 skipped, 0 errored)"],
  ["Invite inv_k2 was sent, but the Auntie notice was not: ADMIN_ORIGIN is not configured.", "An invite was sent, but the Auntie notice was not: ADMIN_ORIGIN is not configured."],
  ["Payment notification for invoice inv_3Qp was not delivered after 5 retries", "A payment notification was not delivered after 5 retries"],
];

describe('activityDescriptionWords reads stored ids as words (#1752)', () => {
  it.each(STORED_ID_SHAPES)('%s', (stored, words) => {
    expect(activityDescriptionWords(stored)).toBe(words);
  });

  it('the words the writers now store read as themselves', () => {
    for (const [, words] of STORED_ID_SHAPES) {
      expect(activityDescriptionWords(words)).toBe(words);
    }
  });
});
describe('activityDescriptionWords: a look at a household (#1839)', () => {
  it('reads the stored bare key, with or without ids, as words', () => {
    expect(activityDescriptionWords('OPERATOR_CROSSTENANT_ACCESS uid=u_owner1 target=Xk29fLq0aBcD3eFgH1jK')).toBe(
      'Opened a household',
    );
    expect(activityDescriptionWords('OPERATOR_CROSSTENANT_ACCESS uid=u_owner1')).toBe('Opened a household');
    expect(activityDescriptionWords('OPERATOR_CROSSTENANT_ACCESS')).toBe('Opened a household');
  });
  it("the server's new sentence for an Auntie reads as itself", () => {
    const words = 'Jane Rivers looked at Kinfolk Dre East';
    expect(activityDescriptionWords(words)).toBe(words);
  });
});
