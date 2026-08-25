import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));

import { getBookingPolicyHandler } from '../src/portal/getBookingPolicy';

function req(uid: string | null = 'kin1'): CallableRequest<unknown> {
  return {
    data: {},
    auth: uid ? ({ uid } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

beforeEach(() => {
  mocks.dbFn.mockReset();
});

/**
 * The portal's seam onto the bookable windows. `business_settings` is admin-only
 * in firestore.rules, so this is the only way a household learns what it may
 * pick from — which makes "what does NOT cross the boundary" as much of a test
 * subject as what does.
 */
describe('getBookingPolicy', () => {
  it('rejects an unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({}).db);
    await expect(getBookingPolicyHandler(req(null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('serves the active blocks and the three mode switches', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        docs: {
          'business_settings/business_settings': {
            allowTimeBlockBooking: true,
            allowSpecificTimeBooking: false,
            defaultBookingMode: 'TIME_BLOCK',
            defaultTimeBlockDurationHours: 4,
            timeBlocks: [
              { id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', active: true },
              { id: 'evening', label: 'Evening', startTime: '17:00', endTime: '21:00', active: false },
            ],
          },
        },
      }).db,
    );

    const res = await getBookingPolicyHandler(req());
    expect(res).toEqual({
      allowTimeBlockBooking: true,
      allowSpecificTimeBooking: false,
      defaultBookingMode: 'TIME_BLOCK',
      timeBlocks: [
        { id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', durationMinutes: 240 },
      ],
    });
  });

  /**
   * THE BOUNDARY TEST. A household may learn how it books and which windows
   * exist. It may not learn the rates, the integration state, the notification
   * policy, the GPS settings or the business's timezone as a side effect.
   */
  it('leaks nothing else off the business_settings document', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        docs: {
          'business_settings/business_settings': {
            allowTimeBlockBooking: true,
            allowSpecificTimeBooking: true,
            defaultBookingMode: 'TIME_BLOCK',
            timeBlocks: [{ id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', active: true }],
            // None of this may come back.
            serviceRates: { '30Minute': '25' },
            timeZone: 'America/Chicago',
            defaultTimeBlockDurationHours: 4,
            travelBufferMinutes: 30,
            companyHolidays: ['2026-12-25|Christmas'],
            calendarSyncId: 'secret-calendar',
            notificationEmail: true,
            autoConfirmRepeatKinfolk: true,
          },
        },
      }).db,
    );

    const res = await getBookingPolicyHandler(req());
    expect(Object.keys(res).sort()).toEqual([
      'allowSpecificTimeBooking',
      'allowTimeBlockBooking',
      'defaultBookingMode',
      'timeBlocks',
    ]);
    expect(Object.keys(res.timeBlocks[0]).sort()).toEqual([
      'durationMinutes',
      'endTime',
      'id',
      'label',
      'startTime',
    ]);
    expect(JSON.stringify(res)).not.toContain('America/Chicago');
    expect(JSON.stringify(res)).not.toContain('secret-calendar');
    expect(JSON.stringify(res)).not.toContain('30Minute');
  });

  it('a business that never configured a block gets specific-time booking, not an empty picker', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({}).db);
    const res = await getBookingPolicyHandler(req());
    expect(res.allowTimeBlockBooking).toBe(false);
    expect(res.allowSpecificTimeBooking).toBe(true);
    expect(res.defaultBookingMode).toBe('SPECIFIC_TIME');
    expect(res.timeBlocks).toEqual([]);
  });

  it('a legacy id-only block row does not blow the read up', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        docs: {
          'business_settings/business_settings': {
            allowTimeBlockBooking: true,
            allowSpecificTimeBooking: true,
            timeBlocks: [{ id: 'midday' }, { id: 'evening', startTime: '17:00', endTime: '21:00' }],
          },
        },
      }).db,
    );
    const res = await getBookingPolicyHandler(req());
    expect(res.timeBlocks.map((b) => b.id)).toEqual(['evening']);
  });

  it('a settings read that fails degrades to the pre-time-block behaviour rather than throwing', async () => {
    mocks.dbFn.mockReturnValue({
      collection: () => ({ doc: () => ({ get: () => Promise.reject(new Error('firestore down')) }) }),
    } as any);
    const res = await getBookingPolicyHandler(req());
    expect(res).toEqual({
      allowTimeBlockBooking: false,
      allowSpecificTimeBooking: true,
      defaultBookingMode: 'SPECIFIC_TIME',
      timeBlocks: [],
    });
  });
});
