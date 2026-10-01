import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #1085: deleting `clients/{uid}` clears the household back-link, and ONLY a
 * back-link that is that account's.
 *
 * This file used to hold a single `expect(true).toBe(true)` ("cannot be
 * unit-tested in isolation easily"), so the delete branch had no test at all.
 * It merge-wrote `kinfolk/{kinfolkIds[0]}` with `{ uid: '' }` blind: a deleted
 * test account whose first household belonged to a real primary wiped the real
 * link, and a household deleted in the same pass came back as a stub. The
 * #1082 purge refused to run against production because of it.
 */
const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  setClaims: vi.fn(async () => undefined),
  syncKinfolkClaim: vi.fn(async () => ({ kinfolkId: 'fam-a' })),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: vi.fn(() => ({ setCustomUserClaims: mocks.setClaims })),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/kinfolkClaim', () => ({ syncKinfolkClaim: mocks.syncKinfolkClaim }));

import { onClientsWrite } from '../src/triggers/onClientsWrite';

type Docs = Record<string, Record<string, unknown> | null>;

function dbWith(docs: Docs) {
  const mock = buildDbMock({ docs, writeThrough: true });
  mocks.dbFn.mockReturnValue(mock.db);
  return mock;
}

async function deleteClient(uid: string, before: Record<string, unknown>) {
  await onClientsWrite.run({
    id: `evt-${uid}`,
    params: { uid },
    data: {
      before: { data: () => before, exists: true },
      after: { data: () => undefined, exists: false },
    },
  } as never);
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.setClaims.mockClear();
  mocks.syncKinfolkClaim.mockClear();
});

describe('onClientsWrite on delete (#1085)', () => {
  it('clears the household uid when it is the deleted account', async () => {
    const { writes } = dbWith({ 'kinfolk/fam-a': { uid: 'uid-gone', email: 'catch@hanasamku.com' } });
    await deleteClient('uid-gone', { kinfolkIds: ['fam-a'] });
    expect(writes.map((w) => [w.path, w.data])).toEqual([['kinfolk/fam-a', { uid: '' }]]);
    expect(mocks.setClaims).toHaveBeenCalledWith('uid-gone', null);
  });

  it('leaves a household linked to ANOTHER account alone', async () => {
    const { writes } = dbWith({ 'kinfolk/fam-a': { uid: 'uid-real-primary' } });
    await deleteClient('uid-test', { kinfolkIds: ['fam-a'] });
    expect(writes).toEqual([]);
  });

  it('does not recreate a household that no longer exists', async () => {
    const { writes } = dbWith({ 'kinfolk/fam-gone': null });
    await deleteClient('uid-gone', { kinfolkIds: ['fam-gone'] });
    expect(writes).toEqual([]);
  });

  it('checks every listed household, not only the first', async () => {
    const { writes } = dbWith({
      'kinfolk/fam-other': { uid: 'uid-someone-else' },
      'kinfolk/fam-mine': { uid: 'uid-gone' },
    });
    await deleteClient('uid-gone', { kinfolkIds: ['fam-other', 'fam-mine'] });
    expect(writes.map((w) => [w.path, w.data])).toEqual([['kinfolk/fam-mine', { uid: '' }]]);
  });

  it('writes nothing when the deleted client listed no households', async () => {
    const { writes } = dbWith({});
    await deleteClient('uid-gone', {});
    expect(writes).toEqual([]);
    expect(mocks.setClaims).toHaveBeenCalledWith('uid-gone', null);
  });
});

describe('onClientsWrite on create or update', () => {
  it('syncs the claim and touches no household', async () => {
    const { writes } = dbWith({});
    await onClientsWrite.run({
      id: 'evt-up',
      params: { uid: 'uid-live' },
      data: {
        before: { data: () => undefined, exists: false },
        after: { data: () => ({ kinfolkIds: ['fam-a'] }), exists: true },
      },
    } as never);
    expect(mocks.syncKinfolkClaim).toHaveBeenCalledWith('uid-live');
    expect(writes).toEqual([]);
  });
});
