import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

/**
 * #814: two attempts at one marketing blast must queue ONE set of scheduled
 * notifications.
 *
 * The failure this guards is outbound marketing email reaching real households
 * twice. The operator's 20-second client budget expires while the server is
 * still fanning out, the SDK reports that as `functions/internal`, the same
 * code it reports when the request never arrived, and the honest response to a
 * visible failure is to press Schedule again. Without a key that second press
 * is a second fan-out that cannot be recalled.
 *
 * THE MOCK IS RUN IN `writeThrough` MODE, which is the whole point: the claim is
 * "the second attempt sees what the first one wrote", and against the static
 * fixture the rest of this suite uses, the second attempt sees nothing and every
 * assertion below would pass for the wrong reason.
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

import { scheduleMarketingBlastHandler, BLASTS_COLLECTION } from '../src/admin/scheduleMarketingBlast';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

const HOUR = 60 * 60 * 1000;
const KEY_A = 'blast_1757700000000_ab12cd';
const KEY_B = 'blast_1757700000001_ef34gh';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
  mocks.loadUserPrefs.mockReset().mockResolvedValue({});
  mocks.loadBusinessOverride.mockReset().mockResolvedValue(null);
  mocks.resolveChannels.mockReset().mockReturnValue({ email: true, sms: false, push: false });
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return { data, auth: uid ? ({ uid, token: { admin: true } } as any) : undefined } as unknown as CallableRequest<unknown>;
}

/** Two active households with linked accounts, so one fan-out is two enqueues. */
function liveDb(docs: Record<string, Record<string, unknown> | null> = {}) {
  return buildDbMock({
    writeThrough: true,
    docs,
    queryDocs: {
      kinfolk: [
        { id: 'k1', data: { status: 'active', tags: ['vip'], uid: 'u1' } },
        { id: 'k2', data: { status: 'active', tags: [], uid: 'u2' } },
      ],
    },
  });
}

const blast = (over: Record<string, unknown> = {}) => ({
  key: 'newsletter.announcement',
  fireAtMs: Date.now() + HOUR,
  criteria: { kind: 'all' },
  data: { subject: 'Spring news' },
  ...over,
});

/** Every distinct `marketingBlasts/{id}` the run touched. */
function blastRowIds(ctx: ReturnType<typeof liveDb>): string[] {
  return Array.from(
    new Set(
      ctx.writes
        .filter((w) => w.path.startsWith(`${BLASTS_COLLECTION}/`))
        .map((w) => w.path.split('/')[1]),
    ),
  );
}

