import { describe, it, expect, vi, beforeEach } from 'vitest';

import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
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

beforeEach(() => mocks.dbFn.mockReset());

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

  it('a legacy household with no member docs keeps its one account', async () => {
    seed('legacy1', {});
    expect(await resolveBillingRecipientUid('fam1')).toBe('legacy1');
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
