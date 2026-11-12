import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';
const mocks = vi.hoisted(() => ({
  writeAuditEntryMock: vi.fn(),
  dbFn: vi.fn(),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({
  writeAuditEntry: mocks.writeAuditEntryMock,
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));

import { logActivityHandler } from '../src/admin/logActivity';
import { wrapAdminCallable } from '../src/lib/wrapAdminCallable';
import { ACTIVITY_PAYLOAD_MAX_CHARS } from '../src/lib/activityPayload';
const writeAuditEntryMock = mocks.writeAuditEntryMock;

const OWNER = { admin: true };
const AUNTIE = { staffRole: 'auntie' };
const HOUSEHOLD = {};

function req(
  data: unknown,
  uid: string | null = 'admin-1',
  token: Record<string, unknown> = OWNER,
): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token } as never) : undefined,
    rawRequest: {} as never,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function written(): Record<string, any> {
  return writeAuditEntryMock.mock.calls[0][0];
}

beforeEach(() => {
  process.env.AUNTIE_OPERATOR_UIDS = '';
  writeAuditEntryMock.mockClear();
  writeAuditEntryMock.mockResolvedValue('audit-entry-1');
  mocks.dbFn.mockReset();
  mocks.dbFn.mockReturnValue(buildDbMock({ docs: {} }).db);
});

describe('logActivityHandler', () => {
  it('forwards canonical fields to writeAuditEntry and returns entry id', async () => {
    const result = await logActivityHandler(
      req({
        actionType: 'KINFOLK_UPDATED',
        description: 'updated profile',
        status: 'SUCCESS',
        actorId: 'admin-1',
        targetId: 'kf-42',
        targetCollection: 'kinfolk',
      }),
    );
    expect(result).toEqual({ ok: true, entryId: 'audit-entry-1' });
    expect(writeAuditEntryMock).toHaveBeenCalledOnce();
    const args = writeAuditEntryMock.mock.calls[0][0];
    expect(args.event).toBe('KINFOLK_UPDATED');
    expect(args.severity).toBe('info');
    // #1820: the caller holds the owner claim, so the line is a staff line.
    expect(args.actorRole).toBe('AUNTIE');
    expect(args.actorUid).toBe('admin-1');
    expect(args.targetUid).toBe('kf-42');
    expect(args.targetCollection).toBe('kinfolk');
    expect(args.description).toBe('updated profile');
    expect(args.status).toBe('SUCCESS');
  });

  it('#1747: seals the household onto the entry, so its id never rides in the description', async () => {
    await logActivityHandler(
      req({
        actionType: 'DRAFT_APPROVED',
        description: 'Approved an Auntie AI draft',
        targetId: 'd1',
        targetCollection: 'generated_drafts',
        familyId: 'kf-42',
      }),
    );
    expect(writeAuditEntryMock.mock.calls[0][0].familyId).toBe('kf-42');
  });

  it('#1747: sends no household when the caller names none', async () => {
    await logActivityHandler(req({ actionType: 'DRAFT_APPROVED', familyId: '' }));
    expect(writeAuditEntryMock.mock.calls[0][0].familyId).toBeUndefined();
  });

  it('rejects non-SCREAMING_SNAKE actionType', async () => {
    await expect(
      logActivityHandler(req({ actionType: 'kinfolk.updated' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(writeAuditEntryMock).not.toHaveBeenCalled();
  });

  it('rejects empty actionType', async () => {
    await expect(logActivityHandler(req({ actionType: '' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('rejects invalid status value', async () => {
    await expect(
      logActivityHandler(req({ actionType: 'TEST_EVENT', status: 'BANANA' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('uses caller uid as actor when description omitted (default description = actionType)', async () => {
    await logActivityHandler(req({ actionType: 'AUTH_LOGIN_SUCCESS' }));
    const args = writeAuditEntryMock.mock.calls[0][0];
    expect(args.actorUid).toBe('admin-1');
    expect(args.description).toBe('AUTH_LOGIN_SUCCESS');
  });

  it('captures supplied actorId in description when it diverges from caller uid', async () => {
    await logActivityHandler(
      req({ actionType: 'ADMIN_IMPERSONATION', actorId: 'other-user-xyz' }),
    );
    const args = writeAuditEntryMock.mock.calls[0][0];
    // True actor is still the caller (admin-1); divergent client claim is
    // appended to description for forensic correlation.
    expect(args.actorUid).toBe('admin-1');
    expect(args.description).toContain('client-actor=other-user-xyz');
  });

  it('maps status=FAILURE to severity=warn', async () => {
    await logActivityHandler(
      req({ actionType: 'SOMETHING_FAILED', status: 'FAILURE' }),
    );
    const args = writeAuditEntryMock.mock.calls[0][0];
    expect(args.severity).toBe('warn');
  });

  it('omits targetUid when targetId blank', async () => {
    await logActivityHandler(req({ actionType: 'TEST_EVENT', targetId: '' }));
    const args = writeAuditEntryMock.mock.calls[0][0];
    expect(args.targetUid).toBeUndefined();
  });
});

/**
 * #1820. Every client-origin line was written `actorRole: 'PRIMARY'`, so the
 * owner's own clock taps opened to ACTOR ROLE "Primary kinfolk".
 */
describe('#1820 logActivity records who the caller really is', () => {
  it('the owner: staff band, stamped as the owner', async () => {
    await logActivityHandler(req({ actionType: 'VISIT_ARRIVED' }, 'owner-1', OWNER));
    expect(written().actorRole).toBe('AUNTIE');
    expect(written().actorUid).toBe('owner-1');
    expect(written().payload).toEqual({ admin: true, staffRole: null });
  });

  it('the owner by the allowlist fallback, with no claim minted yet', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'boot-1';
    await logActivityHandler(req({ actionType: 'VISIT_ARRIVED' }, 'boot-1', HOUSEHOLD));
    expect(written().actorRole).toBe('AUNTIE');
    expect(written().payload).toEqual({ admin: true, staffRole: null });
  });

  it('an Auntie: staff band, stamped as the Auntie, never as the owner', async () => {
    await logActivityHandler(req({ actionType: 'VISIT_ARRIVED' }, 'auntie-1', AUNTIE));
    expect(written().actorRole).toBe('AUNTIE');
    expect(written().payload).toEqual({ admin: false, staffRole: 'auntie' });
  });

  it('an account carrying both claims is the Auntie, as every other gate treats it', async () => {
    await logActivityHandler(
      req({ actionType: 'VISIT_ARRIVED' }, 'both-1', { admin: true, staffRole: 'auntie' }),
    );
    expect(written().payload).toEqual({ admin: false, staffRole: 'auntie' });
  });

  it('a primary Kinfolk is PRIMARY and carries no staff stamp', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        docs: {
          'clients/kf-uid': { kinfolkIds: ['fam1'] },
          'families/fam1/members/kf-uid': { role: 'PRIMARY', status: 'ACTIVE' },
        },
      }).db,
    );
    await logActivityHandler(req({ actionType: 'TEST_EVENT' }, 'kf-uid', HOUSEHOLD));
    expect(written().actorRole).toBe('PRIMARY');
    expect(written().payload).toEqual({});
  });

  it('a household account with no member record is the legacy primary', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: { 'clients/kf-uid': { kinfolkIds: ['fam1'] } } }).db);
    await logActivityHandler(req({ actionType: 'TEST_EVENT' }, 'kf-uid', HOUSEHOLD));
    expect(written().actorRole).toBe('PRIMARY');
  });

  it('a secondary Kinfolk is SECONDARY', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        docs: {
          'clients/sk-uid': { kinfolkIds: ['fam1'] },
          'families/fam1/members/sk-uid': { role: 'SECONDARY', status: 'ACTIVE' },
        },
      }).db,
    );
    await logActivityHandler(req({ actionType: 'TEST_EVENT' }, 'sk-uid', HOUSEHOLD));
    expect(written().actorRole).toBe('SECONDARY');
    expect(written().payload).toEqual({});
  });

  it('a household read that fails still writes the line, as PRIMARY', async () => {
    mocks.dbFn.mockImplementation(() => {
      throw new Error('firestore down');
    });
    await logActivityHandler(req({ actionType: 'TEST_EVENT' }, 'kf-uid', HOUSEHOLD));
    expect(written().actorRole).toBe('PRIMARY');
  });

  it('ignores a role the client sends, in any spelling', async () => {
    await logActivityHandler(
      req(
        {
          actionType: 'VISIT_ARRIVED',
          actorRole: 'SYSTEM',
          role: 'PRIMARY',
          staffRole: 'auntie',
          admin: false,
          severity: 'critical',
        },
        'owner-1',
        OWNER,
      ),
    );
    expect(written().actorRole).toBe('AUNTIE');
    expect(written().severity).toBe('info');
    expect(written().payload).toEqual({ admin: true, staffRole: null });
  });

  it('a Kinfolk who claims to be staff in the request is still a Kinfolk', async () => {
    await logActivityHandler(
      req({ actionType: 'TEST_EVENT', actorRole: 'AUNTIE', admin: true }, 'kf-uid', HOUSEHOLD),
    );
    expect(written().actorRole).toBe('PRIMARY');
    expect(written().payload).toEqual({});
  });
});

describe('#1820 logActivity is still a staff callable', () => {
  const wrapped = wrapAdminCallable('logActivity', logActivityHandler);
  it('refuses a caller who is not signed in, at the gate and in the handler', async () => {
    await expect(wrapped(req({ actionType: 'TEST_EVENT' }, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    await expect(logActivityHandler(req({ actionType: 'TEST_EVENT' }, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    const events = writeAuditEntryMock.mock.calls.map((c) => c[0].event);
    expect(events).not.toContain('TEST_EVENT');
  });

  it('refuses a Kinfolk', async () => {
    await expect(wrapped(req({ actionType: 'TEST_EVENT' }, 'kf-uid', HOUSEHOLD))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    // The gate records its own refusal; the line she asked for is never written.
    const events = writeAuditEntryMock.mock.calls.map((c) => c[0].event);
    expect(events).not.toContain('TEST_EVENT');
  });

  it('admits the owner and an Auntie', async () => {
    await expect(wrapped(req({ actionType: 'VISIT_ARRIVED' }, 'owner-1', OWNER))).resolves.toMatchObject({ ok: true });
    await expect(wrapped(req({ actionType: 'VISIT_ARRIVED' }, 'auntie-1', AUNTIE))).resolves.toMatchObject({ ok: true });
    expect(writeAuditEntryMock).toHaveBeenCalledTimes(2);
  });
});

describe('#1820 logActivity takes a bounded payload', () => {
  it('stores the listed facts beside the server stamp', async () => {
    await logActivityHandler(
      req({
        actionType: 'VISIT_ARRIVED',
        targetId: 's1',
        payload: { visitId: 's1', from: 'ON_MY_WAY', to: 'ARRIVED', source: 'web' },
      }),
    );
    expect(written().payload).toEqual({
      visitId: 's1',
      from: 'ON_MY_WAY',
      to: 'ARRIVED',
      source: 'web',
      admin: true,
      staffRole: null,
    });
  });

  it('takes names, field names, a count and a switch', async () => {
    await logActivityHandler(
      req({
        actionType: 'UPDATE_KIN',
        payload: { kinName: 'Biscuit', changedFields: ['Breed', 'Weight'], count: 2, archived: false },
      }),
    );
    expect(written().payload).toMatchObject({
      kinName: 'Biscuit',
      changedFields: ['Breed', 'Weight'],
      count: 2,
      archived: false,
    });
  });

  it('drops empty values instead of storing them', async () => {
    await logActivityHandler(
      req({ actionType: 'UPDATE_KIN', payload: { kinName: '', kinId: null, tags: [], from: 'A' } }),
    );
    expect(written().payload).toEqual({ from: 'A', admin: true, staffRole: null });
  });

  it('writes no client facts when none are sent', async () => {
    await logActivityHandler(req({ actionType: 'VISIT_ARRIVED' }));
    expect(written().payload).toEqual({ admin: true, staffRole: null });
  });

  const refused: Array<[string, unknown]> = [
    ['a key that is not on the list', { cardNumber: '4242424242424242' }],
    ['a password', { password: 'hunter2' }],
    ['an amount of money', { amountCents: 5000 }],
    ['the server stamp: admin', { admin: true }],
    ['the server stamp: staffRole', { staffRole: 'auntie' }],
    ['a role', { actorRole: 'SYSTEM' }],
    ['a nested object', { from: { status: 'ARRIVED' } }],
    ['a nested array', { changedFields: [['a']] }],
    ['a number where a word belongs', { from: 7 }],
    ['a value longer than its limit', { from: 'x'.repeat(81) }],
    ['a list longer than its limit', { tags: Array.from({ length: 51 }, (_v, i) => `t${i}`) }],
    ['a count that is not a whole number', { count: 1.5 }],
    ['a count that is not finite', { count: Number.POSITIVE_INFINITY }],
    ['a source that is not one of the three clients', { source: 'curl' }],
    ['a payload that is not an object', 'visitId=s1'],
    ['a payload that is a list', ['s1']],
  ];

  it.each(refused)('refuses %s', async (_what, payload) => {
    await expect(logActivityHandler(req({ actionType: 'TEST_EVENT', payload }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(writeAuditEntryMock).not.toHaveBeenCalled();
  });

  it('names the refused key, so the caller can see what to fix', async () => {
    await expect(
      logActivityHandler(req({ actionType: 'TEST_EVENT', payload: { cardNumber: '4242' } })),
    ).rejects.toMatchObject({ message: expect.stringContaining('cardNumber') });
  });

  it('refuses a payload over the size limit even when every value fits its own limit', async () => {
    const full = Array.from({ length: 50 }, (_v, i) => `${i}`.padEnd(80, 'x'));
    const payload = { changedFields: full, tags: full };
    expect(JSON.stringify(payload).length).toBeGreaterThan(ACTIVITY_PAYLOAD_MAX_CHARS);
    await expect(logActivityHandler(req({ actionType: 'TEST_EVENT', payload }))).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining(`${ACTIVITY_PAYLOAD_MAX_CHARS}`),
    });
    expect(writeAuditEntryMock).not.toHaveBeenCalled();
  });
});
