import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  writeAuditEntry: vi.fn().mockResolvedValue('audit-1'),
  logEvent: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntry }));

import {
  listInvitesHandler,
  effectiveInviteStatus,
  mapInviteDoc,
  sortInvitesNewestFirst,
} from '../src/admin/listInvites';
import { wrapAdminCallable } from '../src/lib/wrapAdminCallable';

/** A Firestore-Timestamp-shaped value: what the real SDK hands the handler. */
function ts(iso: string) {
  return { toDate: () => new Date(iso) };
}

const NOW = Date.parse('2026-06-01T12:00:00.000Z');

function invite(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    data: {
      tribeId: 'fam1',
      invitedEmail: 'jane@example.com',
      secondaryLabel: 'Sister',
      proposedRole: 'SECONDARY',
      proposedPermissions: {
        billing_full: false,
        messaging_direct: true,
        messaging_group: true,
        kin_edit: false,
        kintales_only: true,
        home_access: false,
      },
      // A stored `requiresAuntieAck` (older docs still carry one) must not
      // reappear in the DTO: the field was removed, not renamed.
      requiresAuntieAck: true,
      status: 'EMAIL_SENT',
      createdAt: ts('2026-05-20T00:00:00.000Z'),
      sentToInviteeAt: ts('2026-05-20T00:01:00.000Z'),
      expiresAt: ts('2026-06-03T00:00:00.000Z'),
      ...over,
    },
  };
}

function seed(rows: Array<{ id: string; data: Record<string, unknown> }>) {
  return buildDbMock({
    docs: { 'kinfolk/fam1': { firstName: 'Loretta', lastName: 'Wall' } },
    queryDocs: { inviteRequests: rows },
  });
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntry.mockReset().mockResolvedValue('audit-1');
  mocks.logEvent.mockReset();
  vi.useRealTimers();
});

describe('listInvites HAPPY', () => {
  it('returns one household\'s invites with ISO timestamps and a complete permission shape', async () => {
    const ctx = seed([invite('rq_1')]);
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listInvitesHandler(
      callableRequest({ familyId: 'fam1' }, { uid: 'admin1', token: { admin: true } }),
    );

    expect(res.scanned).toBe(1);
    expect(res.invites).toHaveLength(1);
    const row = res.invites[0]!;
    expect(row.inviteId).toBe('rq_1');
    expect(row.tribeId).toBe('fam1');
    expect(row.invitedEmail).toBe('jane@example.com');
    expect(row.secondaryLabel).toBe('Sister');
    expect(row.proposedRole).toBe('SECONDARY');
    expect(row.createdAt).toBe('2026-05-20T00:00:00.000Z');
    expect(row.sentToInviteeAt).toBe('2026-05-20T00:01:00.000Z');
    expect(row.expiresAt).toBe('2026-06-03T00:00:00.000Z');
    expect(row.proposedPermissions).toEqual({
      billing_full: false,
      messaging_direct: true,
      messaging_group: true,
      kin_edit: false,
      kintales_only: true,
      home_access: false,
    });
  });

  it('is read only: no writes, adds or deletes against inviteRequests', async () => {
    const ctx = seed([invite('rq_1')]);
    mocks.dbFn.mockReturnValue(ctx.db);

    await listInvitesHandler(
      callableRequest({ familyId: 'fam1' }, { uid: 'admin1', token: { admin: true } }),
    );

    expect(ctx.writes).toHaveLength(0);
    expect(ctx.adds).toHaveLength(0);
    expect(ctx.deletes).toHaveLength(0);
  });

  it('scopes the query to the requested household, so another tribe\'s invites never leak', async () => {
    const ctx = seed([invite('rq_mine'), invite('rq_theirs', { tribeId: 'fam2' })]);
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listInvitesHandler(
      callableRequest({ familyId: 'fam1' }, { uid: 'admin1', token: { admin: true } }),
    );

    expect(res.invites.map((i) => i.inviteId)).toEqual(['rq_mine']);
  });

  it('audits the operator cross-tenant read and logs a count without the invite ids', async () => {
    const ctx = seed([invite('rq_1')]);
    mocks.dbFn.mockReturnValue(ctx.db);

    await listInvitesHandler(
      callableRequest({ familyId: 'fam1' }, { uid: 'admin1', token: { admin: true } }),
    );

    expect(mocks.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'SUCCESS',
        event: 'OPERATOR_CROSSTENANT_ACCESS',
        actorRole: 'AUNTIE',
        actorUid: 'admin1',
        familyId: 'fam1',
      }),
    );
    const logged = JSON.stringify(mocks.logEvent.mock.calls);
    expect(logged).toContain('membership.invites.listed');
    // The invite id IS the claim-link bearer token. It must not reach the logs.
    expect(logged).not.toContain('rq_1');
  });

  it('returns an empty list rather than an error when the household has never been invited', async () => {
    const ctx = seed([]);
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listInvitesHandler(
      callableRequest({ familyId: 'fam1' }, { uid: 'admin1', token: { admin: true } }),
    );

    expect(res.invites).toEqual([]);
    expect(res.scanned).toBe(0);
  });

  it('still returns the read when the audit write fails, and says so in the log', async () => {
    const ctx = seed([invite('rq_1')]);
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.writeAuditEntry.mockRejectedValue(new Error('audit chain head locked'));

    const res = await listInvitesHandler(
      callableRequest({ familyId: 'fam1' }, { uid: 'admin1', token: { admin: true } }),
    );

    expect(res.invites).toHaveLength(1);
    expect(JSON.stringify(mocks.logEvent.mock.calls)).toContain('audit.write.failed');
  });
});

