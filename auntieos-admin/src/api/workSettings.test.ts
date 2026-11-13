import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call, currentSessionSeat, getBusinessSettings } = vi.hoisted(() => ({
  call: vi.fn(),
  currentSessionSeat: vi.fn(),
  getBusinessSettings: vi.fn(),
}));
vi.mock('../lib/fns', () => ({ call }));
vi.mock('../lib/sessionSeat', async (orig) => ({
  ...(await orig<typeof import('../lib/sessionSeat')>()),
  currentSessionSeat,
}));
vi.mock('./settings', async (orig) => ({
  ...(await orig<typeof import('./settings')>()),
  getBusinessSettings,
}));

import { decodeStaffWorkSettings, getWorkSettings } from './workSettings';
import { mergeBusinessSettings } from './settings';
import { loadSharedWorkSettings } from '../lib/useWorkSettings';
import { invalidateSharedLoad } from '../lib/useSharedOneShot';

const OWNER = { uid: 'owner-1', caretaker: false };
const AUNTIE = { uid: 'auntie-1', caretaker: true };

/** What `getStaffWorkSettings` answers: names and lengths, never a rate. */
const STAFF_REPLY = {
  services: [
    { id: 'Long walk', durationMinutes: '45' },
    { id: 'Overnight', durationMinutes: '' },
  ],
  timeZone: 'America/Denver',
  timeBlocks: [{ id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', active: true }],
  allowTimeBlockBooking: true,
  allowSpecificTimeBooking: false,
  defaultBookingMode: 'TIME_BLOCK',
  requireArrivalDepartureVerification: true,
  kinTaleRequired: true,
  snapRescheduleTo15Min: true,
};

beforeEach(() => {
  call.mockReset();
  currentSessionSeat.mockReset();
  getBusinessSettings.mockReset();
  invalidateSharedLoad();
});

describe('#2164 getWorkSettings', () => {
  it('the owner reads business_settings directly, as before, rates included', async () => {
    currentSessionSeat.mockResolvedValue(OWNER);
    getBusinessSettings.mockResolvedValue(
      mergeBusinessSettings({ serviceRates: { 'Long walk': '45.00' }, timeZone: 'America/Denver' }),
    );
    const s = await getWorkSettings();
    expect(call).not.toHaveBeenCalled();
    expect(s.serviceRates).toEqual({ 'Long walk': '45.00' });
    expect(s.ratesIncluded).toBe(true);
    expect(s.timeZone).toBe('America/Denver');
  });

  it('an Auntie never touches business_settings and gets the narrow staff read, with no rate in it', async () => {
    currentSessionSeat.mockResolvedValue(AUNTIE);
    call.mockResolvedValue(STAFF_REPLY);
    const s = await getWorkSettings();
    expect(getBusinessSettings).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledWith('getStaffWorkSettings', {});
    expect(s.serviceRates).toEqual({ 'Long walk': '', Overnight: '' });
    expect(s.serviceDurations).toEqual({ 'Long walk': '45' });
    expect(s.ratesIncluded).toBe(false);
    expect(s.timeZone).toBe('America/Denver');
    expect(s.timeBlocks).toEqual(STAFF_REPLY.timeBlocks);
    expect(s.allowSpecificTimeBooking).toBe(false);
    expect(s.defaultBookingMode).toBe('TIME_BLOCK');
    expect(s.requireArrivalDepartureVerification).toBe(true);
    expect(s.kinTaleRequired).toBe(true);
    expect(s.snapRescheduleTo15Min).toBe(true);
  });

  it("an Auntie's failed read throws, for the screen to say so", async () => {
    currentSessionSeat.mockResolvedValue(AUNTIE);
    call.mockRejectedValue(new Error('functions/unavailable'));
    await expect(getWorkSettings()).rejects.toThrow('functions/unavailable');
  });
});

describe('#2164 decodeStaffWorkSettings', () => {
  it('defaults a missing field exactly as the owner read of an empty document does', () => {
    const staff = decodeStaffWorkSettings({});
    const owner = mergeBusinessSettings(undefined);
    expect(staff.timeBlocks).toEqual(owner.timeBlocks);
    expect(staff.timeZone).toBe(owner.timeZone);
    expect(staff.requireArrivalDepartureVerification).toBe(false);
    expect(staff.kinTaleRequired).toBe(false);
    expect(staff.serviceRates).toEqual({});
  });

  it('drops a blank or malformed KinCare row rather than inventing one', () => {
    const s = decodeStaffWorkSettings({
      services: [{ id: '  ' }, { id: 7 } as never, { id: 'Walk', durationMinutes: 30 } as never],
    });
    expect(s.serviceRates).toEqual({ Walk: '' });
    expect(s.serviceDurations).toEqual({});
  });
});

describe('#2164 the shared read never crosses sessions', () => {
  it('an owner who signs out and an Auntie who signs in on the same tab get separate reads', async () => {
    currentSessionSeat.mockResolvedValueOnce(OWNER);
    getBusinessSettings.mockResolvedValue(mergeBusinessSettings({ serviceRates: { 'Long walk': '45.00' } }));
    const owner = await loadSharedWorkSettings();
    expect(owner.serviceRates).toEqual({ 'Long walk': '45.00' });

    currentSessionSeat.mockResolvedValueOnce(AUNTIE);
    call.mockResolvedValue(STAFF_REPLY);
    const auntie = await loadSharedWorkSettings();
    expect(call).toHaveBeenCalledWith('getStaffWorkSettings', {});
    expect(auntie.serviceRates['Long walk']).toBe('');
    expect(JSON.stringify(auntie)).not.toContain('45.00');
  });
});
