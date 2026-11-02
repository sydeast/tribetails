import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #1462: Home's Balance due line. `getMyHome.balanceDueCents` is the sum of
 * what the household's `open` invoices still owe, read the same way
 * `getMyInvoices` reads each one, and 0 for a member without billing access.
 * It is never the account credit (`families/{id}.accountBalanceCents`).
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { openBalanceCentsOf } from '../src/portal/getMyInvoices';
import { getMyHomeHandler } from '../src/portal/getMyHome';

function req(uid: string): CallableRequest<{ kinfolkId?: string }> {
  return {
    data: { kinfolkId: 'fam1' },
    auth: { uid, token: {} },
    rawRequest: {},
    acceptsStreaming: false,
  } as unknown as CallableRequest<{ kinfolkId?: string }>;
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  process.env.AUNTIE_OPERATOR_UIDS = '';
});

describe('openBalanceCentsOf', () => {
  it('counts an open invoice with a balance', () => {
    expect(openBalanceCentsOf([{ status: 'open', amountDue: 40, total: 40 }])).toBe(4000);
  });

  it('adds nothing for a paid invoice, even one still stating a balance', () => {
    expect(openBalanceCentsOf([{ status: 'paid', amountDue: 0, total: 40 }])).toBe(0);
    expect(openBalanceCentsOf([{ status: 'paid', amountDue: 40, total: 40 }])).toBe(0);
  });

  it('adds nothing for an open invoice with nothing left to pay', () => {
    expect(openBalanceCentsOf([{ status: 'open', amountDue: 0, total: 40 }])).toBe(0);
  });

  it('adds nothing for a cancelled invoice', () => {
    expect(openBalanceCentsOf([{ status: 'cancelled', amountDue: 25, total: 25 }])).toBe(0);
  });

  it('adds nothing for credit, draft or quote invoices', () => {
    expect(
      openBalanceCentsOf([
        { status: 'credit', amountDue: -12, total: -12 },
        { status: 'draft', amountDue: 30, total: 30 },
        { status: 'quote', amountDue: 30, total: 30 },
      ]),
    ).toBe(0);
  });

  it('reads an unstamped invoice with only a total the way the Invoices screen does (#902)', () => {
    // No status stamp routes to `open`; no stated balance derives the total.
    expect(openBalanceCentsOf([{ total: 55 }])).toBe(5500);
  });

  it('takes the integer amountDueCents over the dollars float, and subtracts paidCents from a derived balance', () => {
    expect(openBalanceCentsOf([{ status: 'open', amountDueCents: 1234, amountDue: 99, total: 99 }])).toBe(1234);
    expect(openBalanceCentsOf([{ status: 'open', total: 50, paidCents: 2000 }])).toBe(3000);
  });

  it('sums every open invoice and ignores a negative stated balance', () => {
    expect(
      openBalanceCentsOf([
        { status: 'open', amountDue: 40, total: 40 },
        { status: 'open', amountDue: 12.5, total: 12.5 },
        { status: 'open', amountDue: -5, total: 0 },
        { status: 'paid', amountDue: 0, total: 80 },
      ]),
    ).toBe(5250);
  });
});

function seed(members: Record<string, Record<string, unknown>> = {}) {
  const invoices = [
    { id: 'i-open', data: { kinfolkId: 'fam1', status: 'open', amountDue: 40, total: 40 } },
    { id: 'i-paid', data: { kinfolkId: 'fam1', status: 'paid', amountDue: 0, total: 60 } },
    { id: 'i-zero', data: { kinfolkId: 'fam1', status: 'open', amountDue: 0, total: 15 } },
    { id: 'i-cancel', data: { kinfolkId: 'fam1', status: 'cancelled', amountDue: 25, total: 25 } },
    { id: 'i-other', data: { kinfolkId: 'fam2', status: 'open', amountDue: 999, total: 999 } },
  ];
  return buildDbMock({
    docs: {
      'clients/pk1': { kinfolkIds: ['fam1'] },
      'clients/sk-none': { kinfolkIds: ['fam1'] },
      // The account credit must never leak into the owed figure.
      'families/fam1': { displayName: 'The Mercers', accountBalanceCents: 1500 },
      ...members,
    },
    queryDocs: { invoices },
  });
}

describe('getMyHome.balanceDueCents', () => {
  it('is the open balance for this household only, not the account credit', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const res = await getMyHomeHandler(req('pk1'));
    expect(res.billingAccess).toBe(true);
    expect(res.balanceDueCents).toBe(4000);
  });

  it('is 0 when nothing is owed', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        docs: { 'clients/pk1': { kinfolkIds: ['fam1'] }, 'families/fam1': { displayName: 'The Mercers' } },
        queryDocs: { invoices: [{ id: 'i-paid', data: { kinfolkId: 'fam1', status: 'paid', amountDue: 0, total: 60 } }] },
      }).db,
    );
    const res = await getMyHomeHandler(req('pk1'));
    expect(res.balanceDueCents).toBe(0);
  });

  it('is 0 for a member without billing access, whatever is owed', async () => {
    mocks.dbFn.mockReturnValue(
      seed({
        'families/fam1/members/sk-none': { role: 'SECONDARY', status: 'ACTIVE', permissions: { billing_full: false } },
      }).db,
    );
    const res = await getMyHomeHandler(req('sk-none'));
    expect(res.billingAccess).toBe(false);
    expect(res.balanceDueCents).toBe(0);
  });
});
