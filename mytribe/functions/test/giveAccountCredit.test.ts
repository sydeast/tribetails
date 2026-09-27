import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallableRequest } from 'firebase-functions/v2/https';

import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: {
      serverTimestamp: () => '__TS__',
      increment: (n: number) => ({ __increment: n }),
    },
  };
});

import { giveAccountCreditHandler, Result } from '../src/admin/giveAccountCredit';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../src/lib/auditEvents';

/**
 * Q6 (operator ruling 2026-09-27): the owner gives a household account credit
 * with a reason. Owner only, audited, idempotent on the caller's key, and the
 * balance moves in the same transaction as the event that explains it.
 */

const KEY = 'crd_1790000000000_abc123';

function req(
  data: unknown,
  token: Record<string, unknown> = { admin: true },
  uid: string | null = 'owner1',
): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: token as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function seed(family: Record<string, unknown> | null = { accountBalanceCents: 1200 }, extra: Record<string, any> = {}) {
  return buildDbMock({ docs: { 'families/fam1': family, ...extra }, writeThrough: true });
}

const ok = { kinfolkId: 'fam1', amountCents: 2500, reason: 'Missed visit on Sept 12', idempotencyKey: KEY };

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

describe('giveAccountCredit: the owner gives credit', () => {
  it('writes the given event and the new balance together, and answers with the new balance', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await giveAccountCreditHandler(req(ok));

    expect(Result.parse(res)).toEqual({
      ok: true,
      creditId: KEY,
      amountCents: 2500,
      newAccountBalanceCents: 3700,
      replayed: false,
    });
    const event = ctx.writes.find((w) => w.path === `families/fam1/creditLedger/${KEY}`);
    expect(event?.data).toMatchObject({
      kind: 'given',
      amountCents: 2500,
      reason: 'Missed visit on Sept 12',
      givenBy: 'owner1',
      balanceBeforeCents: 1200,
      balanceAfterCents: 3700,
    });
    expect(typeof event?.data['atMs']).toBe('number');
    const fam = ctx.writes.find((w) => w.path === 'families/fam1');
    // An absolute figure read in the same transaction, never a blind increment.
    expect(fam?.data['accountBalanceCents']).toBe(3700);
    expect(fam?.merge).toBe(true);
    expect(ctx.db.runTransaction).toHaveBeenCalledTimes(1);
  });

  it('trims the reason before storing it', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await giveAccountCreditHandler(req({ ...ok, reason: '  Goodwill  ' }));
    const event = ctx.writes.find((w) => w.path === `families/fam1/creditLedger/${KEY}`);
    expect(event?.data['reason']).toBe('Goodwill');
  });

  it('treats a household with no balance yet as zero', async () => {
    const ctx = seed({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await giveAccountCreditHandler(req(ok));
    expect(res.newAccountBalanceCents).toBe(2500);
  });

  it('writes one audit entry, at a fixed id so a retry cannot write a second', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await giveAccountCreditHandler(req(ok));
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    expect((writeAuditEntry as any).mock.calls[0][0]).toMatchObject({
      status: 'SUCCESS',
      event: AUDIT_EVENTS.BILLING_ACCOUNT_CREDIT_GIVEN,
      actorUid: 'owner1',
      familyId: 'fam1',
      docId: `account_credit_given_${KEY}`,
      payload: {
        amountCents: 2500,
        reason: 'Missed visit on Sept 12',
        balanceBeforeCents: 1200,
        balanceAfterCents: 3700,
        idempotencyKey: KEY,
      },
    });
  });

  it('two different credits add up; neither overwrites the other', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await giveAccountCreditHandler(req(ok));
    const second = await giveAccountCreditHandler(
      req({ ...ok, amountCents: 300, idempotencyKey: 'crd_1790000000001_def456' }),
    );
    expect(second.newAccountBalanceCents).toBe(4000);
  });

  it('refuses a household that does not exist, and writes nothing', async () => {
    const ctx = seed(null);
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(giveAccountCreditHandler(req(ok))).rejects.toMatchObject({ code: 'not-found' });
    expect(ctx.writes).toHaveLength(0);
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });
});

describe('giveAccountCredit: idempotency', () => {
  it('a retry with the same key adds nothing and answers the first result', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await giveAccountCreditHandler(req(ok));
    const writesAfterFirst = ctx.writes.length;

    const again = await giveAccountCreditHandler(req(ok));

    expect(again).toEqual({
      ok: true,
      creditId: KEY,
      amountCents: 2500,
      newAccountBalanceCents: 3700,
      replayed: true,
    });
    expect(ctx.writes.length).toBe(writesAfterFirst);
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
  });

  it('refuses a key another admin already used', async () => {
    const ctx = seed({ accountBalanceCents: 0 }, {
      [`families/fam1/creditLedger/${KEY}`]: { kind: 'given', amountCents: 100, givenBy: 'owner2', balanceAfterCents: 100 },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(giveAccountCreditHandler(req(ok))).rejects.toMatchObject({ code: 'already-exists' });
    expect(ctx.writes).toHaveLength(0);
  });
});

describe('giveAccountCredit: who may not', () => {
  it('refuses an Auntie by role, before any read', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(giveAccountCreditHandler(req(ok, { staffRole: 'auntie' }, 'auntie1'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(mocks.dbFn).not.toHaveBeenCalled();
  });

  it('refuses an Auntie even if her token also carries admin', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      giveAccountCreditHandler(req(ok, { staffRole: 'auntie', admin: true }, 'auntie1')),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses kinfolk, including the household PRIMARY', async () => {
    const ctx = seed({ accountBalanceCents: 0 }, { 'families/fam1/members/kin1': { role: 'PRIMARY', status: 'ACTIVE' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(giveAccountCreditHandler(req(ok, {}, 'kin1'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses a signed-out caller', async () => {
    await expect(giveAccountCreditHandler(req(ok, {}, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('refuses a sandbox admin outside their own tribe, and admits them inside it', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      giveAccountCreditHandler(req(ok, { testTribeId: 'test-kinfolk-001' }, 'tester')),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toHaveLength(0);

    const inside = buildDbMock({ docs: { 'families/test-kinfolk-001': {} }, writeThrough: true });
    mocks.dbFn.mockReturnValue(inside.db);
    const res = await giveAccountCreditHandler(
      req({ ...ok, kinfolkId: 'test-kinfolk-001' }, { testTribeId: 'test-kinfolk-001' }, 'tester'),
    );
    expect(res.newAccountBalanceCents).toBe(2500);
  });
});

describe('giveAccountCredit: what it refuses to accept', () => {
  it.each([
    ['zero', { amountCents: 0 }],
    ['a negative amount', { amountCents: -500 }],
    ['fractional cents', { amountCents: 10.5 }],
    ['dollars as a string', { amountCents: '25.00' }],
    ['one cent over the $5,000 cap', { amountCents: 500_001 }],
    ['a blank reason', { reason: '   ' }],
    ['no reason', { reason: undefined }],
    ['a reason over 1000 characters', { reason: 'x'.repeat(1001) }],
    ['no key', { idempotencyKey: undefined }],
    ['a key minted for another callable', { idempotencyKey: 'pay_1790000000000_abc123' }],
    ['an unknown field', { refund: true }],
  ])('%s', async (_label, over) => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(giveAccountCreditHandler(req({ ...ok, ...over }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('accepts exactly the cap', async () => {
    const ctx = seed({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await giveAccountCreditHandler(req({ ...ok, amountCents: 500_000 }));
    expect(res.newAccountBalanceCents).toBe(500_000);
  });
});
