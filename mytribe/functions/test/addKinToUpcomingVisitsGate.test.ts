import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

/**
 * #1822: the one `kincare.changed` that `addKinToUpcomingVisits` sends for a
 * Kin added to several visits goes through the REAL dispatcher here, so the
 * household send gate (`householdNotificationsLive`) is the one that decides.
 * `addKinToUpcomingVisits.test.ts` mocks `enqueueNotification` and cannot see
 * the gate; this file does not mock it.
 *
 * Gate shut: the household's copy is held, the office's copy and each Auntie's
 * `assignment.changed` still go. Gate open (the control): the household's copy
 * is written, so "held" above is the gate's doing and not a recipient that
 * never resolved.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEventFn: vi.fn(), resolveKinfolkUid: vi.fn() }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveKinfolkUid }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/writeAuditEntry', () => ({
  writeAuditEntry: vi.fn().mockResolvedValue('audit-1'),
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { ...actual.FieldValue, serverTimestamp: () => '__TS__' } };
});

import { addKinToUpcomingVisitsHandler } from '../src/admin/addKinToUpcomingVisits';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEventFn.mockReset();
  mocks.resolveKinfolkUid.mockReset().mockResolvedValue('uid-household');
});

function req(data: unknown): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: 'owner1', token: { admin: true } } as any,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const AHEAD = '2099-03-01T15:00:00Z';
const AHEAD_END = '2099-03-01T15:30:00Z';
const DAY_MS = 86_400_000;
const ts = (iso: string) => ({ toMillis: () => Date.parse(iso) });
const OLD_KIN = { kinIds: ['biscuit', 'mochi'], kinNames: ['Biscuit', 'Mochi'] };

type Docs = Record<string, Record<string, unknown> | null>;

/** Three confirmed visits for a household that has just adopted Pepper: two Ada's, one Bea's. */
function world(gateLive: boolean): Docs {
  const docs: Docs = {
    'business_settings/business_settings': { timeZone: 'America/Chicago', householdNotificationsLive: gateLive },
    'businessSettings/admins': { uids: ['owner1'] },
    'families/fam1/kin/biscuit': { name: 'Biscuit', legacyKinId: 'biscuit' },
    'families/fam1/kin/mochi': { name: 'Mochi', legacyKinId: 'mochi' },
    'families/fam1/kin/pep-card': { name: 'Pepper', legacyKinId: 'pepper' },
    'kin/biscuit': { name: 'Biscuit', kinfolkId: 'fam1' },
    'kin/mochi': { name: 'Mochi', kinfolkId: 'fam1' },
    'kin/pepper': { name: 'Pepper', kinfolkId: 'fam1' },
    'families/fam1/bookings/b_week': { familyId: 'fam1', envelopeStatus: 'confirmed', ...OLD_KIN },
  };
  for (let i = 0; i < 3; i++) {
    const start = new Date(Date.parse(AHEAD) + i * DAY_MS).toISOString();
    const end = new Date(Date.parse(AHEAD_END) + i * DAY_MS).toISOString();
    const id = `v${i}`;
    docs[`families/fam1/bookings/b_week/kinCares/${id}`] = {
      familyId: 'fam1',
      status: 'confirmed',
      startTime: ts(start),
      endTime: ts(end),
      sessionId: `vis_${id}`,
      assignedAuntieUid: i < 2 ? 'ada' : 'bea',
      serviceName: 'Drop-in',
      ...OLD_KIN,
    };
    docs[`kin_care_sessions/vis_${id}`] = {
      kinfolkId: 'fam1',
      status: 'SCHEDULED',
      startTime: start,
      endTime: end,
      kinCareBatchId: 'b_week',
      kinCareVisitId: id,
      ...OLD_KIN,
    };
  }
  return docs;
}

function mockFrom(docs: Docs) {
  const queryDocs: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = {};
  const kinCares: Array<{ id: string; path: string; data: Record<string, unknown> }> = [];
  for (const [path, data] of Object.entries(docs)) {
    if (data == null) continue;
    const segs = path.split('/');
    if (segs.length === 6 && segs[4] === 'kinCares') {
      kinCares.push({ id: segs[5]!, path, data });
      continue;
    }
    const col = segs.slice(0, -1).join('/');
    (queryDocs[col] ??= []).push({ id: segs[segs.length - 1]!, data });
  }
  const ctx = buildDbMock({ docs, queryDocs, collectionGroupDocs: { kinCares }, writeThrough: true });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

/** The notification records written, as `{ key, recipientUid }`. */
function delivered(ctx: ReturnType<typeof buildDbMock>): Array<{ key: string; recipientUid: string }> {
  return ctx.writes
    .filter((w) => /^(notifications|scheduledNotifications)\//.test(w.path))
    .map((w) => ({ key: String(w.data['key'] ?? w.data['notificationKey'] ?? ''), recipientUid: String(w.data['recipientUid'] ?? '') }));
}

const gatedEvents = () =>
  mocks.logEventFn.mock.calls.map((c) => c[0]).filter((e: { event: string }) => e.event === 'notification.gated.household');

describe('addKinToUpcomingVisits: the household send gate', () => {
  it('GATE SHUT: the household copy is held; the office copy and each Auntie copy still go', async () => {
    const ctx = mockFrom(world(false));

    const res = await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }));

    expect(res.added).toBe(3);
    const gated = gatedEvents();
    expect(gated, 'exactly the one household copy is held').toHaveLength(1);
    expect(gated[0]).toMatchObject({ uid: 'uid-household', extra: { key: 'kincare.changed', gateState: 'off' } });
    const out = delivered(ctx);
    expect(out.filter((d) => d.recipientUid === 'uid-household'), 'nothing reaches the household').toEqual([]);
    expect(out).toEqual(
      expect.arrayContaining([
        { key: 'kincare.changed', recipientUid: 'owner1' },
        { key: 'assignment.changed', recipientUid: 'ada' },
        { key: 'assignment.changed', recipientUid: 'bea' },
      ]),
    );
    expect(out.filter((d) => d.key === 'kincare.changed'), 'one office copy for the whole change').toHaveLength(1);
    expect(out.filter((d) => d.key === 'assignment.changed'), 'one copy per Auntie').toHaveLength(2);
  });

  it('GATE OPEN (control): the same call writes the household copy too', async () => {
    const ctx = mockFrom(world(true));

    const res = await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }));

    expect(res.added).toBe(3);
    expect(gatedEvents()).toEqual([]);
    const out = delivered(ctx);
    expect(out).toEqual(expect.arrayContaining([{ key: 'kincare.changed', recipientUid: 'uid-household' }]));
    expect(out.filter((d) => d.key === 'kincare.changed')).toHaveLength(2);
  });
});
