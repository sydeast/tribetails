import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { createKinCareSessionHandler } from '../src/admin/createKinCareSession';

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-1');
});

/**
 * C1: an admin-created session (the operator's own direct picker) is refused
 * exactly like a kinfolk request when it lands on a closed day -- there is no
 * `overrideCompanyHoliday`-style escape hatch to mirror `overrideBusyConflict`
 * with, per companyHolidayConflict.ts's header.
 */
describe('createKinCareSession company-holiday guard', () => {
  it('rejects a session on a closed day and writes nothing', async () => {
    const ctx = buildDbMock({
      docs: { 'business_settings/business_settings': { companyHolidays: ['2026-12-25|Christmas'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      createKinCareSessionHandler(
        req({
          kinfolkId: 'kf1',
          serviceType: 'Dog Walk',
          startTime: '2026-12-25T15:00:00.000Z',
          endTime: '2026-12-25T16:00:00.000Z',
        }),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });

    expect(ctx.adds.filter((a) => a.collection === 'kin_care_sessions')).toHaveLength(0);
  });

  it('an open day still creates the session', async () => {
    const ctx = buildDbMock({
      docs: { 'business_settings/business_settings': { companyHolidays: ['2026-12-25|Christmas'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await createKinCareSessionHandler(
      req({
        kinfolkId: 'kf1',
        serviceType: 'Dog Walk',
        startTime: '2026-12-24T15:00:00.000Z',
        endTime: '2026-12-24T16:00:00.000Z',
      }),
    );
    expect(res.ok).toBe(true);
  });
});
