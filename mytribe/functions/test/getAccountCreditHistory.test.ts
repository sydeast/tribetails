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
    expect(res).toEqual({
      ok: true,
      kinfolkId: 'fam1',
      accountBalanceCents: 0,
      credits: [],
      uses: [],
      earlierCredit: null,
    });
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

describe('getAccountCreditHistory: the history adds up to the balance (#1939, #1969)', () => {
  /** The walk household: $957.00 held, three uses, and no credit the log listed. */
  const WALK_DRAWS = [
    {
      id: 'draw_p20',
      data: { kind: 'draw', amountCents: 105_000, invoiceId: 'i20', invoiceNumber: '1020', heldBeforeCents: 201_500, atMs: 100 },
    },
    {
      id: 'draw_p21',
      data: { kind: 'draw', amountCents: 500, invoiceId: 'i21', invoiceNumber: '1021', heldBeforeCents: 96_500, atMs: 200 },
    },
    {
      id: 'draw_p23',
      data: { kind: 'draw', amountCents: 300, invoiceId: 'i23', invoiceNumber: '1023', heldBeforeCents: 96_000, atMs: 300 },
    },
  ];
  function walk(balanceCents: number, events: Array<{ id: string; data: Record<string, unknown> }> = WALK_DRAWS) {
    return buildDbMock({
      docs: { 'families/fam1': { accountBalanceCents: balanceCents } },
      queryDocs: { 'families/fam1/creditLedger': events },
    });
  }
  it('names the credit the log does not list, so credits less uses is the balance', async () => {
    const ctx = walk(95_700);
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = Result.parse(
      await getAccountCreditHistoryHandler(req({ kinfolkId: 'fam1' }, { admin: true }, 'owner1')),
    );
    expect(res.credits).toEqual([]);
    expect(res.earlierCredit).toEqual({ amountCents: 201_500, remainingCents: 95_700 });
    const used = res.uses.reduce((s, u) => s + u.amountCents, 0);
    expect(res.earlierCredit!.amountCents - used).toBe(res.accountBalanceCents);
  });

  it('a credit kept from a payment is listed with its reason, and the rest is earlier credit', async () => {
    const ctx = walk(95_700, [
      {
        id: 'payment_pay9',
        data: {
          kind: 'given',
          source: 'payment',
          amountCents: 1500,
          reason: 'From a payment on invoice 1018',
          atMs: 50,
          givenBy: 'owner1',
        },
      },
      ...WALK_DRAWS,
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getAccountCreditHistoryHandler(req({ kinfolkId: 'fam1' }, { admin: true }, 'owner1'));
    expect(res.credits.map((c) => [c.amountCents, c.reason])).toEqual([[1500, 'From a payment on invoice 1018']]);
    // FIFO spent the earlier pool first, so the $15.00 is still all there.
    expect(res.credits[0].remainingCents).toBe(1500);
    expect(res.earlierCredit).toEqual({ amountCents: 200_000, remainingCents: 94_200 });
    const listed = res.credits.reduce((s, c) => s + c.amountCents, 0);
    const used = res.uses.reduce((s, u) => s + u.amountCents, 0);
    expect(listed + res.earlierCredit!.amountCents - used).toBe(95_700);
  });

  it('a balance below what the listed credits still hold shows no earlier row and is logged', async () => {
    const { logEvent } = await import('../src/lib/logger');
    vi.mocked(logEvent).mockClear();
    const ctx = walk(1000, [
      { id: 'crd_1', data: { kind: 'given', amountCents: 2500, reason: 'Missed visit', atMs: 1000, givenBy: 'owner1' } },
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getAccountCreditHistoryHandler(req({ kinfolkId: 'fam1' }, { admin: true }, 'owner1'));
    expect(res.earlierCredit).toBeNull();
    expect(vi.mocked(logEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'portal.credit.history.unreconciled', familyId: 'fam1' }),
    );
  });

  it('every credit listed: no earlier row', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getAccountCreditHistoryHandler(req({ kinfolkId: 'fam1' }, { admin: true }, 'owner1'));
    expect(res.earlierCredit).toBeNull();
  });

  it('a balance with no events at all is all earlier credit, none used', async () => {
    const ctx = walk(4200, []);
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getAccountCreditHistoryHandler(req({ kinfolkId: 'fam1' }, { admin: true }, 'owner1'));
    expect(res.earlierCredit).toEqual({ amountCents: 4200, remainingCents: 4200 });
  });
});
