import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { previewBroadcastAudienceHandler } from '../src/admin/previewBroadcastAudience';

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return { data, auth: uid ? ({ uid, token: { admin: true } } as any) : undefined } as unknown as CallableRequest<unknown>;
}

const kinfolk = [
  { id: 'k1', data: { status: 'active', firstName: 'Dana', email: 'catch@hanasamku.com', phoneNumber: '+14155552671', uid: 'u1' } },
  { id: 'k2', data: { status: 'active', firstName: '', email: '', phoneNumber: '+14155559999', uid: '' } },
  { id: 'k3', data: { status: 'prospect', firstName: 'Sam', email: 'pawsome@hanasamku.com', phoneNumber: '', uid: '' } },
  { id: 'k4', data: { status: 'archived', firstName: 'Old', email: 'x@hanasamku.com' } },
];

/** #2482: k1's stored login joined the household, so it has a MyTribe account. */
const JOINED = { 'families/k1/members/u1': { role: 'PRIMARY', status: 'ACTIVE' } };

beforeEach(() => mocks.dbFn.mockReset());

describe('previewBroadcastAudience (#1610)', () => {
  it('counts the households the send will target, never an archived one', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: { ...JOINED }, queryDocs: { kinfolk } }).db);
    const res = await previewBroadcastAudienceHandler(req({ criteria: { kind: 'all' } }));
    expect(res).toEqual({
      ok: true,
      description: 'All active kinfolk',
      targeted: 3,
      withEmail: 2,
      withPhone: 2,
      withApp: 1,
      withoutFirstName: 1,
    });
  });

  it('follows a status audience', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ queryDocs: { kinfolk } }).db);
    const res = await previewBroadcastAudienceHandler(req({ criteria: { kind: 'status', statuses: ['prospect'] } }));
    expect(res.targeted).toBe(1);
    expect(res.description).toBe('Status: prospect');
  });

  it('reads a saved segment', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        docs: { 'audience_segments/s1': { criteria: { kind: 'status', statuses: ['active'] } } },
        queryDocs: { kinfolk },
      }).db,
    );
    expect((await previewBroadcastAudienceHandler(req({ segmentId: 's1' }))).targeted).toBe(2);
  });

  it('writes nothing', async () => {
    const ctx = buildDbMock({ queryDocs: { kinfolk } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await previewBroadcastAudienceHandler(req({ criteria: { kind: 'all' } }));
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses a call with no audience, and an unsigned caller', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ queryDocs: { kinfolk } }).db);
    await expect(previewBroadcastAudienceHandler(req({}))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(previewBroadcastAudienceHandler(req({ criteria: { kind: 'all' } }, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  // #2482: "with the app" is the member check the send makes, not the stored login.
  it('does not count a household whose stored login never joined it (a staff login)', async () => {
    const staffKinfolk = [
      { id: 'k1', data: { status: 'active', firstName: 'Dana', email: '', phoneNumber: '', uid: 'u1' } },
      { id: 'k5', data: { status: 'active', firstName: 'Ash', email: '', phoneNumber: '', uid: 'staff1' } },
    ];
    mocks.dbFn.mockReturnValue(
      buildDbMock({ docs: { ...JOINED, 'staff/staff1': { role: 'admin' } }, queryDocs: { kinfolk: staffKinfolk } }).db,
    );
    const res = await previewBroadcastAudienceHandler(req({ criteria: { kind: 'all' } }));
    expect(res.targeted).toBe(2);
    expect(res.withApp).toBe(1);
  });

  it('a member check that cannot be read is not counted as an account', async () => {
    const ctx = buildDbMock({ docs: { ...JOINED }, queryDocs: { kinfolk } });
    const doc = ctx.db.doc;
    ctx.db.doc = (path: string) =>
      path.startsWith('families/') ? { get: async () => { throw new Error('14 UNAVAILABLE'); } } : doc(path);
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await previewBroadcastAudienceHandler(req({ criteria: { kind: 'all' } }));
    expect(res.targeted).toBe(3);
    expect(res.withApp).toBe(0);
  });

  it('a missing segment is not-found', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ queryDocs: { kinfolk } }).db);
    await expect(previewBroadcastAudienceHandler(req({ segmentId: 'nope' }))).rejects.toMatchObject({ code: 'not-found' });
  });
});
