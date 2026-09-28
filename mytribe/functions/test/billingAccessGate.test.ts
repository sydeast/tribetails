import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallableRequest } from 'firebase-functions/v2/https';

import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), pdf: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/lib/invoicePdf', () => ({ generateAndStoreInvoicePdf: mocks.pdf }));

import { getMyInvoicesHandler } from '../src/portal/getMyInvoices';
import { getMyInvoicePdfHandler } from '../src/portal/getMyInvoicePdf';
import { getMyHomeHandler } from '../src/portal/getMyHome';
import { BILLING_ACCESS_REFUSAL, hasBillingAccess } from '../src/lib/memberGate';

/**
 * #1005. Operator ruling 2026-09-27: billing access is the business owner or
 * admin, the PRIMARY, and a SECONDARY only when the PRIMARY granted it. An
 * Auntie never sees money and never uses the portal.
 *
 * Every portal read of money is asked the same question here, across the five
 * callers the issue names plus the two edges `hasKinfolkPerm` makes risky: the
 * legacy primary with no member doc (must pass) and a caller naming a household
 * that is not theirs (must be refused before the billing question is asked).
 */

type Caller = { uid: string | null; token: Record<string, unknown> };

const PK: Caller = { uid: 'pk1', token: {} };
const SK_BILLING: Caller = { uid: 'sk-bill', token: {} };
const SK_NO_BILLING: Caller = { uid: 'sk-none', token: {} };
const LEGACY: Caller = { uid: 'legacy1', token: {} };
const OWNER: Caller = { uid: 'owner1', token: { admin: true } };
const AUNTIE: Caller = { uid: 'auntie1', token: { staffRole: 'auntie' } };

function req(data: unknown, caller: Caller): CallableRequest<any> {
  return {
    data,
    auth: caller.uid ? ({ uid: caller.uid, token: caller.token } as any) : undefined,
    rawRequest: {} as any,
    acceptsStreaming: false,
  } as unknown as CallableRequest<any>;
}

function seed() {
  return buildDbMock({
    docs: {
      'kinfolk/fam1': { firstName: 'Dana', lastName: 'Mercer' },
      'families/fam1': { displayName: 'The Mercers', accountBalanceCents: 1500 },
      'families/fam2': { displayName: 'Someone Else', accountBalanceCents: 9900 },
      'business_settings/business_settings': { venmoHandle: '@auntie' },
      'clients/pk1': { kinfolkIds: ['fam1'] },
      'clients/sk-bill': { kinfolkIds: ['fam1'] },
      'clients/sk-none': { kinfolkIds: ['fam1'] },
      'clients/legacy1': { kinfolkIds: ['fam1'] },
      'clients/owner1': { kinfolkIds: [] },
      'families/fam1/members/pk1': { role: 'PRIMARY', status: 'ACTIVE', permissions: {} },
      'families/fam1/members/sk-bill': { role: 'SECONDARY', status: 'ACTIVE', permissions: { billing_full: true } },
      'families/fam1/members/sk-none': { role: 'SECONDARY', status: 'ACTIVE', permissions: { billing_full: false } },
      'invoices/inv1': { kinfolkId: 'fam1', status: 'open', amountDue: 40, total: 40, invoiceNumber: 'INV-1' },
    },
    queryDocs: {
      invoices: [{ id: 'inv1', data: { kinfolkId: 'fam1', status: 'open', amountDue: 40, total: 40, invoiceNumber: 'INV-1' } }],
    },
  });
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.pdf.mockReset().mockResolvedValue('https://storage.example/inv1.pdf');
  process.env.AUNTIE_OPERATOR_UIDS = '';
  mocks.dbFn.mockReturnValue(seed().db);
});

const ALLOWED: Array<[string, Caller, Record<string, unknown>]> = [
  ['the PRIMARY', PK, {}],
  ['a SECONDARY the PRIMARY granted billing', SK_BILLING, {}],
  ['a legacy primary with no member doc', LEGACY, {}],
  ['the owner, naming the household', OWNER, { kinfolkId: 'fam1' }],
];

