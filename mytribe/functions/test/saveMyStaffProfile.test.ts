import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
// This suite drives the handler through the staff wrapper, which checks session
// revocation. Stub it out, see test/_helpers/mockSessionRevocation.ts.
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('a1') }));

import { saveMyStaffProfileHandler } from '../src/admin/saveMyStaffProfile';
import { wrapAdminCallable } from '../src/lib/wrapAdminCallable';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';
import { logEvent } from '../src/lib/logger';

const save = wrapAdminCallable('saveMyStaffProfile', saveMyStaffProfileHandler);

const auntie = { uid: 'auntie-1', token: { staffRole: 'auntie' } };
const owner = { uid: 'owner-1', token: { admin: true } };

function form(over: Record<string, unknown> = {}) {
  return {
    displayName: 'Auntie Nora',
    firstName: 'Nora',
    lastName: 'Brooks',
    phone: '555-0100',
    title: 'Auntie',
    bio: 'Loves dogs.',
    ...over,
  };
}

/**
 * The Activity Log lines the handler itself wrote. The wrapper files its own
 * line for every refusal, which is not what these cases are about.
 */
function profileLines() {
  return (writeAuditEntry as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => c[0] as { event: string })
    .filter((entry) => entry.event === 'PROFILE_UPDATED');
}
/** `auth: null` is a signed-out caller. */
function call(data: unknown, auth: unknown = auntie) {
  return save({ data, auth: auth ?? undefined } as never);
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue('a1');
  (logEvent as ReturnType<typeof vi.fn>).mockClear();
  process.env.AUNTIE_OPERATOR_UIDS = '';
});

/**
 * #2287: a staff member saves her own Account profile. The record written is
 * the caller's, the fields are the name (three parts), phone, title and bio,
 * and nothing else on the record can be reached through it.
 */
