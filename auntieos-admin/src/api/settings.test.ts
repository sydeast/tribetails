import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getDoc, doc } = vi.hoisted(() => ({ getDoc: vi.fn(), doc: vi.fn() }));
vi.mock('firebase/firestore', () => ({ getDoc, doc }));
vi.mock('../lib/firebase', () => ({ db: {} }));

import { getBusinessSettings, mergeBusinessSettings, DEFAULT_BUSINESS_SETTINGS } from './settings';

beforeEach(() => {
  getDoc.mockReset();
  doc.mockReset();
  doc.mockReturnValue('doc-ref');
});

describe('getBusinessSettings', () => {
  it('reads the single business_settings/business_settings doc directly, not a callable', async () => {
    getDoc.mockResolvedValue({ exists: () => true, data: () => ({ businessName: 'Tribe Tails' }) });
    const result = await getBusinessSettings();
    expect(doc).toHaveBeenCalledWith({}, 'business_settings', 'business_settings');
    expect(result.businessName).toBe('Tribe Tails');
  });

  it('returns the shipped defaults when no doc exists yet (never-configured install)', async () => {
    getDoc.mockResolvedValue({ exists: () => false, data: () => undefined });
    const result = await getBusinessSettings();
    expect(result).toEqual(DEFAULT_BUSINESS_SETTINGS);
  });

  it('propagates a genuine read failure (permission-denied, offline) for the caller to surface fail-loud', async () => {
    getDoc.mockRejectedValue(new Error('permission-denied'));
    await expect(getBusinessSettings()).rejects.toThrow('permission-denied');
  });
});