describe('scheduleMarketingBlast idempotency (#814)', () => {
  it('answers a second call with the same key from the original blast, queueing nothing new', async () => {
    const ctx = liveDb();
    mocks.dbFn.mockReturnValue(ctx.db);

    const first = await scheduleMarketingBlastHandler(req(blast({ idempotencyKey: KEY_A })));
    const second = await scheduleMarketingBlastHandler(req(blast({ idempotencyKey: KEY_A })));

    // ONE row, and it is the key itself.
    expect(blastRowIds(ctx)).toEqual([KEY_A]);
    // ONE set of scheduled notifications: two recipients, not four.
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.enqueue.mock.calls.map((c) => c[0].recipientUid)).toEqual(['u1', 'u2']);

    expect(first.blastId).toBe(KEY_A);
    expect(first.deduped).toBe(false);
    expect(first.dispatched).toBe(2);

    expect(second.blastId).toBe(KEY_A);
    expect(second.deduped).toBe(true);
    // The stored counts, so the reply describes the blast that exists.
    expect(second.dispatched).toBe(2);
    expect(second.pending).toBe(false);

    // And no second audit row: nothing happened to audit.
    expect((writeAuditEntry as any).mock.calls).toHaveLength(1);
  });

  it('fans out twice for two different keys, because they are two campaigns', async () => {
    const ctx = liveDb();
    mocks.dbFn.mockReturnValue(ctx.db);

    const first = await scheduleMarketingBlastHandler(req(blast({ idempotencyKey: KEY_A })));
    const second = await scheduleMarketingBlastHandler(req(blast({ idempotencyKey: KEY_B })));

    expect(blastRowIds(ctx)).toEqual([KEY_A, KEY_B]);
    expect(mocks.enqueue).toHaveBeenCalledTimes(4);
    expect(first.blastId).not.toBe(second.blastId);
    expect(second.deduped).toBe(false);
  });

  it('lets only one of two SIMULTANEOUS attempts fan out', async () => {
    // The real case: the client's 20s budget expires while the first attempt is
    // still enqueueing, and the retry arrives before it finishes. A
    // check-then-write would let both see "absent"; the `create()` claim cannot.
    const ctx = liveDb();
    mocks.dbFn.mockReturnValue(ctx.db);

    const [a, b] = await Promise.all([
      scheduleMarketingBlastHandler(req(blast({ idempotencyKey: KEY_A }))),
      scheduleMarketingBlastHandler(req(blast({ idempotencyKey: KEY_A }))),
    ]);

    expect(blastRowIds(ctx)).toEqual([KEY_A]);
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect([a.deduped, b.deduped].sort()).toEqual([false, true]);
    expect(a.blastId).toBe(KEY_A);
    expect(b.blastId).toBe(KEY_A);
  });

  it('reports a fan-out that has not finished as pending rather than as a total', async () => {
    // A row stamped 'running' is either an attempt still in flight or one that
    // was killed part-way. Either way the counts are a snapshot, and a reply
    // that presented them as final would be the confident wrong number.
    const ctx = liveDb({
      [`${BLASTS_COLLECTION}/${KEY_A}`]: {
        key: 'newsletter.announcement',
        scheduledByUid: 'admin1',
        matched: 2,
        noLinkedAccount: 0,
        dispatched: 1,
        fanoutState: 'running',
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await scheduleMarketingBlastHandler(req(blast({ idempotencyKey: KEY_A })));

    expect(res.deduped).toBe(true);
    expect(res.pending).toBe(true);
    expect(res.dispatched).toBe(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('refuses a key that belongs to a different operator instead of handing back their campaign', async () => {
    const ctx = liveDb({
      [`${BLASTS_COLLECTION}/${KEY_A}`]: {
        key: 'newsletter.announcement',
        scheduledByUid: 'someone-else',
        fanoutState: 'complete',
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      scheduleMarketingBlastHandler(req(blast({ idempotencyKey: KEY_A }))),
    ).rejects.toMatchObject({ code: 'already-exists' });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('answers a retry whose fire time has since slipped into the past', async () => {
    // The guard that would otherwise refuse it is real and correct for a NEW
    // blast: `fireAtMs` more than 60s in the past is rejected. An operator who
    // schedules for "now", sees a timeout and presses Schedule again ninety
    // seconds later would be told the send is in the past, for a blast that is
    // already stored and already queued. The fast path sits above that guard so
    // the retry is deterministic.
    const ctx = liveDb({
      [`${BLASTS_COLLECTION}/${KEY_A}`]: {
        key: 'newsletter.announcement',
        scheduledByUid: 'admin1',
        matched: 2,
        dispatched: 2,
        fanoutState: 'complete',
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await scheduleMarketingBlastHandler(
      req(blast({ idempotencyKey: KEY_A, fireAtMs: Date.now() - 10 * 60 * 1000 })),
    );

    expect(res.deduped).toBe(true);
    expect(res.dispatched).toBe(2);
  });

  it('keeps the old behaviour exactly when no key is sent', async () => {
    const ctx = liveDb();
    mocks.dbFn.mockReturnValue(ctx.db);

    const first = await scheduleMarketingBlastHandler(req(blast()));
    const second = await scheduleMarketingBlastHandler(req(blast()));

    // Server-minted ids, no dedupe: two rows and two fan-outs, which is what an
    // unkeyed caller has always got.
    expect(blastRowIds(ctx)).toHaveLength(2);
    expect(mocks.enqueue).toHaveBeenCalledTimes(4);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(false);
    expect(first.blastId).not.toBe(second.blastId);
  });

  it('refuses a key that is not the shape the server mints', async () => {
    const ctx = liveDb();
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      scheduleMarketingBlastHandler(req(blast({ idempotencyKey: 'not-a-key' }))),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('stamps the row running before the fan-out and complete after it', async () => {
    const ctx = liveDb();
    mocks.dbFn.mockReturnValue(ctx.db);

    await scheduleMarketingBlastHandler(req(blast({ idempotencyKey: KEY_A })));

    const rowWrites = ctx.writes.filter((w) => w.path === `${BLASTS_COLLECTION}/${KEY_A}`);
    expect(rowWrites[0].data.fanoutState).toBe('running');
    expect(rowWrites.at(-1)?.data.fanoutState).toBe('complete');
  });
});
