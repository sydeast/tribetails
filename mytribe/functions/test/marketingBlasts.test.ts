import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

/**
 * Marketing blasts: the 2026-09-12 audience-criteria change plus the read and
 * cancel callables the screen needs.
 *
 * The dispatcher is mocked, because what is under test here is the AUDIENCE
 * (who gets enqueued and who is reported as unreachable), not the notification
 * fan-out, which `dispatcher.test.ts` already owns. The prefs module is mocked
 * per-uid so the opt-in gate can be exercised without building a whole
 * catalog + business-override fixture: `resolveChannels` is the real function in
 * `broadcastMessage.test.ts`, and duplicating that here would test zod twice
 * and the audience never.
 */

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  enqueue: vi.fn(),
  loadUserPrefs: vi.fn(),
  loadBusinessOverride: vi.fn(),
  resolveChannels: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('../src/notifications/prefs', () => ({
  loadUserPrefs: mocks.loadUserPrefs,
  loadBusinessOverride: mocks.loadBusinessOverride,
  resolveChannels: mocks.resolveChannels,
  streamForRecipient: () => 'kinfolk',
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { scheduleMarketingBlastHandler } from '../src/admin/scheduleMarketingBlast';
import {
  previewMarketingBlastAudienceHandler,
  listMarketingBlastsHandler,
  cancelMarketingBlastHandler,
  blastStatus,
} from '../src/admin/marketingBlasts';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
  mocks.loadUserPrefs.mockReset().mockResolvedValue({});
  mocks.loadBusinessOverride.mockReset().mockResolvedValue(null);
  // Default: everybody is opted in. Individual tests opt a uid out.
  mocks.resolveChannels.mockReset().mockReturnValue({ email: true, sms: false, push: false });
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return { data, auth: uid ? ({ uid, token: { admin: true } } as any) : undefined } as unknown as CallableRequest<unknown>;
}

/**
 * Four kinfolk: two active with linked accounts, one active VIP with NO linked
 * account (the `noLinkedAccount` case), one archived (never matched, by
 * `matchesCriteria`'s own rule).
 */
function kinfolkDb(extra: Parameters<typeof buildDbMock>[0] = {}) {
  return buildDbMock({
    queryDocs: {
      kinfolk: [
        { id: 'k1', data: { status: 'active', tags: ['vip'], uid: 'u1' } },
        { id: 'k2', data: { status: 'active', tags: [], uid: 'u2' } },
        { id: 'k3', data: { status: 'active', tags: ['vip'], uid: '' } },
        { id: 'k4', data: { status: 'archived', tags: ['vip'], uid: 'u4' } },
      ],
      ...(extra.queryDocs ?? {}),
    },
    docs: extra.docs ?? {},
  });
}

const baseBlast = (over: Record<string, unknown> = {}) => ({
  key: 'newsletter.announcement',
  fireAtMs: Date.now() + HOUR,
  data: { subject: 'Sample' },
  ...over,
});

// ── the criteria change ──────────────────────────────────────────────────────

describe('scheduleMarketingBlast audience criteria', () => {
  it('resolves inline criteria to the linked accounts and reports the households with none', async () => {
    const ctx = kinfolkDb();
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await scheduleMarketingBlastHandler(req(baseBlast({ criteria: { kind: 'all' } })));

    expect(res.ok).toBe(true);
    // k1, k2, k3 match ('all' excludes the archived k4); k3 has no uid.
    expect(res.matched).toBe(3);
    expect(res.noLinkedAccount).toBe(1);
    expect(res.dispatched).toBe(2);
    expect(mocks.enqueue.mock.calls.map((c) => c[0].recipientUid)).toEqual(['u1', 'u2']);
  });

  it('resolves a tags criteria, so only the tagged household is enqueued', async () => {
    const ctx = kinfolkDb();
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await scheduleMarketingBlastHandler(
      req(baseBlast({ criteria: { kind: 'tags', tags: ['vip'], tagMatch: 'any' } })),
    );

    expect(res.matched).toBe(2); // k1 and k3; the archived k4 is excluded even though it is tagged
    expect(res.noLinkedAccount).toBe(1);
    expect(mocks.enqueue.mock.calls.map((c) => c[0].recipientUid)).toEqual(['u1']);
  });

  it('loads the stored criteria of a saved segment', async () => {
    const ctx = kinfolkDb({
      docs: { 'audience_segments/seg1': { name: 'VIPs', criteria: { kind: 'tags', tags: ['vip'], tagMatch: 'any' } } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await scheduleMarketingBlastHandler(req(baseBlast({ segmentId: 'seg1' })));

    expect(res.matched).toBe(2);
    expect(res.dispatched).toBe(1);
  });

  it('rejects a segmentId that does not exist rather than blasting nobody quietly', async () => {
    const ctx = kinfolkDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(scheduleMarketingBlastHandler(req(baseBlast({ segmentId: 'nope' })))).rejects.toThrow(
      /does not exist/,
    );
  });

  it('still accepts an explicit uid list, the pre-change shape', async () => {
    const ctx = kinfolkDb();
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await scheduleMarketingBlastHandler(req(baseBlast({ audienceUids: ['uA', 'uB', 'uA'] })));

    // De-duped: the same account must not be scheduled the same blast twice.
    expect(res.matched).toBe(2);
    expect(mocks.enqueue.mock.calls.map((c) => c[0].recipientUid)).toEqual(['uA', 'uB']);
  });

  it('refuses two audience paths at once instead of letting handler precedence pick', async () => {
    const ctx = kinfolkDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      scheduleMarketingBlastHandler(req(baseBlast({ criteria: { kind: 'all' }, audienceUids: ['uA'] }))),
    ).rejects.toThrow(/validation failed/);
  });

  it('refuses an audience with no path at all, which would otherwise have to default to everyone', async () => {
    const ctx = kinfolkDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(scheduleMarketingBlastHandler(req(baseBlast()))).rejects.toThrow(/validation failed/);
  });

  it('refuses a criteria that resolves to nobody', async () => {
    const ctx = buildDbMock({ queryDocs: { kinfolk: [{ id: 'k1', data: { status: 'archived', uid: 'u1' } }] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      scheduleMarketingBlastHandler(req(baseBlast({ criteria: { kind: 'all' } }))),
    ).rejects.toThrow(/no_recipients/);
  });

  it('refuses a fire time in the past', async () => {
    const ctx = kinfolkDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      scheduleMarketingBlastHandler(req(baseBlast({ criteria: { kind: 'all' }, fireAtMs: Date.now() - HOUR }))),
    ).rejects.toThrow(/fireAtMs is in the past/);
  });

  it('refuses an unknown campaign key', async () => {
    const ctx = kinfolkDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      scheduleMarketingBlastHandler(req(baseBlast({ key: 'invoice.new', criteria: { kind: 'all' } }))),
    ).rejects.toThrow(/validation failed/);
  });

  it('refuses an unauthenticated caller', async () => {
    await expect(
      scheduleMarketingBlastHandler(req(baseBlast({ criteria: { kind: 'all' } }), null)),
    ).rejects.toThrow(/Sign-in required/);
  });
});

describe('scheduleMarketingBlast blast row', () => {
  it('writes the row BEFORE the fan-out and stamps its id onto every scheduled copy', async () => {
    const ctx = kinfolkDb();
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await scheduleMarketingBlastHandler(
      req(baseBlast({ criteria: { kind: 'all' }, title: 'June newsletter' })),
    );

    const created = ctx.writes.find((w) => w.path.startsWith('marketingBlasts/') && w.data.key !== undefined);
    expect(created).toBeDefined();
    expect(created!.data.title).toBe('June newsletter');
    expect(created!.data.audienceDescription).toBe('All active kinfolk');
    expect(created!.data.cancelledAt).toBeNull();
    for (const call of mocks.enqueue.mock.calls) {
      expect(call[0].data.blastId).toBe(res.blastId);
      expect(call[0].data.audienceUid).toBe(call[0].recipientUid);
    }
  });

  it('counts a dispatcher suppression apart from a dispatcher failure', async () => {
    const ctx = kinfolkDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockReset();
    mocks.enqueue.mockResolvedValueOnce([]); // u1: opted out, dispatcher wrote nothing
    mocks.enqueue.mockRejectedValueOnce(new Error('boom')); // u2: enqueue threw

    const res = await scheduleMarketingBlastHandler(req(baseBlast({ criteria: { kind: 'all' } })));

    expect(res.dispatched).toBe(0);
    expect(res.suppressed).toBe(1);
    expect(res.failed).toBe(1);
  });

  it('writes an audit entry naming the audience', async () => {
    const ctx = kinfolkDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    await scheduleMarketingBlastHandler(req(baseBlast({ criteria: { kind: 'all' } })));
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const entry = (writeAuditEntry as any).mock.calls[0][0];
    expect(entry.event).toBe('MARKETING_BLAST_SCHEDULED');
    expect(entry.description).toContain('All active kinfolk');
  });
});

// ── preview ──────────────────────────────────────────────────────────────────

describe('previewMarketingBlastAudience', () => {
  it('reports matched, unlinked, opted-out and reachable as four counted facts', async () => {
    const ctx = kinfolkDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    // u1 is opted in; u2 never opted into marketing, so every channel is off.
    mocks.resolveChannels.mockReset().mockImplementation((_def, prefs: any) =>
      prefs?.optedIn ? { email: true, sms: false, push: false } : { email: false, sms: false, push: false },
    );
    mocks.loadUserPrefs.mockReset().mockImplementation(async (uid: string) => (uid === 'u1' ? { optedIn: true } : {}));

    const res = await previewMarketingBlastAudienceHandler(
      req({ key: 'newsletter.announcement', criteria: { kind: 'all' } }),
    );

    expect(res).toMatchObject({
      ok: true,
      description: 'All active kinfolk',
      matched: 3,
      noLinkedAccount: 1,
      suppressedByPrefs: 1,
      reachable: 1,
    });
  });

  it('returns zero rather than throwing when the selection reaches nobody', async () => {
    const ctx = buildDbMock({ queryDocs: { kinfolk: [{ id: 'k1', data: { status: 'archived', uid: 'u1' } }] } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await previewMarketingBlastAudienceHandler(
      req({ key: 'survey.event', criteria: { kind: 'all' } }),
    );

    expect(res.matched).toBe(0);
    expect(res.reachable).toBe(0);
  });

  it('writes nothing', async () => {
    const ctx = kinfolkDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    await previewMarketingBlastAudienceHandler(req({ key: 'marketing.optin', criteria: { kind: 'all' } }));
    expect(ctx.writes).toHaveLength(0);
    expect(ctx.adds).toHaveLength(0);
  });

  it('refuses an unauthenticated caller', async () => {
    await expect(
      previewMarketingBlastAudienceHandler(req({ key: 'survey.event', criteria: { kind: 'all' } }, null)),
    ).rejects.toThrow(/Sign-in required/);
  });
});

// ── list ─────────────────────────────────────────────────────────────────────

describe('blastStatus', () => {
  it('derives scheduled / sent / cancelled from the fire time and the cancel stamp', () => {
    expect(blastStatus(2000, null, 1000)).toBe('scheduled');
    expect(blastStatus(500, null, 1000)).toBe('sent');
    expect(blastStatus(2000, 900, 1000)).toBe('cancelled');
    // Cancelled wins even for a row whose fire time has since passed.
    expect(blastStatus(500, 400, 1000)).toBe('cancelled');
  });
});

describe('listMarketingBlasts', () => {
  it('returns rows newest fire time first with a derived status', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        marketingBlasts: [
          {
            id: 'b1',
            data: { key: 'newsletter.announcement', title: 'Past', fireAtMs: Date.now() - HOUR, matched: 4, dispatched: 3, suppressed: 1, createdAtMs: 1 },
          },
          {
            id: 'b2',
            data: { key: 'survey.event', title: 'Future', fireAtMs: Date.now() + HOUR, matched: 2, dispatched: 2, suppressed: 0, createdAtMs: 2 },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listMarketingBlastsHandler(req({}));

    expect(res.blasts.map((b) => b.id)).toEqual(['b2', 'b1']);
    expect(res.blasts[0].status).toBe('scheduled');
    expect(res.blasts[1].status).toBe('sent');
  });

  it('reads a pre-change row through its old audienceCount field rather than reporting zero', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        marketingBlasts: [
          { id: 'old', data: { key: 'marketing.optin', fireAtMs: 10, audienceCount: 7, dispatched: 7 } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listMarketingBlastsHandler(req({}));
    expect(res.blasts[0].matched).toBe(7);
  });

  it('refuses an unauthenticated caller', async () => {
    await expect(listMarketingBlastsHandler(req({}, null))).rejects.toThrow(/Sign-in required/);
  });
});

// ── cancel ───────────────────────────────────────────────────────────────────

describe('cancelMarketingBlast', () => {
  function cancelDb(blast: Record<string, unknown>, queued: string[]) {
    return buildDbMock({
      docs: { 'marketingBlasts/b1': blast },
      queryDocs: {
        scheduledNotifications: queued.map((id) => ({ id, data: { data: { blastId: 'b1' } } })),
      },
    });
  }

  it('deletes every queued copy and stamps the row', async () => {
    const ctx = cancelDb({ key: 'newsletter.announcement', fireAtMs: Date.now() + HOUR }, ['s1', 's2']);
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await cancelMarketingBlastHandler(req({ blastId: 'b1' }));

    expect(res.cancelled).toBe(2);
    expect(ctx.deletes).toEqual(['scheduledNotifications/s1', 'scheduledNotifications/s2']);
    const stamp = ctx.writes.find((w) => w.path === 'marketingBlasts/b1');
    expect(stamp?.data.cancelledByUid).toBe('admin1');
    expect(typeof stamp?.data.cancelledAt).toBe('number');
  });

  it('refuses a blast that has already fired instead of claiming to recall sent mail', async () => {
    const ctx = cancelDb({ key: 'survey.event', fireAtMs: Date.now() - HOUR }, ['s1']);
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(cancelMarketingBlastHandler(req({ blastId: 'b1' }))).rejects.toThrow(/already_fired/);
    expect(ctx.deletes).toHaveLength(0);
  });

  it('refuses a second cancel', async () => {
    const ctx = cancelDb({ key: 'survey.event', fireAtMs: Date.now() + HOUR, cancelledAt: 123 }, ['s1']);
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(cancelMarketingBlastHandler(req({ blastId: 'b1' }))).rejects.toThrow(/already_cancelled/);
  });

  it('refuses an unknown blast id', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(cancelMarketingBlastHandler(req({ blastId: 'ghost' }))).rejects.toThrow(/does not exist/);
  });

  it('writes an audit entry', async () => {
    const ctx = cancelDb({ key: 'newsletter.announcement', fireAtMs: Date.now() + HOUR }, ['s1']);
    mocks.dbFn.mockReturnValue(ctx.db);
    await cancelMarketingBlastHandler(req({ blastId: 'b1' }));
    expect((writeAuditEntry as any).mock.calls[0][0].event).toBe('MARKETING_BLAST_CANCELLED');
  });

  it('refuses an unauthenticated caller', async () => {
    await expect(cancelMarketingBlastHandler(req({ blastId: 'b1' }, null))).rejects.toThrow(/Sign-in required/);
  });
});
