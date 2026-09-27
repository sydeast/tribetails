import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallableRequest } from 'firebase-functions/v2/https';

import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { getAccountCreditHistoryHandler, Result } from '../src/portal/getAccountCreditHistory';

/**
 * Q6: "Those with billing access: biz owner/admin, PK, and SK if PK granted
 * access can see the credit, dates, reason, and date applied when used."
 * Everyone else is refused.
 */

function req(
  data: unknown,
  token: Record<string, unknown> = {},
  uid: string | null = 'kin1',
): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: token as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const EVENTS = [
  { id: 'crd_1', data: { kind: 'given', amountCents: 2500, reason: 'Missed visit', atMs: 1000, givenBy: 'owner1' } },
  {
    id: 'draw_p1',
    data: { kind: 'draw', amountCents: 2500, invoiceId: 'inv9', invoiceNumber: 'INV-1009', heldBeforeCents: 2500, atMs: 2000 },
  },
  { id: 'crd_2', data: { kind: 'given', amountCents: 1000, reason: 'Goodwill', atMs: 3000, givenBy: 'owner1' } },
];

function seed(docs: Record<string, Record<string, unknown> | null> = {}) {
  return buildDbMock({
    docs: {
      'families/fam1': { accountBalanceCents: 1000 },
      'clients/kin1': { kinfolkIds: ['fam1'] },
      ...docs,
    },
    queryDocs: { 'families/fam1/creditLedger': EVENTS },
  });
}

beforeEach(() => mocks.dbFn.mockReset());

describe('getAccountCreditHistory: who sees it', () => {
  it('the owner sees any household by id', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getAccountCreditHistoryHandler(req({ kinfolkId: 'fam1' }, { admin: true }, 'owner1'));
    expect(Result.parse(res).credits).toHaveLength(2);
  });

  it('the owner must name the household', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      getAccountCreditHistoryHandler(req({}, { admin: true }, 'owner1')),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('the PRIMARY sees their own household', async () => {
    const ctx = seed({ 'families/fam1/members/kin1': { role: 'PRIMARY', status: 'ACTIVE', permissions: {} } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getAccountCreditHistoryHandler(req({ kinfolkId: 'fam1' }));
    expect(res.kinfolkId).toBe('fam1');
    expect(res.accountBalanceCents).toBe(1000);
  });

  it('a legacy primary with no member doc sees it (the anti-lockout path)', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getAccountCreditHistoryHandler(req({}));
    expect(res.credits).toHaveLength(2);
  });

  it('a SECONDARY the PRIMARY granted billing sees it', async () => {
    const ctx = seed({
      'families/fam1/members/kin1': { role: 'SECONDARY', status: 'ACTIVE', permissions: { billing_full: true } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getAccountCreditHistoryHandler(req({ kinfolkId: 'fam1' }));
    expect(res.credits).toHaveLength(2);
  });

  it('a SECONDARY without billing is refused', async () => {
    const ctx = seed({
      'families/fam1/members/kin1': { role: 'SECONDARY', status: 'ACTIVE', permissions: { billing_full: false } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(getAccountCreditHistoryHandler(req({ kinfolkId: 'fam1' }))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('an inactive member is refused, even one that once held billing', async () => {
    const ctx = seed({
      'families/fam1/members/kin1': { role: 'SECONDARY', status: 'REMOVED', permissions: { billing_full: true } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(getAccountCreditHistoryHandler(req({ kinfolkId: 'fam1' }))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('kinfolk naming a household that is not theirs are refused, member doc or not', async () => {
    // No member doc there, which `hasKinfolkPerm` alone would read as a legacy
    // primary. The household check has to refuse first.
    const ctx = seed({ 'families/fam2': { accountBalanceCents: 5000 } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(getAccountCreditHistoryHandler(req({ kinfolkId: 'fam2' }))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('an Auntie is refused by role, before any read', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      getAccountCreditHistoryHandler(req({ kinfolkId: 'fam1' }, { staffRole: 'auntie' }, 'auntie1')),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(mocks.dbFn).not.toHaveBeenCalled();
  });

  it('a signed-out caller is refused', async () => {
    await expect(getAccountCreditHistoryHandler(req({}, {}, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('a sandbox admin sees only their own test tribe', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      getAccountCreditHistoryHandler(req({ kinfolkId: 'fam1' }, { testTribeId: 'test-kinfolk-001' }, 'tester')),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

describe('getAccountCreditHistory: what it shows', () => {
  it('each credit with its amount, date, reason and the date it was applied', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getAccountCreditHistoryHandler(req({ kinfolkId: 'fam1' }, { admin: true }, 'owner1'));
    expect(res.credits).toEqual([
      {
        creditId: 'crd_2',
        amountCents: 1000,
        reason: 'Goodwill',
        givenAtMs: 3000,
        remainingCents: 1000,
        fullyAppliedAtMs: null,
        applications: [],
      },
      {
        creditId: 'crd_1',
        amountCents: 2500,
        reason: 'Missed visit',
        givenAtMs: 1000,
        remainingCents: 0,
        fullyAppliedAtMs: 2000,
        applications: [{ appliedAtMs: 2000, amountCents: 2500, invoiceId: 'inv9', invoiceNumber: 'INV-1009' }],
      },
    ]);
    expect(res.uses).toEqual([
      { useId: 'draw_p1', usedAtMs: 2000, amountCents: 2500, invoiceId: 'inv9', invoiceNumber: 'INV-1009' },
    ]);
  });

  it('a household with no events answers an empty history, not an error', async () => {
    const ctx = buildDbMock({ docs: { 'families/fam1': {} } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getAccountCreditHistoryHandler(req({ kinfolkId: 'fam1' }, { admin: true }, 'owner1'));
    expect(res).toEqual({ ok: true, kinfolkId: 'fam1', accountBalanceCents: 0, credits: [], uses: [] });
  });

  it('a household that does not exist is not-found', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      getAccountCreditHistoryHandler(req({ kinfolkId: 'nope' }, { admin: true }, 'owner1')),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('writes nothing', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await getAccountCreditHistoryHandler(req({ kinfolkId: 'fam1' }, { admin: true }, 'owner1'));
    expect(ctx.writes).toHaveLength(0);
  });
});
