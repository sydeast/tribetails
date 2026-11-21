import { describe, it, expect } from 'vitest';
import {
  alreadySentText,
  DRAFT_SEND_LEASE_MS,
  draftListPlace,
  draftWentOut,
  isSentPushDraft,
  messageDraftStanding,
  sendRefusedUnconfirmed,
  sentDayOf,
  sentDraftOnOpen,
  sentMessageChannel,
  unconfirmedSendText,
} from './draftSent';
import type { GeneratedDraftRow } from '../api/drafts';

/** #2428: which stored drafts already went to their household, and what the screen says for one. */

const row = (over: Partial<GeneratedDraftRow>): GeneratedDraftRow => ({ _id: 'gd1', ...over });
const ZONE = 'America/Chicago';
const NOW = Date.parse('2026-11-20T18:00:00.000Z');
/** #2452: an Email whose send got no answer, as `sendGeneratedDraft` leaves it. */
const UNCONFIRMED: Partial<GeneratedDraftRow> = {
  communication_type: 'email',
  status: 'approved',
  approvedAt: '2026-11-20T16:00:00.000Z',
  sendClaimedAt: '2026-11-20T16:00:00.000Z',
  sendUnconfirmedAt: '2026-11-20T16:00:31.000Z',
};

/** A Text claimed a second ago: the send is running. */
const CLAIMED_NOW: Partial<GeneratedDraftRow> = {
  communicationType: 'sms',
  status: 'approved',
  sendClaimedAt: new Date(NOW - 1000).toISOString(),
};

describe('sentMessageChannel', () => {
  it('an Email or Text the server stamped sent', () => {
    expect(sentMessageChannel(row({ communication_type: 'email', status: 'approved', sentAt: '2026-11-20T16:00:00.000Z' }))).toBe('email');
    expect(sentMessageChannel(row({ communicationType: 'sms', status: 'approved', sentAt: '2026-11-20T16:00:00.000Z' }))).toBe('sms');
  });

  it('an approved Email or Text with no stamp: an older version sent it when it approved it', () => {
    expect(sentMessageChannel(row({ communication_type: 'email', status: 'approved' }))).toBe('email');
    expect(sentMessageChannel(row({ communicationType: 'sms', status: ' Approved ' }))).toBe('sms');
  });

  it('an Email or Text nobody has approved has not gone', () => {
    expect(sentMessageChannel(row({ communication_type: 'email', status: 'generated' }))).toBeNull();
    expect(sentMessageChannel(row({ communicationType: 'sms', status: 'pending' }))).toBeNull();
    expect(sentMessageChannel(row({ communication_type: 'email' }))).toBeNull();
  });

  it('every other type is not an Email or Text, whatever its status', () => {
    for (const type of ['push', 'visit_report', 'social_post', 'blog_post', 'general', '']) {
      expect(sentMessageChannel(row({ communication_type: type, status: 'approved' }))).toBeNull();
    }
  });
});

describe('isSentPushDraft', () => {
  const push = (over: Partial<GeneratedDraftRow>) => row({ communication_type: 'push', status: 'approved', ...over });

  it('a Push on their phone or on their notifications list', () => {
    expect(isSentPushDraft(push({ pushOutcome: 'sent' }))).toBe(true);
    expect(isSentPushDraft(push({ pushOutcome: 'listed', pushReason: 'no_device' }))).toBe(true);
  });

  it('a held Push, and one whose send never answered (#2381), reached nobody', () => {
    expect(isSentPushDraft(push({ pushOutcome: 'held' }))).toBe(false);
    expect(isSentPushDraft(push({ pushOutcome: '' }))).toBe(false);
    expect(isSentPushDraft(push({}))).toBe(false);
  });

  it('an Email does not become a sent Push by carrying a push answer', () => {
    expect(isSentPushDraft(row({ communication_type: 'email', status: 'approved', pushOutcome: 'sent' }))).toBe(false);
  });
});

describe('draftWentOut', () => {
  it('is true for a sent Push, Email or Text and false for everything unsent', () => {
    expect(draftWentOut(row({ communication_type: 'push', status: 'approved', pushOutcome: 'listed' }))).toBe(true);
    expect(draftWentOut(row({ communication_type: 'sms', status: 'approved' }))).toBe(true);
    expect(draftWentOut(row({ communication_type: 'sms', status: 'generated' }))).toBe(false);
    expect(draftWentOut(row({ communication_type: 'push', status: 'approved', pushOutcome: 'held' }))).toBe(false);
    expect(draftWentOut(row({ communication_type: 'blog_post', status: 'approved' }))).toBe(false);
  });
});

