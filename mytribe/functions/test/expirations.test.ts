import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__TS__' } }));

import {
  UpsertExpirationArgs,
  listExpirationsHandler,
  upsertExpirationHandler,
} from '../src/admin/expirations';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

function req(data: unknown, uid: string | null = 'auntie-1'): CallableRequest<unknown> {
  return { data, auth: uid ? ({ uid, token: { admin: true } } as any) : undefined } as unknown as CallableRequest<unknown>;
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

describe('UpsertExpirationArgs validation', () => {
  it('accepts a valid gate code expiration', () => {
    expect(UpsertExpirationArgs.safeParse({ label: 'Front gate', dateIso: '2026-09-01', kind: 'gateCode' }).success).toBe(true);
  });
  it('rejects a non-ISO date', () => {
    expect(UpsertExpirationArgs.safeParse({ label: 'x', dateIso: '09/01/2026', kind: 'card' }).success).toBe(false);
  });
  it('rejects a bad kind', () => {
    expect(UpsertExpirationArgs.safeParse({ label: 'x', dateIso: '2026-09-01', kind: 'passport' }).success).toBe(false);
  });
});

describe('listExpirationsHandler', () => {
  it('returns expirations sorted by dateIso ascending', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        expirations: [
          { id: 'c', data: { label: 'Late', dateIso: '2026-12-01', kind: 'license' } },
          { id: 'a', data: { label: 'Early', dateIso: '2026-08-01', kind: 'gateCode', kinfolkId: 'kf1' } },
          { id: 'b', data: { label: 'Mid', dateIso: '2026-10-01', kind: 'card' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await listExpirationsHandler(req({}));
    expect(res.expirations.map((e) => e._id)).toEqual(['a', 'b', 'c']);
    expect(res.expirations[0]).toMatchObject({ label: 'Early', dateIso: '2026-08-01', kind: 'gateCode', kinfolkId: 'kf1' });
  });

  it('rejects unauthenticated', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(listExpirationsHandler(req({}, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

describe('upsertExpirationHandler', () => {
  it('creates a new expiration when no expirationId given', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await upsertExpirationHandler(req({ label: 'Rabies cert', dateIso: '2027-01-15', kind: 'vetRecord', kinfolkId: 'kf9' }));
    expect(res.id).toBeTruthy();
    const w = ctx.writes.find((x) => x.path.startsWith('expirations/'));
    expect(w?.data.label).toBe('Rabies cert');
    expect(w?.data.kinfolkId).toBe('kf9');
    expect(w?.data.createdAt).toBe('__TS__');
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ event: 'EXPIRATION_UPSERTED' }));
  });

  it('updates in place (no createdAt) when expirationId given', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await upsertExpirationHandler(req({ expirationId: 'e3', label: 'Card', dateIso: '2026-11-01', kind: 'card' }));
    expect(res.id).toBe('e3');
    const w = ctx.writes.find((x) => x.path === 'expirations/e3');
    expect(w?.data.createdAt).toBeUndefined();
    expect(w?.data.kinfolkId).toBe(''); // optional omitted -> empty string
  });

  it('rejects a malformed date with invalid-argument', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(upsertExpirationHandler(req({ label: 'x', dateIso: 'nope', kind: 'other' }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});
