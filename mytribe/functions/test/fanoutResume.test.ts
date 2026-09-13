import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

/**
 * #823: a send too large to finish in one invocation must FINISH, and must
 * reach every household exactly once while doing it.
 *
 * The failure this guards is the one #822 left behind after it closed the
 * dangerous half. A blast to 5,000 households costs about twenty minutes of
 * sequential Firestore round trips against a 540-second function ceiling, so it
 * stopped part-way with `fanoutState: 'running'` and partial counts, and nothing
 * resumed it. Safe, visible, and permanently stuck.
 *
 * Every test below runs the mock in `writeThrough` mode, and that is not
 * incidental: the whole mechanism is "a later worker reads what an earlier one
 * wrote". Against a static fixture the second worker sees nothing, re-sends
 * everyone, and every assertion here passes for the wrong reason.
 *
 * THE CLOCK IS DRIVEN BY THE SEND. `Date.now` is stubbed and each simulated
 * send advances it, which is what makes "the budget ran out half way through
 * the roster" a thing this suite can state precisely instead of approximate
 * with a sleep.
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
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { scheduleMarketingBlastHandler, BLASTS_COLLECTION } from '../src/admin/scheduleMarketingBlast';
import {
  cancelMarketingBlastHandler,
  listMarketingBlastsHandler,
  blastStatus,
} from '../src/admin/marketingBlasts';
import { outboundFanoutSweepCore } from '../src/scheduled/outboundFanoutSweep';
import {
  FANOUT_CHUNK,
  STALLED_AFTER_MS,
  fanoutProgressState,
  releaseFanoutLease,
  runFanout,
  writeFanoutRoster,
  type RecipientOutcome,
} from '../src/lib/fanoutResume';

const HOUR = 60 * 60 * 1000;
const START = 1_760_000_000_000;

/** The stubbed wall clock every test drives. */
let clock = START;

beforeEach(() => {
  clock = START;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  mocks.dbFn.mockReset();
  mocks.enqueue.mockReset().mockImplementation(async () => {
    // Every send costs 250ms of wall clock, the measured per-recipient figure
    // #823 is written around. A 15-second inline budget therefore reaches
    // roughly sixty households before it has to hand off.
    clock += 250;
    return ['n1'];
  });
  mocks.loadUserPrefs.mockReset().mockResolvedValue({});
  mocks.loadBusinessOverride.mockReset().mockResolvedValue(null);
  mocks.resolveChannels.mockReset().mockReturnValue({ email: true, sms: false, push: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } } as never) : undefined,
  } as unknown as CallableRequest<unknown>;
}

/** `n` linked households, so one fan-out is `n` enqueues. */
function audienceDb(n: number, docs: Record<string, Record<string, unknown> | null> = {}) {
  return buildDbMock({
    writeThrough: true,
    docs,
    queryDocs: {
      kinfolk: Array.from({ length: n }, (_, i) => ({
        id: `k${i}`,
        data: { status: 'active', tags: [], uid: `u${i}` },
      })),
    },
  });
}

const blastArgs = (over: Record<string, unknown> = {}) => ({
  key: 'newsletter.announcement',
  fireAtMs: clock + HOUR,
  criteria: { kind: 'all' },
  data: { subject: 'Spring news' },
  ...over,
});

/** Every uid the dispatcher was asked to reach, in call order. */
function reached(): string[] {
  return mocks.enqueue.mock.calls.map((c) => (c[0] as { recipientUid: string }).recipientUid);
}

/**
 * The mock's backing document map. `writeThrough` mutates the very object it was
 * handed, so holding a reference to it is how a test reads stored state back ,
 * which is exactly what this suite is about, since the fan-out's memory IS that
 * stored state.
 */
let backing: Record<string, Record<string, unknown>> = {};

/** The stored row, by path. `{}` when nothing has been written there. */
function stored(path: string): Record<string, unknown> {
  return backing[path] ?? {};
}

function blastRow(id: string): Record<string, unknown> {
  return stored(`${BLASTS_COLLECTION}/${id}`);
}