describe('mergeBusinessSettings', () => {
  it('defaults every top-level field, so a partial doc never yields undefined', () => {
    const result = mergeBusinessSettings({ businessEmail: 'auntie@tribetails.com' });
    expect(result.businessEmail).toBe('auntie@tribetails.com');
    expect(result.businessName).toBe('');
    // #1109: unset stays unset; readers resolve it to America/Chicago.
    expect(result.timeZone).toBe('');
    expect(result.businessHours).toEqual({});
    expect(result.serviceRates).toEqual({});
    expect(result.observedUsHolidays).toEqual([]);
  });

  it('keeps only exact-true serviceStartTimeBooking entries, the rule the server reads by (#1092)', () => {
    const result = mergeBusinessSettings({
      serviceStartTimeBooking: { Overnight: true, Walk: false, Drop: 'true', Nap: 1 },
    });
    expect(result.serviceStartTimeBooking).toEqual({ Overnight: true });
    expect(mergeBusinessSettings({}).serviceStartTimeBooking).toEqual({});
    expect(mergeBusinessSettings({ serviceStartTimeBooking: ['Overnight'] }).serviceStartTimeBooking).toEqual({});
  });
  it('defaults every field when the doc is entirely undefined', () => {
    expect(mergeBusinessSettings(undefined)).toEqual(DEFAULT_BUSINESS_SETTINGS);
  });

  it('deep-merges a partial mytribePortal instead of dropping sibling defaults', () => {
    const result = mergeBusinessSettings({ mytribePortal: { themeId: 'sunset' } });
    expect(result.mytribePortal.themeId).toBe('sunset');
    expect(result.mytribePortal.banner).toEqual(DEFAULT_BUSINESS_SETTINGS.mytribePortal.banner);
    expect(result.mytribePortal.chat).toEqual(DEFAULT_BUSINESS_SETTINGS.mytribePortal.chat);
  });

  it('deep-merges a partial mytribePortal.chat instead of dropping its siblings', () => {
    const result = mergeBusinessSettings({ mytribePortal: { chat: { awayMessage: "We're out" } } });
    expect(result.mytribePortal.chat.awayMessage).toBe("We're out");
    expect(result.mytribePortal.chat.enabled).toBe(true);
    expect(result.mytribePortal.chat.maxMessageLength).toBe(2000);
  });

  // #1987: prod holds a Home layout of four rows equal to the default, left
  // by a Limit that was typed and put back. It reads as the default.
  it('reads a stored Home layout equal to the default as the default, the empty list', () => {
    const rows = ['liveVisit', 'upNext', 'tales', 'quickStart'].map((id) => ({ id, enabled: true, limit: 0 }));
    expect(mergeBusinessSettings({ mytribePortal: { home: { sections: rows } } }).mytribePortal.home).toEqual({
      sections: [],
    });
  });
  it('reads a limit-only Home layout and a custom order exactly as stored', () => {
    const limitOnly = [
      { id: 'liveVisit', enabled: true, limit: 0 },
      { id: 'upNext', enabled: true, limit: 2 },
      { id: 'tales', enabled: true, limit: 0 },
      { id: 'quickStart', enabled: true, limit: 0 },
    ];
    expect(mergeBusinessSettings({ mytribePortal: { home: { sections: limitOnly } } }).mytribePortal.home.sections).toEqual(
      limitOnly,
    );
    const custom = [
      { id: 'quickStart', enabled: true, limit: 0 },
      { id: 'liveVisit', enabled: true, limit: 0 },
      { id: 'upNext', enabled: true, limit: 0 },
      { id: 'tales', enabled: true, limit: 0 },
    ];
    expect(mergeBusinessSettings({ mytribePortal: { home: { sections: custom } } }).mytribePortal.home.sections).toEqual(
      custom,
    );
  });
  it('preserves a real false/0/empty-string value rather than treating it as missing', () => {
    const result = mergeBusinessSettings({
      observeUsHolidays: false,
      autoConfirmRepeatKinfolk: false,
      travelBufferMinutes: 0,
      businessName: '',
    });
    expect(result.observeUsHolidays).toBe(false);
    expect(result.autoConfirmRepeatKinfolk).toBe(false);
    expect(result.travelBufferMinutes).toBe(0);
    expect(result.businessName).toBe('');
  });

  it('reads an absent requireArrivalDepartureVerification as OFF, the server reading (#1620)', () => {
    // functions/src/lib/arrivalVerification.ts: `=== true`. The editor showed ON while
    // Complete went through, and the next Settings save turned the rule on.
    expect(mergeBusinessSettings({}).requireArrivalDepartureVerification).toBe(false);
    expect(mergeBusinessSettings(undefined).requireArrivalDepartureVerification).toBe(false);
    expect(DEFAULT_BUSINESS_SETTINGS.requireArrivalDepartureVerification).toBe(false);
    expect(mergeBusinessSettings({ requireArrivalDepartureVerification: true }).requireArrivalDepartureVerification).toBe(true);
    expect(mergeBusinessSettings({ requireArrivalDepartureVerification: false }).requireArrivalDepartureVerification).toBe(false);
    // Anything but a real true is off, as on the server.
    expect(
      mergeBusinessSettings({ requireArrivalDepartureVerification: 'true' as unknown as boolean }).requireArrivalDepartureVerification,
    ).toBe(false);
  });
  it('defaults both tag vocabularies to [] when the doc has neither field', () => {
    const result = mergeBusinessSettings({ businessName: 'Tribe Tails' });
    expect(result.householdTags).toEqual([]);
    expect(result.petTags).toEqual([]);
  });

  it('keeps only well-formed tag rows and drops malformed ones (never throws)', () => {
    const result = mergeBusinessSettings({
      householdTags: [
        { name: 'VIP', color: { token: 'orange', css: 'var(--color-primary)' }, icon: '⭐' },
        { name: '', color: { token: 'teal', css: 'var(--color-accent)' }, icon: '' }, // blank name -> dropped
        { name: 'NoColor', icon: '' }, // missing color -> dropped
        { name: 'BadColor', color: { token: 'teal' }, icon: '' }, // color missing css -> dropped
        { name: 'BadIcon', color: { token: 'teal', css: 'var(--color-accent)' }, icon: 5 }, // icon not a string -> dropped
        'not-an-object', // -> dropped
      ],
      petTags: [{ name: 'Reactive', color: { token: 'coral', css: 'var(--color-coral)' }, icon: '' }],
    });
    expect(result.householdTags).toEqual([
      { name: 'VIP', color: { token: 'orange', css: 'var(--color-primary)' }, icon: '⭐' },
    ]);
    expect(result.petTags).toEqual([
      { name: 'Reactive', color: { token: 'coral', css: 'var(--color-coral)' }, icon: '' },
    ]);
  });
});