describe('sentDraftOnOpen', () => {
  it('a draft that has not gone out is null, so the screen opens it for approval', () => {
    expect(sentDraftOnOpen(row({ communication_type: 'email', status: 'generated' }), 'Dana Halbrook', ZONE, NOW)).toBeNull();
    expect(sentDraftOnOpen(row({ communication_type: 'push', status: 'approved', pushOutcome: 'held' }), 'Dana Halbrook', ZONE, NOW)).toBeNull();
    expect(sentDraftOnOpen(row({ communication_type: 'visit_report', status: 'published', publishedReportId: 'r1' }), 'Dana Halbrook', ZONE, NOW)).toBeNull();
  });

  it('a sent Push hands back the server answer for the push sentence', () => {
    expect(sentDraftOnOpen(row({ communication_type: 'push', status: 'approved', pushOutcome: 'sent', pushReason: '' }), 'Dana Halbrook', ZONE, NOW)).toEqual({
      push: { outcome: 'sent', reason: null },
      notice: null,
    });
    expect(
      sentDraftOnOpen(row({ communication_type: 'push', status: 'approved', pushOutcome: 'listed', pushReason: 'household_push_off' }), 'Dana Halbrook', ZONE, NOW),
    ).toEqual({ push: { outcome: 'listed', reason: 'household_push_off' }, notice: null });
  });

  it('a stamped Email says who it went to, how and when', () => {
    expect(
      sentDraftOnOpen(row({ communication_type: 'email', status: 'approved', sentAt: '2026-11-20T16:00:00.000Z' }), 'Dana Halbrook', ZONE, NOW)?.notice,
    ).toEqual({ title: 'Already sent', body: 'Sent to Dana Halbrook by email on Nov 20, 2026. It is not sent again.', tone: 'success' });
  });

  it('a stamped Text with a date that cannot be read leaves the date out', () => {
    expect(sentDraftOnOpen(row({ communication_type: 'sms', status: 'approved', sentAt: 'soon' }), '', ZONE, NOW)?.notice).toEqual({
      title: 'Already sent',
      body: 'Sent to the household by text. It is not sent again.',
      tone: 'success',
    });
  });

  it('an approved Email with no stamp says it was approved, never that a delivery was recorded', () => {
    const notice = sentDraftOnOpen(row({ communication_type: 'email', status: 'approved', approvedAt: '2026-11-03T16:00:00.000Z' }), 'Dana Halbrook', ZONE, NOW)?.notice;
    expect(notice).toEqual({
      title: 'Already approved',
      body: 'This email for Dana Halbrook was approved on Nov 3, 2026. Approving sends it, so it is not sent again.',
      tone: 'success',
    });
    expect(sentDraftOnOpen(row({ communication_type: 'email', status: 'approved' }), 'Dana Halbrook', ZONE, NOW)?.notice?.body).toBe(
      'This email for Dana Halbrook was approved. Approving sends it, so it is not sent again.',
    );
  });

  it('no sentence has an em dash or a raw field name in it', () => {
    const bodies = [
      sentDraftOnOpen(row({ communication_type: 'email', status: 'approved', sentAt: '2026-11-20T16:00:00.000Z' }), 'Dana Halbrook', ZONE, NOW)?.notice?.body,
      sentDraftOnOpen(row({ communication_type: 'sms', status: 'approved' }), 'Dana Halbrook', ZONE, NOW)?.notice?.body,
      alreadySentText('Dana Halbrook').body,
      sentDraftOnOpen(row({ ...UNCONFIRMED }), 'Dana Halbrook', ZONE, NOW)?.notice?.body,
      sentDraftOnOpen(row({ ...CLAIMED_NOW }), 'Dana Halbrook', ZONE, NOW)?.notice?.body,
      unconfirmedSendText('Dana Halbrook', 'sms').body,
    ];
    for (const body of bodies) {
      expect(body).toBeDefined();
      expect(body).not.toMatch(/[–—]|sentAt|approved_at|sms|generated_drafts/);
    }
  });
});

