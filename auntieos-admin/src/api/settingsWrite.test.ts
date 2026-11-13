import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { saveBusinessSettings, removeBusinessTag, changeBusinessTags } from './settingsWrite';
import { settingsRefusalsOf } from '../lib/settingsChecks';

beforeEach(() => {
  call.mockReset();
});

/**
 * #1593: Settings saves go through the `saveBusinessSettings` callable. The
 * rules deny `business_settings/business_settings` to every client, so a direct
 * write would be refused; the merge and whole-rate-card shapes are the server's
 * (mytribe/functions/test/saveBusinessSettings.test.ts pins them).
 */
describe('saveBusinessSettings', () => {
  it('sends the patch as `changes` to the callable and answers with the server stamp', async () => {
    call.mockResolvedValue({ updatedAt: '2026-11-09T18:00:00.000Z', updatedBy: 'owner@tribetails.com' });
    const stamp = await saveBusinessSettings({ businessName: 'Tribe Tails Care' });
    expect(call).toHaveBeenCalledWith('saveBusinessSettings', { changes: { businessName: 'Tribe Tails Care' } });
    expect(stamp).toEqual({ updatedAt: '2026-11-09T18:00:00.000Z', updatedBy: 'owner@tribetails.com' });
  });

  it('sends only the patched fields, never a client stamp', async () => {
    call.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    await saveBusinessSettings({ paypalHandle: 'TribeTails' });
    const [, payload] = call.mock.calls[0]!;
    expect(Object.keys((payload as { changes: object }).changes)).toEqual(['paypalHandle']);
  });

  it('drops a key with no value rather than sending it', async () => {
    call.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    await saveBusinessSettings({ timeZone: undefined as never, travelBufferMinutes: 30 });
    expect(call.mock.calls[0]![1]).toEqual({ changes: { travelBufferMinutes: 30 } });
  });

  it('keeps null, which is how a send hour is cleared', async () => {
    call.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    await saveBusinessSettings({ householdNotificationHour: null });
    expect(call.mock.calls[0]![1]).toEqual({ changes: { householdNotificationHour: null } });
  });

  it('sends the rate card whole, as the editor built it', async () => {
    call.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    await saveBusinessSettings({ serviceRates: { Overnight: '80.00' }, serviceDurations: {}, serviceStartTimeBooking: {} });
    expect(call.mock.calls[0]![1]).toEqual({
      changes: { serviceRates: { Overnight: '80.00' }, serviceDurations: {}, serviceStartTimeBooking: {} },
    });
  });

  it('rejects with the server refusal, and its per-field list reads back', async () => {
    const err = Object.assign(new Error('Enter the price for "Walk" in dollars, like 25 or 25.50.'), {
      code: 'functions/invalid-argument',
      details: {
        code: 'settings_refused',
        field: 'serviceRates',
        refusals: [{ field: 'serviceRates', message: 'Enter the price for "Walk" in dollars, like 25 or 25.50.' }],
      },
    });
    call.mockRejectedValue(err);
    const caught = await saveBusinessSettings({ serviceRates: { Walk: 'abc' } }).catch((e: unknown) => e);
    expect((caught as Error).message).toBe('Enter the price for "Walk" in dollars, like 25 or 25.50.');
    expect(settingsRefusalsOf(caught)).toEqual([
      { field: 'serviceRates', message: 'Enter the price for "Walk" in dollars, like 25 or 25.50.' },
    ]);
  });

  it('a failure with no refusal list reads as none', () => {
    expect(settingsRefusalsOf(new Error('unavailable'))).toEqual([]);
    expect(settingsRefusalsOf(null)).toEqual([]);
  });
});

describe('removeBusinessTag', () => {
  it('stays its own callable, not a settings save', async () => {
    call.mockResolvedValue({ ok: true, scope: 'household', name: 'VIP', recordsTouched: 2, vocabRemoved: true });
    await removeBusinessTag('household', 'VIP');
    expect(call).toHaveBeenCalledWith('removeBusinessTag', { scope: 'household', name: 'VIP' });
  });
});

// #2205: adds and recolours go to the server one named tag at a time.
describe('changeBusinessTags', () => {
  const teal = { token: 'teal', css: 'var(--color-accent)' };

  it('sends the named changes as `changes` and answers with both stored lists, decoded', async () => {
    call.mockResolvedValue({
      ok: true,
      householdTags: [{ name: 'VIP', color: teal, icon: '' }, { name: 'broken' }],
      petTags: [],
      updatedAt: 'x',
      updatedBy: 'y',
    });
    const changes = [{ action: 'add' as const, scope: 'household' as const, name: 'VIP', color: teal, icon: '' }];
    const after = await changeBusinessTags(changes);
    expect(call).toHaveBeenCalledWith('changeBusinessTags', { changes });
    expect(after).toEqual({ householdTags: [{ name: 'VIP', color: teal, icon: '' }], petTags: [] });
  });

  it('passes a refusal through with the server sentence', async () => {
    call.mockRejectedValue(new Error('A "VIP" tag already exists.'));
    await expect(
      changeBusinessTags([{ action: 'add', scope: 'pet', name: 'vip', color: teal, icon: '' }]),
    ).rejects.toThrow('A "VIP" tag already exists.');
  });
});