describe('saveMyStaffProfile', () => {
  it('HAPPY: an Auntie saves her name, phone, title and bio on her own record', async () => {
    const ctx = buildDbMock({
      docs: {
        'users/auntie-1': {
          displayName: 'Nora',
          photoUrl: 'https://cdn/me.jpg',
          dashboardWidgets: ['supplies:wide'],
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await call(form({ displayName: '  Auntie Nora  ' }));

    expect(res.ok).toBe(true);
    expect(res.profile).toEqual(form());
    expect(ctx.writes).toHaveLength(1);
    const write = ctx.writes[0]!;
    expect(write.path).toBe('users/auntie-1');
    expect(write.merge).toBe(true);
    // The six fields and the stamp, and no other key: a merge write of exactly
    // these cannot touch her photo, her Home layout or anything else.
    expect(Object.keys(write.data).sort()).toEqual(
      ['bio', 'displayName', 'firstName', 'lastName', 'phone', 'title', 'updatedAt'],
    );
    expect(write.data.displayName).toBe('Auntie Nora');
    expect(typeof write.data.updatedAt).toBe('string');
  });

  it('HAPPY: the Activity Log line names her as the Auntie and the fields, never the values', async () => {
    const ctx = buildDbMock({ docs: { 'users/auntie-1': form({ phone: '555-0199', bio: '' }) } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await call(form());

    expect(res.changed).toEqual(['phone', 'bio']);
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const entry = (writeAuditEntry as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(entry).toMatchObject({
      event: 'PROFILE_UPDATED',
      status: 'SUCCESS',
      actorUid: 'auntie-1',
      targetUid: 'auntie-1',
      targetCollection: 'users',
      description: 'Account profile updated: phone, bio',
      payload: { fields: ['phone', 'bio'], admin: false, staffRole: 'auntie' },
    });
    expect(JSON.stringify(entry)).not.toContain('555-0100');
    expect(JSON.stringify(entry)).not.toContain('Loves dogs');
  });

  it('HAPPY: an Auntie with no record yet gets one', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    await call(form());
    expect(ctx.writes.map((w) => w.path)).toEqual(['users/auntie-1']);
  });

  it('HAPPY: the owner can save through it too, and the line says so', async () => {
    const ctx = buildDbMock({ docs: { 'users/owner-1': form({ title: 'Owner' }) } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await call(form({ title: 'Head of Care' }), owner);

    expect(ctx.writes.map((w) => w.path)).toEqual(['users/owner-1']);
    const entry = (writeAuditEntry as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(entry.payload).toEqual({ fields: ['title'], admin: true, staffRole: null });
  });

  it('HAPPY: saving what is already stored writes nothing and logs nothing', async () => {
    const ctx = buildDbMock({ docs: { 'users/auntie-1': form() } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await call(form());

    expect(res).toEqual({ ok: true, profile: form(), changed: [] });
    expect(ctx.writes).toHaveLength(0);
    expect(profileLines()).toHaveLength(0);
  });

  it('SAD: a blank display name is refused in a sentence, and nothing is written', async () => {
    const ctx = buildDbMock({ docs: { 'users/auntie-1': form() } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(call(form({ displayName: '   ' }))).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'Enter a display name.',
    });
    expect(ctx.writes).toHaveLength(0);
    expect(profileLines()).toHaveLength(0);
  });

  it('SAD: a value past its limit is refused in a sentence that names the field', async () => {
    const ctx = buildDbMock({ docs: { 'users/auntie-1': form() } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(call(form({ bio: 'x'.repeat(2001) }))).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'Bio can be at most 2,000 characters.',
    });
    await expect(call(form({ phone: '5'.repeat(41) }))).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'Phone can be at most 40 characters.',
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('SAD: a missing field or a non-text value is refused', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { bio: _bio, ...noBio } = form();

    await expect(call(noBio)).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(call(form({ phone: 5550100 }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(call(null)).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('NEGATIVE: an Auntie naming another uid is refused, and neither record is written', async () => {
    const ctx = buildDbMock({
      docs: { 'users/auntie-1': form(), 'users/owner-1': form({ displayName: 'The Owner' }) },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    for (const key of ['uid', 'userId', 'entityId', 'targetUid']) {
      await expect(call({ ...form({ displayName: 'Changed' }), [key]: 'owner-1' })).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    }
    expect(ctx.writes).toHaveLength(0);
    expect(profileLines()).toHaveLength(0);
  });

  it('NEGATIVE: a field outside the profile fields is refused, on her own record too', async () => {
    const ctx = buildDbMock({ docs: { 'users/auntie-1': form() } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const outside: Record<string, unknown> = {
      photoUrl: 'https://cdn/other.jpg',
      email: 'catch@hanasamku.com',
      role: 'admin',
      admin: true,
      staffRole: 'owner',
      dashboardWidgets: ['cashFlow:wide'],
      kinfolkIds: ['fam1'],
    };
    for (const [key, value] of Object.entries(outside)) {
      await expect(call({ ...form({ title: 'Changed' }), [key]: value })).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    }
    expect(ctx.writes).toHaveLength(0);
  });

  it('NEGATIVE: a household account, a stranger and a signed-out caller are refused', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(call(form(), { uid: 'kin-1', token: { role: 'kinfolk', kinfolkId: 'kf1' } }))
      .rejects.toMatchObject({ code: 'permission-denied' });
    await expect(call(form(), { uid: 'stranger', token: {} })).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(call(form(), null)).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('ERROR: a database failure on the write surfaces, with no Activity Log line', async () => {
    const ctx = buildDbMock({ docs: { 'users/auntie-1': form({ title: 'Old' }) } });
    const failing = {
      collection: () => ({
        doc: () => ({
          get: () => ctx.db.collection('users').doc('auntie-1').get(),
          set: async () => {
            throw new Error('firestore unavailable');
          },
        }),
      }),
    };
    mocks.dbFn.mockReturnValue(failing);

    await expect(call(form())).rejects.toBeTruthy();
    expect(profileLines()).toHaveLength(0);
  });

  it('ERROR: a failed Activity Log write does not report the saved profile as failed', async () => {
    const ctx = buildDbMock({ docs: { 'users/auntie-1': form({ title: 'Old' }) } });
    mocks.dbFn.mockReturnValue(ctx.db);
    (writeAuditEntry as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('chain busy'));

    const res = await call(form());

    expect(res.ok).toBe(true);
    expect(ctx.writes).toHaveLength(1);
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error', event: 'admin.staffProfile.auditFailed' }),
    );
  });
});
