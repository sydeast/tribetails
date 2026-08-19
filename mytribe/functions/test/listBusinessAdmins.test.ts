import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { listBusinessAdminsHandler } from '../src/admin/provisionBusinessAdmins';

const ORIGINAL_ENV = process.env.AUNTIE_OPERATOR_UIDS;
const DOC = 'businessSettings/admins';

const req = { auth: { uid: 'op1' } } as unknown as CallableRequest<unknown>;

beforeEach(() => {
  mocks.dbFn.mockReset();
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.AUNTIE_OPERATOR_UIDS;
  else process.env.AUNTIE_OPERATOR_UIDS = ORIGINAL_ENV;
});

/**
 * The read behind the notification gate's business-admin roster (issue #450).
 *
 * The gate could say "every business admin, 4 people today" and name a
 * Firestore path. For every other audience it answers with a person; for this
 * one the operator had to go and read the document themselves, which is the
 * "look it up yourself" #396 was filed against.
 */
describe('listBusinessAdmins', () => {
  it('resolves the stored roster to names, and marks the default assignee', async () => {
    const ctx = buildDbMock({
      docs: {
        [DOC]: { uids: ['op1', 'op2'], defaultAssigneeUid: 'op2' },
        'staff/op1': { displayName: 'Auntie Nora', email: 'nora@tribetails.com' },
        'staff/op2': { displayName: 'Auntie Ray', email: 'ray@tribetails.com' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listBusinessAdminsHandler(req);

    expect(res.source).toBe('roster');
    expect(res.reason).toBeNull();
    expect(res.rosterPath).toBe('businessSettings/admins.uids');
    expect(res.members).toEqual([
      {
        uid: 'op1',
        displayName: 'Auntie Nora',
        email: 'nora@tribetails.com',
        hasStaffRecord: true,
        defaultAssignee: false,
      },
      {
        uid: 'op2',
        displayName: 'Auntie Ray',
        email: 'ray@tribetails.com',
        hasStaffRecord: true,
        defaultAssignee: true,
      },
    ]);
  });

  /**
   * An allowlist-seeded operator can legitimately have no `staff/{uid}` doc.
   * They still receive every business notification, so dropping them off this
   * list would under-report the audience, which is the failure this whole read
   * exists to prevent.
   */
  it('keeps a member with no staff record, showing the uid and no name', async () => {
    const ctx = buildDbMock({
      docs: {
        [DOC]: { uids: ['op1', 'ghost'] },
        'staff/op1': { displayName: 'Auntie Nora', email: 'nora@tribetails.com' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listBusinessAdminsHandler(req);

    expect(res.members).toHaveLength(2);
    expect(res.members[1]).toEqual({
      uid: 'ghost',
      displayName: null,
      email: null,
      hasStaffRecord: false,
      // No stored default, so the first uid on the roster is the implicit one.
      defaultAssignee: false,
    });
    expect(res.members[0]?.defaultAssignee).toBe(true);
  });

  it('reads a blank display name as no name rather than as an empty label', async () => {
    const ctx = buildDbMock({
      docs: {
        [DOC]: { uids: ['op1'] },
        'staff/op1': { displayName: '   ', email: '' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listBusinessAdminsHandler(req);
    expect(res.members[0]).toMatchObject({ uid: 'op1', displayName: null, email: null, hasStaffRecord: true });
  });

  /**
   * The empty-roster arm, and the reason this handler does not call
   * `resolveBusinessAdminUids`: that resolver SELF-HEALS by writing the roster
   * back from the allowlist. Opening a settings screen must not edit who
   * receives business mail, which is the same call `notificationOverrides.ts`
   * makes for the same document.
   */
  it('falls back to the operator allowlist without writing anything', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op9,op8';
    const ctx = buildDbMock({
      docs: {
        [DOC]: { uids: [] },
        'staff/op9': { displayName: 'Auntie Sam', email: 'sam@tribetails.com' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listBusinessAdminsHandler(req);

    expect(res.source).toBe('operatorAllowlist');
    expect(res.members.map((m) => m.uid)).toEqual(['op9', 'op8']);
    expect(res.members[0]?.displayName).toBe('Auntie Sam');
    expect(res.members[1]).toMatchObject({ uid: 'op8', hasStaffRecord: false });
    // THE POINT: reading the gate left the roster exactly as it found it.
    expect(ctx.writes.filter((w) => w.path === DOC)).toEqual([]);
  });

  it('reports the outage when nothing is configured at all', async () => {
    const ctx = buildDbMock({ docs: { [DOC]: { uids: [] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listBusinessAdminsHandler(req);

    expect(res.members).toEqual([]);
    expect(res.source).toBe('none');
    expect(res.reason).toContain('provisionBusinessAdmins');
    expect(ctx.writes.filter((w) => w.path === DOC)).toEqual([]);
  });

  it('reports the outage when the roster document does not exist', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listBusinessAdminsHandler(req);
    expect(res.source).toBe('none');
    expect(res.members).toEqual([]);
  });
});
