import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { createKinCareSessionHandler } from '../src/admin/createKinCareSession';
import { rescheduleBookingHandler } from '../src/admin/rescheduleBooking';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

describe('createKinCareSession', () => {
  it('HAPPY: creates a SCHEDULED session doc + returns its id', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await createKinCareSessionHandler(req({
      kinfolkId: 'kf1', kinIds: ['k1'], serviceType: 'Dog Walking',
      startTime: '2026-06-10T13:00:00Z', endTime: '2026-06-10T14:00:00Z',
    }));
    expect(res.ok).toBe(true);
    const add = ctx.adds.find((a) => a.collection === 'kin_care_sessions');
    expect(add).toBeDefined();
    expect(add?.data.status).toBe('SCHEDULED');
    expect(add?.data.kinfolkId).toBe('kf1');
    expect(add?.data.kinIds).toEqual(['k1']);
    expect(res.sessionId).toBe(add?.id);
  });

  it('HAPPY: writes a CREATE_KINCARE_SESSION audit entry', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createKinCareSessionHandler(req({
      kinfolkId: 'kf1', kinIds: [], serviceType: 'Visit',
      startTime: '2026-06-10T13:00:00Z', endTime: '2026-06-10T14:00:00Z',
    }));
    const call = (writeAuditEntry as any).mock.calls.map((c: any[]) => c[0])
      .find((c: any) => c.event === 'CREATE_KINCARE_SESSION');
    expect(call).toBeDefined();
  });

  it('SAD: unauthenticated rejected', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(createKinCareSessionHandler(req({
      kinfolkId: 'kf1', kinIds: [], serviceType: 'V', startTime: 'a', endTime: 'b',
    }, null))).rejects.toThrow();
  });

  it('SAD: blank kinfolkId rejected', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(createKinCareSessionHandler(req({
      kinfolkId: '', kinIds: [], serviceType: 'V', startTime: 'a', endTime: 'b',
    }))).rejects.toThrow();
  });
});

describe('rescheduleBooking', () => {
  it('HAPPY: patches startTime/endTime of an existing session', async () => {
    const ctx = buildDbMock({ docs: { 'kin_care_sessions/s1': { status: 'SCHEDULED', startTime: 'old' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await rescheduleBookingHandler(req({
      sessionId: 's1', startTime: '2026-06-11T09:00:00Z', endTime: '2026-06-11T10:00:00Z',
    }));
    expect(res.ok).toBe(true);
    const write = ctx.writes.find((w) => w.path === 'kin_care_sessions/s1');
    expect(write?.data.startTime).toBe('2026-06-11T09:00:00Z');
    expect(write?.data.endTime).toBe('2026-06-11T10:00:00Z');
  });

  it('SAD: missing session rejected (not-found)', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(rescheduleBookingHandler(req({
      sessionId: 'nope', startTime: 'a', endTime: 'b',
    }))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('HAPPY: writes a RESCHEDULE_BOOKING audit entry', async () => {
    const ctx = buildDbMock({ docs: { 'kin_care_sessions/s1': { status: 'SCHEDULED' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await rescheduleBookingHandler(req({ sessionId: 's1', startTime: 'x', endTime: 'y' }));
    const call = (writeAuditEntry as any).mock.calls.map((c: any[]) => c[0])
      .find((c: any) => c.event === 'RESCHEDULE_BOOKING');
    expect(call).toBeDefined();
  });
});