describe('alreadySentText', () => {
  it('names the household, or says the household when there is no name', () => {
    expect(alreadySentText('Dana Halbrook')).toEqual({
      title: 'Already sent',
      body: 'This message already went to Dana Halbrook. Nothing new was sent.',
      tone: 'success',
    });
    expect(alreadySentText('  ').body).toBe('This message already went to the household. Nothing new was sent.');
  });
});

describe('messageDraftStanding (#2452)', () => {
  it('reads sent, sending, unconfirmed and approved off the stamps the server writes', () => {
    expect(messageDraftStanding(row({ communication_type: 'email', status: 'approved', sentAt: '2026-11-20T16:00:00.000Z' }), NOW)).toBe('sent');
    expect(messageDraftStanding(row({ ...CLAIMED_NOW }), NOW)).toBe('sending');
    expect(messageDraftStanding(row({ ...UNCONFIRMED }), NOW)).toBe('unconfirmed');
    expect(messageDraftStanding(row({ communication_type: 'email', status: 'approved' }), NOW)).toBe('approved');
  });

  it('a mark wins over a fresh claim, and a stamp wins over both', () => {
    const fresh = new Date(NOW - 1000).toISOString();
    expect(messageDraftStanding(row({ ...UNCONFIRMED, sendClaimedAt: fresh, sendUnconfirmedAt: fresh }), NOW)).toBe('unconfirmed');
    expect(messageDraftStanding(row({ ...UNCONFIRMED, sentAt: fresh }), NOW)).toBe('sent');
  });

  it('a claim left by a call that died is unconfirmed once its two minutes have passed', () => {
    const claimedAgo = (ms: number) => row({ communication_type: 'sms', status: 'approved', sendClaimedAt: new Date(NOW - ms).toISOString() });
    expect(messageDraftStanding(claimedAgo(DRAFT_SEND_LEASE_MS - 1), NOW)).toBe('sending');
    expect(messageDraftStanding(claimedAgo(DRAFT_SEND_LEASE_MS), NOW)).toBe('unconfirmed');
    expect(messageDraftStanding(row({ communication_type: 'sms', status: 'approved', sendClaimedAt: 'not a time' }), NOW)).toBe('unconfirmed');
  });

  it('a draft nobody approved, and any other type, has no standing', () => {
    expect(messageDraftStanding(row({ communication_type: 'email', status: 'generated' }), NOW)).toBeNull();
    expect(messageDraftStanding(row({ communication_type: 'email', status: 'generated', sendClaimedAt: '2026-11-20T16:00:00.000Z' }), NOW)).toBeNull();
    expect(messageDraftStanding(row({ communication_type: 'push', status: 'approved', sendClaimedAt: '2026-11-20T16:00:00.000Z' }), NOW)).toBeNull();
    expect(messageDraftStanding(row({ communication_type: 'visit_report', status: 'approved' }), NOW)).toBeNull();
  });
});

describe('an unconfirmed send on open (#2452)', () => {
  it('says the send was not confirmed, that it is not sent again, and to write a new one', () => {
    expect(sentDraftOnOpen(row({ ...UNCONFIRMED }), 'Dana Halbrook', ZONE, NOW)).toEqual({
      push: null,
      notice: {
        title: 'Send not confirmed',
        body:
          'The send of this email to Dana Halbrook on Nov 20, 2026 did not get an answer, so it is not known whether it reached them. ' +
          'It is not sent again from this draft. Write a new one if it has to go again.',
        tone: 'warning',
      },
    });
  });

  it('never reads as approved or sent', () => {
    const notice = sentDraftOnOpen(row({ ...UNCONFIRMED }), 'Dana Halbrook', ZONE, NOW)?.notice;
    expect(notice?.title).not.toMatch(/approved|sent\b/i);
    expect(notice?.body).not.toMatch(/Already|was approved|Sent to|already went/);
  });

  it('a stale claim with no mark reads the same, dated by the claim', () => {
    const stale = row({ communicationType: 'sms', status: 'approved', sendClaimedAt: '2026-11-19T16:00:00.000Z' });
    expect(sentDraftOnOpen(stale, '', ZONE, NOW)?.notice).toEqual(unconfirmedSendText('', 'sms', 'Nov 19, 2026'));
    expect(unconfirmedSendText('', 'sms', 'Nov 19, 2026').body).toContain('The send of this text to the household on Nov 19, 2026 did not get an answer');
  });

  it('a send still running says so, and offers nothing', () => {
    expect(sentDraftOnOpen(row({ ...CLAIMED_NOW }), 'Dana Halbrook', ZONE, NOW)?.notice).toEqual({
      title: 'Being sent',
      body: 'This text for Dana Halbrook is being sent right now. Open it again in a few minutes to see what happened.',
      tone: 'warning',
    });
  });

  it('the notice for the server refusal in the same sitting carries no date', () => {
    expect(unconfirmedSendText('Dana Halbrook', 'email').body).toBe(
      'The send of this email to Dana Halbrook did not get an answer, so it is not known whether it reached them. ' +
        'It is not sent again from this draft. Write a new one if it has to go again.',
    );
  });

  it('sendRefusedUnconfirmed reads the code, never the sentence', () => {
    expect(sendRefusedUnconfirmed({ message: 'anything', details: { code: 'draft_send_unconfirmed' } })).toBe(true);
    expect(sendRefusedUnconfirmed({ message: 'The send did not get an answer', details: { code: 'draft_send_in_flight' } })).toBe(false);
    expect(sendRefusedUnconfirmed(new Error('The send did not get an answer'))).toBe(false);
    expect(sendRefusedUnconfirmed(null)).toBe(false);
  });
});

