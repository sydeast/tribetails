import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  writeAuditEntry: vi.fn().mockResolvedValue('audit-1'),
  logEvent: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
// #557: this suite drives handlers through the wrapper, which now checks session
// revocation. Stub it out — see test/_helpers/mockSessionRevocation.ts.
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntry }));

import { listAllInvitesHandler, householdNameFor } from '../src/admin/listAllInvites';
import { wrapAdminCallable } from '../src/lib/wrapAdminCallable';

/** A Firestore-Timestamp-shaped value: what the real SDK hands the handler. */
function ts(iso: string) {
  return { toDate: () => new Date(iso) };
}

function invite(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    data: {
      tribeId: 'f1',
      invitedEmail: 'jane@example.com',
      secondaryLabel: null,
      proposedRole: 'PRIMARY',
      status: 'PENDING',
      createdAt: ts('2026-08-01T00:00:00.000Z'),
      expiresAt: ts('2099-01-01T00:00:00.000Z'),
      ...over,
    },
  };
}

const admin = { uid: 'admin1', token: { admin: true } };

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntry.mockReset().mockResolvedValue('audit-1');
  mocks.logEvent.mockReset();
});

describe('listAllInvites HAPPY', () => {
  it('returns every household invite with its household name attached', async () => {
    const ctx = buildDbMock({
      docs: {
        'kinfolk/f1': { firstName: 'Dora', lastName: 'Demo' },
        'kinfolk/f2': { firstName: 'Ed', lastName: 'Ellery' },
      },
      queryDocs: {
        inviteRequests: [
          invite('i1', { tribeId: 'f1', status: 'PENDING', createdAt: ts('2026-08-01T00:00:00.000Z') }),
          invite('i2', { tribeId: 'f2', status: 'ACCEPTED', createdAt: ts('2026-07-20T00:00:00.000Z') }),
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listAllInvitesHandler(callableRequest({}, admin));

    expect(res.invites).toEqual([
      expect.objectContaining({
        inviteId: 'i1',
        tribeId: 'f1',
        householdName: 'the Demos',
        status: 'PENDING',
      }),
      expect.objectContaining({
        inviteId: 'i2',
        tribeId: 'f2',
        householdName: 'the Ellerys',
        status: 'ACCEPTED',
      }),
    ]);
    expect(res.scanned).toBe(2);
    expect(res.households).toBe(2);
  });

  it('reconciles expiry the same way listInvites does, rather than restating it', async () => {
    const ctx = buildDbMock({
      docs: { 'kinfolk/f1': { lastName: 'Demo' } },
      queryDocs: {
        inviteRequests: [
          invite('lapsed', { status: 'EMAIL_SENT', expiresAt: ts('2020-01-01T00:00:00.000Z') }),
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const row = (await listAllInvitesHandler(callableRequest({}, admin))).invites[0]!;
    expect(row.status).toBe('EMAIL_SENT');
    expect(row.effectiveStatus).toBe('EXPIRED');
    expect(row.redeemable).toBe(false);
  });

  it('reads each household once even when it has several invites', async () => {
    const ctx = buildDbMock({
      docs: { 'kinfolk/f1': { lastName: 'Demo' } },
      queryDocs: {
        inviteRequests: [invite('i1'), invite('i2'), invite('i3')],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listAllInvitesHandler(callableRequest({}, admin));

    expect(res.invites).toHaveLength(3);
    expect(res.households).toBe(1);
    expect(ctx.db.getAll).toHaveBeenCalledTimes(1);
    expect(ctx.db.getAll.mock.calls[0]).toHaveLength(1);
  });

  it('is read only: no writes, adds or deletes', async () => {
    const ctx = buildDbMock({
      docs: { 'kinfolk/f1': { lastName: 'Demo' } },
      queryDocs: { inviteRequests: [invite('i1')] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await listAllInvitesHandler(callableRequest({}, admin));

    expect(ctx.writes).toHaveLength(0);
    expect(ctx.adds).toHaveLength(0);
    expect(ctx.deletes).toHaveLength(0);
  });

  it('audits the cross-tenant read and logs counts without any invite id', async () => {
    const ctx = buildDbMock({
      docs: { 'kinfolk/f1': { lastName: 'Demo' } },
      queryDocs: { inviteRequests: [invite('rq_secret')] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await listAllInvitesHandler(callableRequest({}, admin));

    expect(mocks.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'SUCCESS',
        event: 'OPERATOR_CROSSTENANT_ACCESS',
        actorRole: 'AUNTIE',
        actorUid: 'admin1',
      }),
    );
    const booked = JSON.stringify(mocks.writeAuditEntry.mock.calls);
    const logged = JSON.stringify(mocks.logEvent.mock.calls);
    expect(logged).toContain('membership.invites.listedAll');
    // The invite id IS the claim-link bearer token. It reaches neither sink.
    expect(logged).not.toContain('rq_secret');
    expect(booked).not.toContain('rq_secret');
  });

  it('still returns the read when the audit write fails, and says so in the log', async () => {
    const ctx = buildDbMock({
      docs: { 'kinfolk/f1': { lastName: 'Demo' } },
      queryDocs: { inviteRequests: [invite('i1')] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.writeAuditEntry.mockRejectedValue(new Error('audit chain head locked'));

    const res = await listAllInvitesHandler(callableRequest({}, admin));

    expect(res.invites).toHaveLength(1);
    expect(JSON.stringify(mocks.logEvent.mock.calls)).toContain('audit.write.failed');
  });

  it('returns an empty list, and reads no household, when nobody has ever been invited', async () => {
    const ctx = buildDbMock({ docs: {}, queryDocs: { inviteRequests: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listAllInvitesHandler(callableRequest({}, admin));

    expect(res).toMatchObject({ invites: [], scanned: 0, households: 0 });
    expect(ctx.db.getAll).not.toHaveBeenCalled();
  });
});

describe('listAllInvites household naming', () => {
  it('names a household whose kinfolk doc is missing rather than dropping the invite', async () => {
    const ctx = buildDbMock({
      docs: { 'kinfolk/gone': null },
      queryDocs: { inviteRequests: [invite('i9', { tribeId: 'gone' })] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listAllInvitesHandler(callableRequest({}, admin));

    expect(res.invites[0]).toMatchObject({
      tribeId: 'gone',
      householdName: '(household not found: gone)',
    });
  });

  it('keeps an invite carrying no tribeId at all, and says that is what is wrong', async () => {
    const ctx = buildDbMock({
      docs: {},
      queryDocs: { inviteRequests: [invite('i8', { tribeId: 123 })] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listAllInvitesHandler(callableRequest({}, admin));

    expect(res.invites[0]).toMatchObject({
      inviteId: 'i8',
      tribeId: '',
      householdName: '(invite carries no household id)',
    });
  });

  it('pluralizes a sibilant surname the way householdLabel does', () => {
    expect(householdNameFor('f1', { lastName: 'Brooks' })).toBe('the Brookses');
    expect(householdNameFor('f1', { lastName: 'Wren' })).toBe('the Wrens');
    expect(householdNameFor('f1', { lastName: 'Marsh' })).toBe('the Marshes');
  });

  it('falls back to the full name, then to a loud marker, never to a blank card', () => {
    expect(householdNameFor('f1', { firstName: 'Loretta' })).toBe('Loretta');
    expect(householdNameFor('f1', {})).toBe('(unnamed household: f1)');
    expect(householdNameFor('f1', undefined)).toBe('(household not found: f1)');
  });
});

describe('listAllInvites NEGATIVE + UNAUTHORIZED', () => {
  it('refuses a signed-in caller with no admin claim', async () => {
    const ctx = buildDbMock({
      docs: { 'kinfolk/f1': { lastName: 'Demo' } },
      queryDocs: { inviteRequests: [invite('i1')] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const guarded = wrapAdminCallable('listAllInvites', listAllInvitesHandler);
    await expect(guarded(callableRequest({}, { uid: 'kinfolk-9', token: {} }))).rejects.toMatchObject(
      { code: 'permission-denied' },
    );
    expect(mocks.writeAuditEntry).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'OPERATOR_CROSSTENANT_ACCESS' }),
    );
  });

  it('is unauthenticated with no caller at all', async () => {
    const ctx = buildDbMock({ docs: {}, queryDocs: { inviteRequests: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(listAllInvitesHandler(callableRequest({}))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('is invalid-argument for an out-of-range limit', async () => {
    const ctx = buildDbMock({ docs: {}, queryDocs: { inviteRequests: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      listAllInvitesHandler(callableRequest({ limit: 5000 }, admin)),
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      details: { validationErrors: [expect.objectContaining({ path: 'limit' })] },
    });
  });

  it('propagates a Firestore read failure fail-loud rather than returning an empty list', async () => {
    mocks.dbFn.mockReturnValue({
      collection: () => ({
        limit: () => ({
          get: async () => {
            throw new Error('backend unavailable');
          },
        }),
      }),
    });

    await expect(listAllInvitesHandler(callableRequest({}, admin))).rejects.toThrow(
      'backend unavailable',
    );
  });
});