describe('listInvites expiry reconciliation (the case that matters most)', () => {
  it('reports a lapsed EMAIL_SENT invite as EXPIRED and not redeemable before the nightly sweep runs', async () => {
    // expiresAt is in the past but expireStaleInvites (02:00 daily) has not yet
    // flipped the document, so Firestore still says EMAIL_SENT.
    const ctx = seed([invite('rq_lapsed', { expiresAt: ts('2026-05-25T00:00:00.000Z') })]);
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listInvitesHandler(
      callableRequest({ familyId: 'fam1' }, { uid: 'admin1', token: { admin: true } }),
    );

    const row = res.invites[0]!;
    expect(row.status).toBe('EMAIL_SENT');
    expect(row.effectiveStatus).toBe('EXPIRED');
    expect(row.redeemable).toBe(false);
  });

  it('reports a REVOKED invite as not redeemable, matching acceptInvite\'s refusal', async () => {
    const ctx = seed([
      invite('rq_revoked', { status: 'REVOKED', revokedAt: ts('2026-05-22T00:00:00.000Z') }),
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listInvitesHandler(
      callableRequest({ familyId: 'fam1' }, { uid: 'admin1', token: { admin: true } }),
    );

    const row = res.invites[0]!;
    expect(row.effectiveStatus).toBe('REVOKED');
    expect(row.redeemable).toBe(false);
    expect(row.revokedAt).toBe('2026-05-22T00:00:00.000Z');
  });

  it('reports a live invite inside its TTL as redeemable', async () => {
    const ctx = seed([invite('rq_live', { expiresAt: ts('2099-01-01T00:00:00.000Z') })]);
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listInvitesHandler(
      callableRequest({ familyId: 'fam1' }, { uid: 'admin1', token: { admin: true } }),
    );

    expect(res.invites[0]!.redeemable).toBe(true);
  });

  it('never re-derives a terminal status, and leaves an unreadable expiry alone', () => {
    expect(effectiveInviteStatus('ACCEPTED', NOW - 1, NOW)).toBe('ACCEPTED');
    expect(effectiveInviteStatus('REVOKED', NOW - 1, NOW)).toBe('REVOKED');
    expect(effectiveInviteStatus('EXPIRED', NOW + 1, NOW)).toBe('EXPIRED');
    expect(effectiveInviteStatus('EMAIL_SENT', null, NOW)).toBe('EMAIL_SENT');
    expect(effectiveInviteStatus('PENDING', NOW - 1, NOW)).toBe('EXPIRED');
  });
});

describe('listInvites malformed documents', () => {
  it('defaults every absent permission flag to false rather than dropping the row', () => {
    const row = mapInviteDoc('rq_x', { tribeId: 'fam1', status: 'PENDING' }, NOW);
    expect(row.proposedPermissions).toEqual({
      billing_full: false,
      messaging_direct: false,
      messaging_group: false,
      kin_edit: false,
      kintales_only: false,
      home_access: false,
    });
    expect(row.invitedEmail).toBe('');
    expect(row.secondaryLabel).toBeNull();
    expect(row.acceptedUid).toBeNull();
    expect(row.createdAt).toBeNull();
  });

  it('reads an unrecognised status as PENDING so the row stays visible and revocable', () => {
    const row = mapInviteDoc('rq_x', { status: 'WAT', expiresAt: ts('2099-01-01T00:00:00.000Z') }, NOW);
    expect(row.status).toBe('PENDING');
    expect(row.redeemable).toBe(true);
  });

  it('sorts newest first and pushes rows with no readable createdAt to the end', () => {
    const rows = [
      mapInviteDoc('old', { createdAt: ts('2026-01-01T00:00:00.000Z') }, NOW),
      mapInviteDoc('none', {}, NOW),
      mapInviteDoc('new', { createdAt: ts('2026-05-01T00:00:00.000Z') }, NOW),
    ];
    expect(sortInvitesNewestFirst(rows).map((r) => r.inviteId)).toEqual(['new', 'old', 'none']);
  });
});

describe('listInvites NEGATIVE + UNAUTHORIZED', () => {
  it('is unauthenticated with no caller at all', async () => {
    const ctx = seed([]);
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(listInvitesHandler(callableRequest({ familyId: 'fam1' }))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('is permission-denied for a signed-in caller with no admin claim', async () => {
    const ctx = seed([invite('rq_1')]);
    mocks.dbFn.mockReturnValue(ctx.db);

    const guarded = wrapAdminCallable('listInvites', listInvitesHandler);
    await expect(
      guarded(callableRequest({ familyId: 'fam1' }, { uid: 'kinfolk-9', token: {} })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    // The handler never ran, so no cross-tenant READ was recorded. wrapCallable
    // still books the refusal itself as ERROR_FUNCTION_FAILURE, which is the
    // point: a denied read is auditable without being a successful one.
    expect(mocks.writeAuditEntry).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'OPERATOR_CROSSTENANT_ACCESS' }),
    );
    expect(mocks.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILURE', payload: expect.objectContaining({ code: 'permission-denied' }) }),
    );
  });

  it('is invalid-argument for a missing familyId, with the field named', async () => {
    const ctx = seed([]);
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      listInvitesHandler(callableRequest({}, { uid: 'admin1', token: { admin: true } })),
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      details: { validationErrors: [expect.objectContaining({ path: 'familyId' })] },
    });
  });

  it('is invalid-argument for an out-of-range limit', async () => {
    const ctx = seed([]);
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      listInvitesHandler(
        callableRequest({ familyId: 'fam1', limit: 5000 }, { uid: 'admin1', token: { admin: true } }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('is not-found for a household that does not exist, instead of a plausible empty list', async () => {
    const ctx = buildDbMock({ docs: { 'kinfolk/fam1': null }, queryDocs: { inviteRequests: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      listInvitesHandler(
        callableRequest({ familyId: 'fam1' }, { uid: 'admin1', token: { admin: true } }),
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('propagates a Firestore read failure fail-loud rather than returning an empty roster', async () => {
    mocks.dbFn.mockReturnValue({
      collection: () => ({
        doc: () => ({ get: async () => ({ exists: true, data: () => ({}) }) }),
        where: () => ({ limit: () => ({ get: async () => { throw new Error('backend unavailable'); } }) }),
      }),
    });

    await expect(
      listInvitesHandler(
        callableRequest({ familyId: 'fam1' }, { uid: 'admin1', token: { admin: true } }),
      ),
    ).rejects.toThrow('backend unavailable');
  });

  it('drops a legacy requiresAuntieAck rather than surfacing it', async () => {
    // RULING: a household PRIMARY may grant a SECONDARY any permission except
    // admin, billing included. Nothing ever performed or checked the "Auntie
    // acknowledgement" this flag claimed to require, so it is gone from the
    // schema and from both clients. Documents written before that still carry
    // the field; the projection must not resurrect it.
    const row = mapInviteDoc(
      'rq_legacy',
      { tribeId: 'fam1', status: 'PENDING', requiresAuntieAck: true },
      Date.now(),
    );
    expect(row).not.toHaveProperty('requiresAuntieAck');
    expect(row.inviteId).toBe('rq_legacy');
  });
});
