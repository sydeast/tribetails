import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock, HOUSEHOLD_GATE_SETTINGS_PATH } from './_helpers/mockDb';

/**
 * #1840: a visit notice goes only to a login that is a member of that
 * household, and the confirm is answered by the same check.
 *
 * Found on the Nov 10 walk: an unclaimed household's record carried the
 * Admin's own login in `kinfolk.uid`, so "On the way" told the Admin "the
 * household was notified" and emailed the notice to the Admin. These cases run
 * the callable over the REAL resolver and the REAL dispatcher.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), resolveKinCareRefFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/resolveKinCareRef', () => ({ resolveKinCareRef: mocks.resolveKinCareRefFn }));

import {
  dispatchVisitNotificationHandler,
  previewVisitNotificationHandler,
} from '../src/admin/dispatchVisitNotification';

const NOW = Date.UTC(2026, 10, 10, 23, 40, 0);
const VISIT_PATH = 'families/fam1/bookings/batch1/kinCares/visit1';
const ACTIVE_PRIMARY = { role: 'PRIMARY', status: 'ACTIVE' };

function tap(auth: { uid: string } = { uid: 'uid_admin' }) {
  return dispatchVisitNotificationHandler({
    data: { familyId: 'fam1', batchId: 'batch1', visitId: 'visit1', event: 'on_my_way', eventAtMs: NOW },
    auth: { uid: auth.uid, token: { name: 'Admin', admin: true } },
  } as never);
}

function preview(data: unknown = { familyId: 'fam1' }) {
  return previewVisitNotificationHandler({
    data,
    auth: { uid: 'uid_admin', token: { admin: true } },
  } as never);
}

let ctx: ReturnType<typeof buildDbMock>;

function seed(docs: Record<string, Record<string, unknown> | null>) {
  ctx = buildDbMock({
    writeThrough: true,
    docs: {
      [VISIT_PATH]: { serviceType: 'Dog Walk', scheduledAtMs: NOW, kinfolkId: 'fam1' },
      'families/fam1': { displayName: 'Household One' },
      'staff/uid_admin': { displayName: 'Admin' },
      'clients/uid_admin': { displayName: 'Admin' },
      'clients/uid_kinfolk': { displayName: 'Dre' },
      'clients/uid_other': { displayName: 'Other' },
      ...docs,
    },
  });
  mocks.dbFn.mockReset().mockReturnValue(ctx.db);
  mocks.resolveKinCareRefFn.mockReset().mockResolvedValue({
    ref: ctx.db.doc(VISIT_PATH),
    batchId: 'batch1',
    visitId: 'visit1',
  });
}

/** Every household-notification record written, whoever it was addressed to. */
function noticeWrites() {
  return ctx.writes.filter((w) => w.path.startsWith('notifications/'));
}
function recipients() {
  return noticeWrites().map((w) => w.data.recipientUid);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.logEventFn.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('dispatchVisitNotification: who receives (#1840)', () => {
  it('HAPPY: a member login is told', async () => {
    seed({ 'kinfolk/fam1': { uid: 'uid_kinfolk' }, 'families/fam1/members/uid_kinfolk': ACTIVE_PRIMARY });

    const res = await tap();

    expect(res).toMatchObject({ suppressed: false, reason: null });
    expect(recipients()).toEqual(['uid_kinfolk']);
  });

  it('SAD: a household nobody has claimed tells nobody, and says so', async () => {
    seed({ 'kinfolk/fam1': { uid: '' } });

    const res = await tap();

    expect(res).toEqual({ ok: true, dispatchIds: [], suppressed: true, reason: 'household_has_no_portal_account' });
    expect(noticeWrites()).toHaveLength(0);
  });

  it("NEGATIVE: the Admin's own login stored on an unclaimed household is not a recipient", async () => {
    // The walk: 0 members, and `kinfolk.uid` is the login of the Admin who is tapping.
    seed({ 'kinfolk/fam1': { uid: 'uid_admin' } });

    const res = await tap({ uid: 'uid_admin' });

    expect(res).toEqual({ ok: true, dispatchIds: [], suppressed: true, reason: 'household_has_no_portal_account' });
    expect(noticeWrites()).toHaveLength(0);
  });

  it('NEGATIVE: another staff login stored on the household is not a recipient either', async () => {
    seed({ 'kinfolk/fam1': { uid: 'uid_auntie' }, 'staff/uid_auntie': { displayName: 'TiTi' } });

    const res = await tap({ uid: 'uid_admin' });

    expect(res.reason).toBe('household_has_no_portal_account');
    expect(noticeWrites()).toHaveLength(0);
  });

  it('a staff person who really is a member of the household is told', async () => {
    seed({ 'kinfolk/fam1': { uid: 'uid_admin' }, 'families/fam1/members/uid_admin': ACTIVE_PRIMARY });

    const res = await tap({ uid: 'uid_admin' });

    expect(res).toMatchObject({ suppressed: false, reason: null });
    expect(recipients()).toEqual(['uid_admin']);
  });

  it("NEGATIVE: a second household's member never receives this household's notice", async () => {
    // `kinfolk/fam1.uid` names a login whose only membership is fam2.
    seed({
      'kinfolk/fam1': { uid: 'uid_other' },
      'families/fam2': { displayName: 'Household Two' },
      'kinfolk/fam2': { uid: 'uid_other' },
      'families/fam2/members/uid_other': ACTIVE_PRIMARY,
    });

    const res = await tap();

    expect(res.reason).toBe('household_has_no_portal_account');
    expect(noticeWrites()).toHaveLength(0);
    expect(recipients()).not.toContain('uid_other');
  });

  it('a staff login stored on a household that HAS been claimed does not silence it: the PRIMARY is told', async () => {
    seed({ 'kinfolk/fam1': { uid: 'uid_admin' }, 'families/fam1/members/uid_kinfolk': ACTIVE_PRIMARY });

    const res = await tap({ uid: 'uid_admin' });

    expect(res).toMatchObject({ suppressed: false, reason: null });
    expect(recipients()).toEqual(['uid_kinfolk']);
  });

  it('a removed member is not told, and neither is anyone in their place', async () => {
    seed({
      'kinfolk/fam1': { uid: 'uid_kinfolk' },
      'families/fam1/members/uid_kinfolk': { role: 'PRIMARY', status: 'SUSPENDED' },
    });

    expect((await tap()).reason).toBe('household_has_no_portal_account');
    expect(noticeWrites()).toHaveLength(0);
  });

  it('the gate is unchanged: a member login is not told while household notices are off', async () => {
    seed({
      'kinfolk/fam1': { uid: 'uid_kinfolk' },
      'families/fam1/members/uid_kinfolk': ACTIVE_PRIMARY,
      [HOUSEHOLD_GATE_SETTINGS_PATH]: { householdNotificationsLive: false },
    });

    const res = await tap();

    expect(res).toEqual({ ok: true, dispatchIds: [], suppressed: true, reason: 'household_notices_off' });
    expect(noticeWrites()).toHaveLength(0);
  });

  it('no member login is named before the switch when both apply', async () => {
    seed({
      'kinfolk/fam1': { uid: 'uid_admin' },
      [HOUSEHOLD_GATE_SETTINGS_PATH]: { householdNotificationsLive: false },
    });

    expect((await tap()).reason).toBe('household_has_no_portal_account');
  });
});

describe('previewVisitNotification: what the confirm may say (#1840)', () => {
  it('HAPPY: a member login and the switch on means the household will be told', async () => {
    seed({ 'kinfolk/fam1': { uid: 'uid_kinfolk' }, 'families/fam1/members/uid_kinfolk': ACTIVE_PRIMARY });

    expect(await preview()).toEqual({ ok: true, willNotify: true, reason: null });
  });

  it('SAD: nobody has claimed the household', async () => {
    seed({ 'kinfolk/fam1': { uid: '' } });

    expect(await preview()).toEqual({ ok: true, willNotify: false, reason: 'household_has_no_portal_account' });
  });

  it("NEGATIVE: the Admin's login on the household record is not a portal sign-in", async () => {
    seed({ 'kinfolk/fam1': { uid: 'uid_admin' } });

    expect(await preview()).toEqual({ ok: true, willNotify: false, reason: 'household_has_no_portal_account' });
  });

  it('household notices switched off', async () => {
    seed({
      'kinfolk/fam1': { uid: 'uid_kinfolk' },
      'families/fam1/members/uid_kinfolk': ACTIVE_PRIMARY,
      [HOUSEHOLD_GATE_SETTINGS_PATH]: { householdNotificationsLive: false },
    });

    expect(await preview()).toEqual({ ok: true, willNotify: false, reason: 'household_notices_off' });
  });

  it('agrees with the dispatch it previews, case by case', async () => {
    const cases: Array<Record<string, Record<string, unknown>>> = [
      { 'kinfolk/fam1': { uid: 'uid_kinfolk' }, 'families/fam1/members/uid_kinfolk': ACTIVE_PRIMARY },
      { 'kinfolk/fam1': { uid: '' } },
      { 'kinfolk/fam1': { uid: 'uid_admin' } },
      {
        'kinfolk/fam1': { uid: 'uid_kinfolk' },
        'families/fam1/members/uid_kinfolk': ACTIVE_PRIMARY,
        [HOUSEHOLD_GATE_SETTINGS_PATH]: { householdNotificationsLive: false },
      },
    ];
    for (const docs of cases) {
      seed(docs);
      const said = await preview();
      const did = await tap();
      expect({ willNotify: said.willNotify, reason: said.reason }).toEqual({
        willNotify: !did.suppressed,
        reason: did.reason,
      });
    }
  });

  it('writes nothing', async () => {
    seed({ 'kinfolk/fam1': { uid: 'uid_kinfolk' }, 'families/fam1/members/uid_kinfolk': ACTIVE_PRIMARY });

    await preview();

    expect(ctx.writes).toHaveLength(0);
  });

  it('ERROR: refuses a call that names no household', async () => {
    seed({});

    await expect(preview({ familyId: '' })).rejects.toThrow();
    await expect(preview({ familyId: '   ' })).rejects.toThrow();
    await expect(preview({})).rejects.toThrow();
  });
});
