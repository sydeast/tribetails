import { describe, it, expect, vi, beforeEach } from 'vitest';

import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), authFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: mocks.authFn, getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { resolveBillingRecipientUid } from '../src/lib/resolveBillingRecipientUid';

/**
 * #1005: a member without billing access must not receive invoice or payment
 * notices carrying amounts. The money emitters used to address
 * `kinfolk/{id}.uid`, which is whichever account synced last, a SECONDARY
 * included.
 */

const PK = { role: 'PRIMARY', status: 'ACTIVE', permissions: {} };
const SK_BILLING = { role: 'SECONDARY', status: 'ACTIVE', permissions: { billing_full: true } };
const SK_NONE = { role: 'SECONDARY', status: 'ACTIVE', permissions: { billing_full: false } };

function members(rows: Record<string, Record<string, unknown>>) {
  return Object.entries(rows).map(([id, data]) => ({ id, data }));
}

function seed(backwriteUid: string | null, rows: Record<string, Record<string, unknown>>) {
  const docs: Record<string, Record<string, unknown> | null> = {
    'kinfolk/fam1': backwriteUid === null ? { firstName: 'Dana' } : { uid: backwriteUid },
  };
  for (const [id, data] of Object.entries(rows)) docs[`families/fam1/members/${id}`] = data;
  mocks.dbFn.mockReturnValue(
    buildDbMock({ docs, queryDocs: { 'families/fam1/members': members(rows) } }).db,
  );
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.authFn.mockReset();
});

/** A legacy primary's extra records: its own client record lists the household, and its token. */
function seedLegacy(uid: string, claims: Record<string, unknown>, extra: Record<string, Record<string, unknown>> = {}) {
  mocks.dbFn.mockReturnValue(
    buildDbMock({
      docs: { 'kinfolk/fam1': { uid }, [`clients/${uid}`]: { kinfolkIds: ['fam1'] }, ...extra },
      queryDocs: { 'families/fam1/members': [] },
    }).db,
  );
  mocks.authFn.mockReturnValue({ getUser: vi.fn(() => Promise.resolve({ customClaims: claims })) });
}

describe('resolveBillingRecipientUid', () => {
  it('the PRIMARY as the synced account gets it', async () => {
    seed('pk1', { pk1: PK, sk1: SK_NONE });
    expect(await resolveBillingRecipientUid('fam1')).toBe('pk1');
  });

  it('a SECONDARY with billing as the synced account keeps getting it', async () => {
    seed('sk1', { pk1: PK, sk1: SK_BILLING });
    expect(await resolveBillingRecipientUid('fam1')).toBe('sk1');
  });

  it('a SECONDARY without billing as the synced account: the PRIMARY gets it instead', async () => {
    seed('sk1', { pk1: PK, sk1: SK_NONE });
    expect(await resolveBillingRecipientUid('fam1')).toBe('pk1');
  });

  it('a SECONDARY without billing and no active PRIMARY: nobody in the household gets it', async () => {
    seed('sk1', { pk1: { ...PK, status: 'SUSPENDED' }, sk1: SK_NONE });
    expect(await resolveBillingRecipientUid('fam1')).toBeNull();
  });

  it('a suspended SECONDARY that once held billing does not get it', async () => {
    seed('sk1', { pk1: PK, sk1: { ...SK_BILLING, status: 'SUSPENDED' } });
    expect(await resolveBillingRecipientUid('fam1')).toBe('pk1');
  });

  it('an owner who stepped into the household (no member doc) is replaced by the PRIMARY', async () => {
    seed('owner1', { pk1: PK });
    expect(await resolveBillingRecipientUid('fam1')).toBe('pk1');
  });

  it('#1840: a stored login with no member docs in the household gets no money notice', async () => {
    // This used to return the stored login as "the household's one account".
    // An unclaimed household whose record carries a staff login has exactly
    // this shape, and its invoices went to the staff login.
    seed('uid_admin', {});
    expect(await resolveBillingRecipientUid('fam1')).toBeNull();
  });

  it('#2096: a legacy primary (linked before the member model, not staff) keeps its money notices until the backfill', async () => {
    seedLegacy('legacy1', { role: 'kinfolk', kinfolkId: 'fam1' });
    expect(await resolveBillingRecipientUid('fam1')).toBe('legacy1');
  });

  it('#2096 NEGATIVE: the same shape with an admin claim gets no money notice', async () => {
    seedLegacy('uid_admin', { admin: true });
    expect(await resolveBillingRecipientUid('fam1')).toBeNull();
  });

  it('#2096 NEGATIVE: the same shape with a staff record gets no money notice', async () => {
    seedLegacy('auntie1', { role: 'kinfolk' }, { 'staff/auntie1': { role: 'auntie' } });
    expect(await resolveBillingRecipientUid('fam1')).toBeNull();
  });

  it('no synced account: the PRIMARY', async () => {
    seed(null, { pk1: PK });
    expect(await resolveBillingRecipientUid('fam1')).toBe('pk1');
  });

  it('no synced account and no members: null, the office copy still goes', async () => {
    seed(null, {});
    expect(await resolveBillingRecipientUid('fam1')).toBeNull();
  });

  it('an Auntie is never a household member, so she never resolves here', async () => {
    // An Auntie assigned the tribe syncs a kinfolk claim and can land in the
    // backwrite (#984). She has no member doc, so the PRIMARY wins.
    seed('auntie1', { pk1: PK, sk1: SK_NONE });
    expect(await resolveBillingRecipientUid('fam1')).toBe('pk1');
  });
});