describe('#1005 getMyInvoices: billing access only', () => {
  for (const [who, caller, extra] of ALLOWED) {
    it(`${who} sees the bills and the balance`, async () => {
      const res = await getMyInvoicesHandler(req({ ...extra }, caller));
      expect(res.accountBalanceCents).toBe(1500);
      expect(res.open.map((i) => i.id)).toEqual(['inv1']);
    });
  }

  it('a SECONDARY without billing is refused with the shared billing refusal', async () => {
    await expect(getMyInvoicesHandler(req({}, SK_NO_BILLING))).rejects.toMatchObject({
      code: 'permission-denied',
      message: BILLING_ACCESS_REFUSAL,
    });
  });

  it('an Auntie is refused by role before any read', async () => {
    await expect(getMyInvoicesHandler(req({ kinfolkId: 'fam1' }, AUNTIE))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(mocks.dbFn).not.toHaveBeenCalled();
  });

  it('a legacy primary naming a household that is not theirs is refused by the household check', async () => {
    // No member doc in fam2 either, which the billing question alone would
    // read as a legacy primary. The household check must refuse first.
    await expect(getMyInvoicesHandler(req({ kinfolkId: 'fam2' }, LEGACY))).rejects.toMatchObject({
      code: 'permission-denied',
      message: 'You do not have access to this tribe.',
    });
  });
});

describe('#1005 getMyInvoicePdf: billing access only', () => {
  for (const [who, caller, extra] of ALLOWED) {
    it(`${who} gets the PDF`, async () => {
      const res = await getMyInvoicePdfHandler(req({ invoiceId: 'inv1', ...extra }, caller));
      expect(res.pdfUrl).toBe('https://storage.example/inv1.pdf');
    });
  }

  it('a SECONDARY without billing is refused, and nothing is rendered', async () => {
    await expect(getMyInvoicePdfHandler(req({ invoiceId: 'inv1' }, SK_NO_BILLING))).rejects.toMatchObject({
      code: 'permission-denied',
      message: BILLING_ACCESS_REFUSAL,
    });
    expect(mocks.pdf).not.toHaveBeenCalled();
  });

  it('an Auntie is refused by role, and nothing is rendered', async () => {
    await expect(
      getMyInvoicePdfHandler(req({ invoiceId: 'inv1', kinfolkId: 'fam1' }, AUNTIE)),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(mocks.pdf).not.toHaveBeenCalled();
  });
});

describe('#1005 getMyHome: says whether the caller has billing access, and hides pay links when not', () => {
  for (const [who, caller, extra] of ALLOWED) {
    it(`${who}: billingAccess true, pay links served`, async () => {
      const res = await getMyHomeHandler(req({ ...extra }, caller));
      expect(res.billingAccess).toBe(true);
      expect(res.payMethods.map((m) => m.id)).toEqual(['stripe', 'venmo']);
    });
  }

  it('a SECONDARY without billing still gets Home, with billingAccess false and no pay links', async () => {
    const res = await getMyHomeHandler(req({}, SK_NO_BILLING));
    expect(res.displayName).toBe('The Mercers');
    expect(res.billingAccess).toBe(false);
    expect(res.payMethods).toEqual([]);
  });

  it('an Auntie is refused by role', async () => {
    await expect(getMyHomeHandler(req({ kinfolkId: 'fam1' }, AUNTIE))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});

describe('#1005 hasBillingAccess: the one helper', () => {
  it('answers for each member shape', async () => {
    expect(await hasBillingAccess('pk1', 'fam1', false, 't')).toBe(true);
    expect(await hasBillingAccess('sk-bill', 'fam1', false, 't')).toBe(true);
    expect(await hasBillingAccess('sk-none', 'fam1', false, 't')).toBe(false);
    expect(await hasBillingAccess('owner1', 'fam1', true, 't')).toBe(true);
  });

  it('a suspended PRIMARY has no billing access', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({ docs: { 'families/fam1/members/pk1': { role: 'PRIMARY', status: 'SUSPENDED', permissions: {} } } }).db,
    );
    expect(await hasBillingAccess('pk1', 'fam1', false, 't')).toBe(false);
  });

  it('says yes to a caller with no member doc, which is why it must follow the household check', async () => {
    // Pinned so nobody calls it on an unresolved household id: this is the
    // legacy-primary anti-lockout, and it answers for ANY household.
    expect(await hasBillingAccess('stranger', 'fam2', false, 't')).toBe(true);
  });
});