describe('the sent date is the business day, not the browser day (#2440)', () => {
  // 03:30 UTC on Nov 21 is 9:30 PM on Nov 20 in Chicago.
  const late = '2026-11-21T03:30:00.000Z';
  it('reads the stamp on the business clock', () => {
    expect(sentDayOf(late, 'America/Chicago')).toBe('Nov 20, 2026');
    expect(sentDayOf(late, 'UTC')).toBe('Nov 21, 2026');
    expect(sentDayOf(late, 'Pacific/Honolulu')).toBe('Nov 20, 2026');
  });

  it('falls back to America/Chicago when the setting is blank or unusable', () => {
    expect(sentDayOf(late, '')).toBe('Nov 20, 2026');
    expect(sentDayOf(late, 'Not/AZone')).toBe('Nov 20, 2026');
  });

  it('the notice carries that day', () => {
    const sent = row({ communication_type: 'email', status: 'approved', sentAt: late });
    expect(sentDraftOnOpen(sent, 'Dana Halbrook', 'America/Chicago', NOW)?.notice?.body).toContain('on Nov 20, 2026');
    expect(sentDraftOnOpen(sent, 'Dana Halbrook', 'UTC', NOW)?.notice?.body).toContain('on Nov 21, 2026');
  });
});

describe('draftListPlace (#2440)', () => {
  it('a draft that went out is filed under Sent', () => {
    expect(draftListPlace(row({ communication_type: 'email', status: 'approved', sentAt: '2026-11-20T16:00:00.000Z' }), NOW)).toBe('sent');
    expect(draftListPlace(row({ communicationType: 'sms', status: 'approved' }), NOW)).toBe('sent');
    expect(draftListPlace(row({ communication_type: 'push', status: 'approved', pushOutcome: 'sent' }), NOW)).toBe('sent');
    expect(draftListPlace(row({ communication_type: 'push', status: 'approved', pushOutcome: 'listed' }), NOW)).toBe('sent');
  });

  it('an unconfirmed send and a running one are never filed under Sent', () => {
    expect(draftListPlace(row({ ...UNCONFIRMED }), NOW)).toBe('unconfirmed');
    expect(draftListPlace(row({ ...CLAIMED_NOW }), NOW)).toBe('sending');
  });

  it('every other draft is left to the list rules', () => {
    expect(draftListPlace(row({ communication_type: 'email', status: 'generated' }), NOW)).toBeNull();
    expect(draftListPlace(row({ communication_type: 'push', status: 'approved', pushOutcome: 'held' }), NOW)).toBeNull();
    expect(draftListPlace(row({ communication_type: 'push', status: 'approved' }), NOW)).toBeNull();
    expect(draftListPlace(row({ communication_type: 'social_post', status: 'approved' }), NOW)).toBeNull();
    expect(draftListPlace(row({ communication_type: 'visit_report', status: 'published', publishedReportId: 'r1' }), NOW)).toBeNull();
  });
});
