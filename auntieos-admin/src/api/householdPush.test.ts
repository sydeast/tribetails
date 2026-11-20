import { describe, it, expect, vi } from 'vitest';
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));
import {
  sendHouseholdPush,
  householdPushResultText,
  householdPushRetryable,
  personalizeDraftActions,
  pushRefusalNeedsApproval,
} from './householdPush';
// Reset inside each test, not from a beforeEach: see the note in
// screens/CommunicatePersonalize.test.tsx on resetting a mocked local module.
describe('sendHouseholdPush (#2061)', () => {
  it('sends the household, the draft and the trimmed line, and no blank title', async () => {
    call.mockReset().mockResolvedValue({ ok: true, outcome: 'sent', reason: null });
    const r = await sendHouseholdPush({ kinfolkId: 'kf1', draftId: 'd1', body: '  Hi there  ', title: ' ' });
    expect(call).toHaveBeenCalledWith('sendHouseholdPush', { kinfolkId: 'kf1', draftId: 'd1', body: 'Hi there' }, { idempotent: true });
    expect(r).toEqual({ outcome: 'sent', reason: null });
  });
  it('never claims a send it cannot read', async () => {
    call.mockReset().mockResolvedValue({ ok: true });
    expect((await sendHouseholdPush({ kinfolkId: 'kf1', draftId: 'd1', body: 'x' })).outcome).toBe('held');
  });
  it('never takes "unanswered" from the server: that word is this client\'s own', async () => {
    call.mockReset().mockResolvedValue({ ok: true, outcome: 'unanswered' });
    expect((await sendHouseholdPush({ kinfolkId: 'kf1', draftId: 'd1', body: 'x' })).outcome).toBe('held');
  });
  it('passes a refusal through', async () => {
    call.mockReset().mockRejectedValue(new Error('unavailable'));
    await expect(sendHouseholdPush({ kinfolkId: 'kf1', draftId: 'd1', body: 'x' })).rejects.toThrow('unavailable');
  });
});
describe('householdPushResultText (#2061)', () => {
  it('only a sent result says a push went out', () => {
    expect(householdPushResultText({ outcome: 'sent', reason: null }, 'Dana').body).toMatch(/^Sent to Dana's phone/);
    for (const r of [
      { outcome: 'listed', reason: 'household_push_off' },
      { outcome: 'listed', reason: 'no_device' },
      { outcome: 'listed', reason: 'push_failed' },
      { outcome: 'held', reason: 'household_notices_off' },
      { outcome: 'held', reason: 'household_has_no_portal_account' },
      { outcome: 'held', reason: 'notice_turned_off' },
    ] as const) {
      const words = householdPushResultText(r, 'Dana');
      expect(words.body).not.toMatch(/^Sent/);
      expect(words.body).not.toMatch(/—/);
    }
  });
  it('a held push can be tried again; a listed or sent one cannot', () => {
    expect(householdPushRetryable({ outcome: 'held', reason: 'household_notices_off' })).toBe(true);
    expect(householdPushRetryable({ outcome: 'listed', reason: 'no_device' })).toBe(false);
    expect(householdPushRetryable({ outcome: 'sent', reason: null })).toBe(false);
  });
});
describe('a Push draft that did not go out (#2381, #2389)', () => {
  const held = { outcome: 'held', reason: 'household_notices_off' } as const;
  const unanswered = { outcome: 'unanswered', reason: null } as const;
  it('an unanswered send can be tried again, and never says anything reached or missed the household', () => {
    expect(householdPushRetryable(unanswered)).toBe(true);
    const words = householdPushResultText(unanswered, 'Dana');
    expect(words.title).toBe('Not confirmed');
    expect(words.body).toBe(
      'The last send did not answer, so it is not known whether this push reached Dana. Try again. A push that already went out is not sent twice.',
    );
    expect(words.body).not.toMatch(/Nothing reached|^Sent/);
  });
  it('an unapproved draft offers Approve and Delete', () => {
    expect(personalizeDraftActions({ published: false, approved: false, pushResult: null })).toEqual({ approve: true, remove: true });
  });
  it('a held or unanswered Push keeps Delete and has no second Approve', () => {
    for (const pushResult of [held, unanswered]) {
      expect(personalizeDraftActions({ published: false, approved: true, pushResult })).toEqual({ approve: false, remove: true });
    }
  });
  it('a draft that reached its household offers neither', () => {
    for (const pushResult of [
      { outcome: 'sent', reason: null },
      { outcome: 'already_sent', reason: null },
      { outcome: 'listed', reason: 'no_device' },
    ] as const) {
      expect(personalizeDraftActions({ published: false, approved: true, pushResult })).toEqual({ approve: false, remove: false });
    }
    // An approved email, or a KinTale already sent.
    expect(personalizeDraftActions({ published: false, approved: true, pushResult: null })).toEqual({ approve: false, remove: false });
    expect(personalizeDraftActions({ published: true, approved: false, pushResult: null })).toEqual({ approve: false, remove: false });
  });
  it('only a refusal of the words sends the screen back to unapproved', () => {
    expect(pushRefusalNeedsApproval({ code: 'functions/failed-precondition', details: { code: 'push_words_changed' } })).toBe(true);
    expect(pushRefusalNeedsApproval({ code: 'functions/failed-precondition' })).toBe(false);
    expect(pushRefusalNeedsApproval({ code: 'functions/aborted', details: { code: 'push_in_flight' } })).toBe(false);
    expect(pushRefusalNeedsApproval(new Error('unavailable'))).toBe(false);
    expect(pushRefusalNeedsApproval(null)).toBe(false);
  });
});
