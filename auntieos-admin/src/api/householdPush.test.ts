import { describe, it, expect, vi } from 'vitest';
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));
import { sendHouseholdPush, householdPushResultText, householdPushRetryable } from './householdPush';
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