function freshDb(n: number, docs: Record<string, Record<string, unknown>> = {}) {
  backing = docs;
  const ctx = audienceDb(n, docs);
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

describe('a blast too large for one invocation (#823)', () => {
  it('hands off part-way, says so, and does not pretend the counts are a total', async () => {
    freshDb(250);
    const res = await scheduleMarketingBlastHandler(req(blastArgs()));

    // 15 seconds of budget at 250ms a household is ~60, so the roster is not
    // exhausted and the reply must not read like a finished send.
    expect(res.pending).toBe(true);
    expect(res.audienceSize).toBe(250);
    expect(res.queued).toBeGreaterThan(0);
    expect(res.queued).toBeLessThan(250);
    // The counts are the CLOSED chunks only, never the whole roster.
    expect(res.dispatched).toBe(res.queued);
    expect(blastRow(res.blastId).fanoutState).toBe('running');
    expect(reached().length).toBeGreaterThan(0);
    expect(reached().length).toBeLessThan(250);
  });

  it('the sweep finishes it, and every household is reached exactly once', async () => {
    freshDb(250);
    const res = await scheduleMarketingBlastHandler(req(blastArgs()));
    expect(res.pending).toBe(true);

    // Tick until the row says complete. Each tick gets a budget of its own, so
    // this is a sequence of real hand-offs rather than one long run.
    for (let i = 0; i < 20; i += 1) {
      if (blastRow(res.blastId).fanoutState === 'complete') break;
      clock += 1_000;
      await outboundFanoutSweepCore({ nowMs: clock, budgetMs: 20_000 });
    }

    const row = blastRow(res.blastId);
    expect(row.fanoutState).toBe('complete');
    expect(row.fanoutProcessed).toBe(250);
    expect(row.dispatched).toBe(250);

    // THE CLAIM THIS WHOLE FILE EXISTS FOR: 250 households, 250 sends, no
    // household twice, across a callable and several sweep ticks.
    const uids = reached();
    expect(uids).toHaveLength(250);
    expect(new Set(uids).size).toBe(250);
  });

  it('a small blast still finishes inline, exactly as it did before', async () => {
    freshDb(3);
    const res = await scheduleMarketingBlastHandler(req(blastArgs()));
    expect(res.pending).toBe(false);
    expect(res.dispatched).toBe(3);
    expect(res.queued).toBe(3);
    expect(reached()).toEqual(['u0', 'u1', 'u2']);
  });
});

describe('per-recipient idempotency on resume (#823)', () => {
  /**
   * The lease is ordering; the MARKER is correctness. Cloud Run throttles a
   * container after its request timeout rather than killing it, so a zombie can
   * still write, and no expiry this side of the wire can prove otherwise. This
   * drives two workers at one roster with the lease deliberately ignored and
   * asserts the marker alone holds the line.
   */
  it('two workers on one roster send to each household exactly once', async () => {
    const ctx = freshDb(0);
    const ref = ctx.db.collection(BLASTS_COLLECTION).doc('b1');
    const ids = Array.from({ length: 12 }, (_, i) => `u${i}`);
    const roster = await writeFanoutRoster({ ref, attempt: 0, recipientIds: ids, nowMs: clock });
    await ref.set({ fanoutState: 'running', scheduledByUid: 'admin1', ...roster.fields });

    const sent: string[] = [];
    const sendOne = async (id: string): Promise<RecipientOutcome> => {
      sent.push(id);
      return 'sent';
    };

    // Both claim `leaseHeld`, so neither takes the lease and neither is stopped
    // by it. Run them concurrently against one roster.
    await Promise.all([
      runFanout({ ref, workerId: 'w1', deadlineMs: clock + 60_000, sendOne, fnName: 't', leaseHeld: true }),
      runFanout({ ref, workerId: 'w2', deadlineMs: clock + 60_000, sendOne, fnName: 't', leaseHeld: true }),
    ]);

    expect(sent.sort()).toEqual([...ids].sort());
    expect(new Set(sent).size).toBe(12);
  });

  /**
   * A claim is taken BEFORE the send, so a worker that dies in between leaves a
   * marker stuck at `claimed`. That household is counted failed and never
   * retried, which is the deliberate asymmetry: a missed marketing email is a
   * disappointment, a duplicate one cannot be recalled.
   */
  it('never re-sends to a household whose worker died after claiming it', async () => {
    const ctx = freshDb(0);
    const ref = ctx.db.collection(BLASTS_COLLECTION).doc('b2');
    const ids = ['u0', 'u1', 'u2'];
    const roster = await writeFanoutRoster({ ref, attempt: 0, recipientIds: ids, nowMs: clock });
    await ref.set({ fanoutState: 'running', scheduledByUid: 'admin1', ...roster.fields });

    // The marker a dead worker left behind: claimed, never settled.
    await ref
      .collection('fanoutRecipients')
      .doc('a0_u1')
      .set({ recipientId: 'u1', attempt: 0, state: 'claimed', claimedAtMs: clock });

    const sent: string[] = [];
    const run = await runFanout({
      ref,
      workerId: 'w1',
      deadlineMs: clock + 60_000,
      sendOne: async (id: string): Promise<RecipientOutcome> => {
        sent.push(id);
        return 'sent';
      },
      fnName: 't',
      leaseHeld: true,
    });

    expect(sent).toEqual(['u0', 'u2']);
    expect(run.complete).toBe(true);
    // Reported, not swallowed: the abandoned claim lands in `failed`.
    expect(run.totals.sent).toBe(2);
    expect(run.totals.failed).toBe(1);
    expect(blastRow('b2').failed).toBe(1);
    expect(stored(`${BLASTS_COLLECTION}/b2/fanoutRecipients/a0_u1`).state).toBe('abandoned');
  });

  it('a resumed run re-reads the roster and skips every settled household', async () => {
    const ctx = freshDb(0);
    const ref = ctx.db.collection(BLASTS_COLLECTION).doc('b3');
    const ids = Array.from({ length: FANOUT_CHUNK + 5 }, (_, i) => `u${i}`);
    const roster = await writeFanoutRoster({ ref, attempt: 0, recipientIds: ids, nowMs: clock });
    await ref.set({ fanoutState: 'running', scheduledByUid: 'admin1', ...roster.fields });

    const sent: string[] = [];
    const sendOne = async (id: string): Promise<RecipientOutcome> => {
      sent.push(id);
      clock += 100;
      return 'sent';
    };

    // First leg: a budget that runs out inside the first chunk.
    const first = await runFanout({ ref, workerId: 'w1', deadlineMs: clock + 3_000, sendOne, fnName: 't' });
    expect(first.outOfBudget).toBe(true);
    expect(sent.length).toBeLessThan(ids.length);

    // The leg hands its lease back, exactly as every real caller does, so the
    // next tick can pick the roster up rather than waiting out LEASE_MS.
    await releaseFanoutLease({ ref, workerId: 'w1', fnName: 't' });

    // Second leg, a different worker, no memory of the first.
    const before = sent.length;
    await runFanout({ ref, workerId: 'w2', deadlineMs: clock + 600_000, sendOne, fnName: 't' });

    expect(sent).toHaveLength(ids.length);
    expect(new Set(sent).size).toBe(ids.length);
    expect(sent.slice(before).every((id) => !sent.slice(0, before).includes(id))).toBe(true);
  });
});

describe('cancelling a blast that is mid fan-out (#823)', () => {
  /**
   * The heartbeat, not the sweep.
   *
   * A cancel that only stopped the NEXT invocation would leave a live worker
   * queueing for the rest of its budget behind the operator's back, which is the
   * exact dishonesty this change removed. `sendOne` here stamps the request
   * mid-roster, so the run has to notice it on its own.
   */
  it('a live worker stops on the cancel it reads at its next heartbeat', async () => {
    const ctx = freshDb(0);
    const ref = ctx.db.collection(BLASTS_COLLECTION).doc('bc');
    const ids = Array.from({ length: FANOUT_CHUNK, }, (_, i) => `u${i}`);
    const roster = await writeFanoutRoster({ ref, attempt: 0, recipientIds: ids, nowMs: clock });
    await ref.set({ fanoutState: 'running', scheduledByUid: 'admin1', ...roster.fields });
    const sent: string[] = [];
    const run = await runFanout({
      ref,
      workerId: 'w1',
      deadlineMs: clock + 600_000,
      fnName: 't',
      leaseHeld: true,
      sendOne: async (id: string): Promise<RecipientOutcome> => {
        sent.push(id);
        if (sent.length === 10) await ref.set({ cancelRequestedAtMs: clock }, { merge: true });
        return 'sent';
      },
    });
    expect(run.cancelled).toBe(true);
    expect(run.complete).toBe(false);
    // Noticed within one heartbeat window of the stamp, not at the end of the
    // chunk and not at the end of the budget.
    expect(sent.length).toBeGreaterThanOrEqual(10);
    expect(sent.length).toBeLessThan(10 + 2 * 25);
    expect(sent.length).toBeLessThan(FANOUT_CHUNK);
  });
  it('stops the fan-out instead of letting it queue more behind the delete', async () => {
    freshDb(250);
    const res = await scheduleMarketingBlastHandler(req(blastArgs()));
    expect(res.pending).toBe(true);
    const queuedBefore = reached().length;

    const cancel = await cancelMarketingBlastHandler(req({ blastId: res.blastId }));
    // Honest about what it could and could not confirm: the fan-out was still
    // running, so a straggler may land and `cancelledAt` is NOT stamped yet.
    expect(cancel.stopped).toBe(false);
    expect(cancel.neverQueued).toBeGreaterThan(0);
    // `null`, the value the row was created with, NOT a timestamp: a cancel that
    // could not confirm the worker stopped has not finished, and stamping it
    // would be the dishonest half this change removed.
    expect(blastRow(res.blastId).cancelledAt).toBeNull();
    expect(typeof blastRow(res.blastId).cancelRequestedAtMs).toBe('number');

    // The sweep refuses to RESUME a cancelled row and finishes the cancel.
    clock += 1_000;
    await outboundFanoutSweepCore({ nowMs: clock, budgetMs: 20_000 });

    const row = blastRow(res.blastId);
    expect(row.fanoutState).toBe('cancelled');
    expect(typeof row.cancelledAt).toBe('number');
    // And nothing more went out after the cancel.
    expect(reached().length).toBe(queuedBefore);
  });

  it('refuses a fired blast whose fan-out is finished, and allows one still running', async () => {
    freshDb(2);
    const done = await scheduleMarketingBlastHandler(req(blastArgs({ fireAtMs: clock + 1_000 })));
    expect(done.pending).toBe(false);
    clock += 60_000; // the fire time passes

    // Finished AND fired: there is nothing left to stop, and saying so is the
    // honest answer. This is the original `already_fired` refusal, narrowed.
    await expect(cancelMarketingBlastHandler(req({ blastId: done.blastId }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });

    // A blast still fanning out past its own fire time IS stoppable, and used to
    // be refused for the same reason the finished one is.
    freshDb(250);
    const running = await scheduleMarketingBlastHandler(req(blastArgs({ fireAtMs: clock + 1_000 })));
    expect(running.pending).toBe(true);
    clock += 60_000;
    const cancel = await cancelMarketingBlastHandler(req({ blastId: running.blastId }));
    expect(cancel.ok).toBe(true);
    expect(cancel.stopped).toBe(false);
  });
});

describe('what the operator sees while a blast is sending (#823)', () => {
  it('lists a running fan-out as sending, with a progress number the row can back', async () => {
    freshDb(250);
    const res = await scheduleMarketingBlastHandler(req(blastArgs()));
    // One sweep leg, so at least one chunk closes and the progress is durable.
    clock += 1_000;
    await outboundFanoutSweepCore({ nowMs: clock, budgetMs: 12_000 });

    const listed = await listMarketingBlastsHandler(req({}));
    const listedRow = listed.blasts.find((b) => b.id === res.blastId);

    expect(listedRow?.status).toBe('sending');
    expect(listedRow?.fanoutState).toBe('running');
    expect(listedRow?.audienceSize).toBe(250);
    // The mock's "256 of 410 dispatched", and it is a CLOSED-chunk count: the
    // partial chunk a run is inside contributes to the callable's reply and not
    // to the row, because an unclosed chunk is not a durable fact.
    expect(listedRow?.queued).toBeGreaterThan(0);
    expect(listedRow?.queued).toBeLessThan(250);
    expect(listedRow?.queued).toBe(blastRow(res.blastId).fanoutProcessed);
    expect(fanoutProgressState(blastRow(res.blastId), clock)).toBe('running');
  });

  it('calls a fan-out stalled once its lease is long gone and nothing has moved', () => {
    const live = { fanoutState: 'running', fanoutLeaseExpiresAtMs: clock + 1, fanoutUpdatedAtMs: clock };
    expect(fanoutProgressState(live, clock)).toBe('running');

    // Lease expired but only just: a leg that released its lease is legitimately
    // unowned until the next tick picks it up, and flagging that would flag
    // every hand-off.
    const handedOff = { fanoutState: 'running', fanoutLeaseExpiresAtMs: clock - 1, fanoutUpdatedAtMs: clock - 1_000 };
    expect(fanoutProgressState(handedOff, clock)).toBe('running');

    const stalled = {
      fanoutState: 'running',
      fanoutLeaseExpiresAtMs: clock - 1,
      fanoutUpdatedAtMs: clock - STALLED_AFTER_MS - 1,
    };
    expect(fanoutProgressState(stalled, clock)).toBe('stalled');

    // A row written before #823 has no lease and no progress stamp. It must not
    // read as stalled: it was written by a build whose fan-out ended with its
    // invocation.
    expect(fanoutProgressState({ fanoutState: 'complete' }, clock)).toBe('complete');
  });

  /**
   * The rows #823 was actually filed about, met on the sweep's FIRST deploy.
   *
   * A blast the old build stranded says `running`, carries the counts it got to,
   * and has no roster: there is nothing to resume, so the sweep has to fail it.
   * What it must not do is fail it as though nothing was ever sent. A row that
   * queued sixty-one copies is a send stopped part-way, and the stamped reason
   * is what lets both screens say so.
   */
  it('tells a stranded pre-#823 row apart from one whose roster never armed', async () => {
    freshDb(0, {
      [`${BLASTS_COLLECTION}/legacy`]: {
        key: 'newsletter.announcement',
        fireAtMs: clock - HOUR,
        createdAtMs: clock - HOUR,
        criteria: { kind: 'all' },
        audienceDescription: 'All active kinfolk',
        matched: 900,
        // The tell, and the only one: the pre-#823 build wrote counts and a
        // state, never a roster total.
        dispatched: 61,
        suppressedByPrefs: 4,
        failed: 0,
        fanoutState: 'running',
        cancelledAtMs: null,
      },
      [`${BLASTS_COLLECTION}/halfArmed`]: {
        key: 'survey.event',
        fireAtMs: clock - HOUR,
        createdAtMs: clock - HOUR,
        criteria: { kind: 'all' },
        audienceDescription: 'All active kinfolk',
        matched: 900,
        dispatched: 0,
        suppressedByPrefs: 0,
        failed: 0,
        fanoutState: 'running',
        fanoutTotal: 900,
        fanoutRosterReady: false,
        cancelledAtMs: null,
      },
    });

    // One row per tick, by design, so it takes two.
    await outboundFanoutSweepCore({ nowMs: clock, budgetMs: 12_000 });
    await outboundFanoutSweepCore({ nowMs: clock, budgetMs: 12_000 });

    expect(blastRow('legacy').fanoutState).toBe('failed');
    expect(blastRow('legacy').fanoutFailure).toBe('stranded_pre_823');
    expect(blastRow('halfArmed').fanoutState).toBe('failed');
    expect(blastRow('halfArmed').fanoutFailure).toBe('roster_incomplete');

    // And the list is honest about which is which: the stranded row keeps its
    // counts, so the screens do not print "never queued" over 61 sent copies.
    const listed = await listMarketingBlastsHandler(req({}));
    const legacy = listed.blasts.find((b) => b.id === 'legacy');
    expect(legacy?.status).toBe('failed');
    expect(legacy?.dispatched).toBe(61);
    expect(listed.blasts.find((b) => b.id === 'halfArmed')?.dispatched).toBe(0);
  });

  it('sorts a cancelled and a cancelling blast apart', () => {
    expect(blastStatus(clock + HOUR, clock, clock, 'cancelled', true)).toBe('cancelled');
    expect(blastStatus(clock + HOUR, null, clock, 'running', true)).toBe('cancelling');
    expect(blastStatus(clock + HOUR, null, clock, 'complete', false)).toBe('scheduled');
    expect(blastStatus(clock - HOUR, null, clock, 'complete', false)).toBe('sent');
    // Still queueing past its own fire time is 'sending', not 'sent': the
    // campaign is not finished and the list must not file it under history.
    expect(blastStatus(clock - HOUR, null, clock, 'running', false)).toBe('sending');
  });
});
