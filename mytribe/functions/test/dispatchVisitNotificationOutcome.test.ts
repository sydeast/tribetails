import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock, HOUSEHOLD_GATE_SETTINGS_PATH } from './_helpers/mockDb';

/**
 * #1794: a visit notification that reaches nobody says why, and never throws.
 *
 * Found on the Nov 10 walk: every Auntie Time tap on a household with no portal
 * sign-in logged `dispatchVisitNotification.failure` ("has no primaryUid,
 * cannot route notification") and reached Sentry, while the switch that holds
 * household notices back was off as well. These cases run the callable over the
 * REAL dispatcher, the same way `dispatchVisitNotificationIdentity.test.ts`
 * does, so the reason is read off what the dispatcher actually did.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), resolveKinCareRefFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/resolveKinCareRef', () => ({ resolveKinCareRef: mocks.resolveKinCareRefFn }));

import {
  dispatchVisitNotificationHandler,
  visitNoticeReasonFor,
} from '../src/admin/dispatchVisitNotification';

const NOW = Date.UTC(2026, 10, 10, 15, 0, 0);
const VISIT_PATH = 'families/fam1/bookings/batch1/kinCares/visit1';

function tap(data: Record<string, unknown> = {}) {
  return dispatchVisitNotificationHandler({
    data: { familyId: 'fam1', batchId: 'batch1', visitId: 'visit1', event: 'on_my_way', eventAtMs: NOW, ...data },
    auth: { uid: 'uid_auntie', token: { name: 'TiTi' } },
  } as never);
}

let ctx: ReturnType<typeof buildDbMock>;

function seed(docs: Record<string, Record<string, unknown> | null>) {
  ctx = buildDbMock({
    writeThrough: true,
    docs: {
      [VISIT_PATH]: { serviceType: 'Dog Walk', scheduledAtMs: NOW, kinfolkId: 'fam1' },
      'staff/uid_auntie': { displayName: 'TiTi' },
      'clients/uid_kinfolk': { displayName: 'Dre' },
      // #1840: a login is a household's only when it is an ACTIVE member.
      'families/fam1/members/uid_kinfolk': { role: 'PRIMARY', status: 'ACTIVE' },
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

function householdWrites() {
  return ctx.writes.filter((w) => w.path.startsWith('notifications/') && w.data.recipientUid === 'uid_kinfolk');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.logEventFn.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a household with no portal account (#1794)', () => {
  it('returns a named skip instead of throwing, and writes nothing', async () => {
    seed({ 'families/fam1': { primaryUid: '', displayName: 'Dre East' }, 'kinfolk/fam1': { uid: '' } });

    const res = await tap();

    expect(res).toEqual({
      ok: true,
      dispatchIds: [],
      suppressed: true,
      reason: 'household_has_no_portal_account',
    });
    expect(householdWrites()).toHaveLength(0);
  });

  it('logs the skip at info, never as a failure', async () => {
    seed({ 'families/fam1': { displayName: 'Dre East' } });

    await tap();

    const skip = mocks.logEventFn.mock.calls.map((c) => c[0]).find((e) => e.event === 'visit.notification.skipped');
    expect(skip).toMatchObject({ severity: 'info', extra: { reason: 'household_has_no_portal_account' } });
  });

  it('is named for that even when the household-notices switch is also off', async () => {
    // Dre East on Nov 10: no account AND the switch off. One order, shared with
    // both clients' confirm text: no account first.
    seed({
      'families/fam1': { primaryUid: '', displayName: 'Dre East' },
      [HOUSEHOLD_GATE_SETTINGS_PATH]: { householdNotificationsLive: false },
    });

    const res = await tap({ event: 'arrived' });

    expect(res.reason).toBe('household_has_no_portal_account');
  });
});

describe('routing to the household login', () => {
  it('routes to the kinfolk record login (the family envelope primaryUid is blank on every sign-up)', async () => {
    // No sign-up path fills `families/{id}.primaryUid`; the portal login lives
    // on `kinfolk/{id}.uid` (onClientsWrite backwrite).
    seed({ 'families/fam1': { primaryUid: '', displayName: 'Dre East' }, 'kinfolk/fam1': { uid: 'uid_kinfolk' } });

    const res = await tap();

    expect(res).toMatchObject({ suppressed: false, reason: null });
    expect(res.dispatchIds).toHaveLength(1);
    expect(householdWrites()).toHaveLength(1);
  });

  it('ignores a primaryUid left behind on a household whose login was revoked', async () => {
    // `revokeKinfolkClaim` blanks `kinfolk.uid` and never touches `primaryUid`.
    seed({
      'families/fam1': { primaryUid: 'uid_kinfolk', displayName: 'The Rileys' },
      'kinfolk/fam1': { uid: '' },
    });

    const res = await tap();

    expect(res.reason).toBe('household_has_no_portal_account');
    expect(householdWrites()).toHaveLength(0);
  });
});

describe('suppressions are named, not folded into one', () => {
  it('household_notices_off when the switch is off', async () => {
    seed({
      'families/fam1': { displayName: 'The Rileys' },
      'kinfolk/fam1': { uid: 'uid_kinfolk' },
      [HOUSEHOLD_GATE_SETTINGS_PATH]: { householdNotificationsLive: false },
    });

    const res = await tap();

    expect(res).toEqual({ ok: true, dispatchIds: [], suppressed: true, reason: 'household_notices_off' });
    expect(householdWrites()).toHaveLength(0);
  });

  it('household_notices_off when the switch has never been set', async () => {
    seed({ 'families/fam1': {}, 'kinfolk/fam1': { uid: 'uid_kinfolk' }, [HOUSEHOLD_GATE_SETTINGS_PATH]: {} });

    expect((await tap()).reason).toBe('household_notices_off');
  });

  it('already_notified for a retry of the same tap', async () => {
    seed({ 'families/fam1': {}, 'kinfolk/fam1': { uid: 'uid_kinfolk' } });

    expect((await tap()).reason).toBeNull();
    vi.setSystemTime(NOW + 30_000);
    expect(await tap()).toMatchObject({ suppressed: true, reason: 'already_notified' });
  });
});

describe('visitNoticeReasonFor', () => {
  it('is null when anything was written', () => {
    expect(visitNoticeReasonFor({ written: ['n1'], suppressed: [{ recipientUid: 'u', reason: 'gate' }] })).toBeNull();
  });

  it('names the gate before prefs and duplicate', () => {
    expect(
      visitNoticeReasonFor({
        written: [],
        suppressed: [
          { recipientUid: 'a', reason: 'duplicate' },
          { recipientUid: 'b', reason: 'prefs' },
          { recipientUid: 'c', reason: 'gate' },
        ],
      }),
    ).toBe('household_notices_off');
  });

  it('names prefs before duplicate', () => {
    expect(
      visitNoticeReasonFor({
        written: [],
        suppressed: [
          { recipientUid: 'a', reason: 'duplicate' },
          { recipientUid: 'b', reason: 'prefs' },
        ],
      }),
    ).toBe('household_prefs_suppressed');
  });

  it('is no_recipient when nobody was resolved at all', () => {
    expect(visitNoticeReasonFor({ written: [], suppressed: [] })).toBe('no_recipient');
  });
});
