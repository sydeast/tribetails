import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapScheduled } from '../lib/wrapScheduled';
import { FULL_CPU_SERIAL } from '../lib/runtimeOptions';
import {
  acquireFanoutLease,
  countOf,
  releaseFanoutLease,
  type FanoutState,
} from '../lib/fanoutResume';
import { BLASTS_COLLECTION, resumeBlastFanout } from '../admin/scheduleMarketingBlast';
import { BROADCASTS_COLLECTION, resumeBroadcastFanout } from '../admin/broadcastMessage';
import { finishBlastCancellation } from '../admin/marketingBlasts';

/**
 * #823. Finishes an outbound fan-out that one invocation could not.
 *
 * `scheduleMarketingBlast` and `broadcastMessage` both walk a frozen roster for
 * fifteen seconds and then stop, leaving the row at `fanoutState: 'running'`.
 * Before this function existed, that was where a large send ended: visibly
 * stuck, safe to retry thanks to #822, and resumed by nothing. This is what
 * resumes it.
 *
 * ── ONE BLAST PER TICK, ON PURPOSE ──────────────────────────────────────────
 * The tick takes the FIRST row it can lease and gives it the whole budget,
 * rather than round-robining across every unfinished send. Two reasons, and the
 * second is the one that matters:
 *
 *   - a send that is nearly done finishes, instead of every send crawling; and
 *   - two sends interleaved inside one invocation would share one 540-second
 *     budget and one `HEARTBEAT_EVERY` cadence, so a cancel on either would be
 *     noticed half as often.
 *
 * With `maxInstances: 2` a tick that overlaps the previous one is absorbed
 * rather than shed, and the overlapping copy finds the lease held and returns
 * after a query and one failed transaction. So the second unfinished send waits
 * one leg, which for the realistic case (a five-thousand-recipient blast, four
 * legs, thirty-five minutes) is exactly right: these are scheduled campaigns,
 * queued hours before `fireAtMs`, not a request anybody is sitting in front of.
 *
 * ── EVERY MINUTE, NOT EVERY FIVE ────────────────────────────────────────────
 * A leg releases its lease when its budget runs out, and the next tick is what
 * picks the roster back up, so the cadence is dead time between legs. At five
 * minutes a four-leg blast would spend 15 of its 47 minutes doing nothing; at
 * one minute it spends 3. The cost of the other 1,436 ticks a day is one
 * equality query that matches nothing.
 *
 * ── THE SECRETS ARE THE BROADCAST'S, AND THEY ARE NOT OPTIONAL ──────────────
 * Resuming a broadcast means sending real email and SMS, so this function
 * declares the same secrets `broadcastMessage` does. `lib/declaredSecrets.ts`
 * reads `__endpoint.secretEnvironmentVariables`, so leaving one out here does
 * not fail the deploy, it fails the first resumed broadcast, at the provider,
 * for every remaining recipient.
 */

/** How many candidate rows to look at per tick before giving up on finding a free one. */
const SCAN_LIMIT = 10;

/**
 * The wall-clock budget one tick gives a fan-out: 480 seconds of a 540-second
 * function.
 *
 * The sixty-second remainder is not slack for the walk, it is for what happens
 * AFTER the deadline: the chunk close, the marker re-read, the lease release and
 * the audit write all run past it, and a tick killed between closing a chunk and
 * releasing its lease would leave the blast un-leasable for the full
 * `LEASE_MS`. Ten minutes of dead time to save sixty seconds of work is a bad
 * trade.
 */
const TICK_BUDGET_MS = 480_000;

/** One collection's unfinished rows, oldest first by document id (no index needed). */
async function runningRows(collection: string): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const snap = await db()
    .collection(collection)
    // A single equality and a limit, deliberately with NO `orderBy`: a filter
    // plus an order needs a composite index in `firestore.indexes.json`, and
    // `notificationBatchSweep`'s docstring is the record of what a missing one
    // costs (FAILED_PRECONDITION every five minutes, silenced by an index that
    // made the wrong query succeed). Order does not matter here: the tick takes
    // whichever row it can lease.
    .where('fanoutState', '==', 'running')
    .limit(SCAN_LIMIT)
    .get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }));
}

/**
 * A row that says `running` and carries no roster this sweep can walk.
 *
 * TWO POPULATIONS, and they are not the same fact, which is why the stamped
 * reason distinguishes them:
 *
 *   roster_incomplete   a #823-era claim whose roster write did not finish.
 *                       Nothing was sent, because the roster is committed before
 *                       the first claim, so failing it is honest and the
 *                       operator can schedule again.
 *   stranded_pre_823    a row left behind by the build #823 was filed about: its
 *                       fan-out died inside one invocation with real counts on
 *                       it, and there was never a roster to resume from. It is
 *                       the population the issue exists for, and it is told
 *                       apart by having no `fanoutTotal` at all.
 *
 * The distinction reaches the screens: a stranded row queued copies and both
 * lists say how many, rather than printing "never queued" over a send that
 * reached sixty households.
 */
async function failUnarmedRow(
  collection: string,
  id: string,
  row: Record<string, unknown>,
  workerId: string,
): Promise<void> {
  const ref = db().collection(collection).doc(id);
  // A row this build armed always has `fanoutTotal`, because it is written in
  // the same object as `fanoutState: 'running'`. Its absence is the only
  // evidence that an older build wrote the row, and it is enough.
  const stranded = row['fanoutTotal'] === undefined;
  const reason = stranded ? 'stranded_pre_823' : 'roster_incomplete';
  await releaseFanoutLease({
    ref,
    workerId,
    patch: {
      fanoutState: 'failed' satisfies FanoutState,
      fanoutFailure: reason,
    },
    fnName: 'outboundFanoutSweep',
  });
  logEvent({
    severity: 'warn',
    function: 'outboundFanoutSweep',
    event: 'fanout.roster.incomplete',
    extra: { collection, id, reason, dispatched: countOf(row, 'dispatched') },
  });
}

/**
 * Finishes a cancel the callable could not: the worker has stopped (or its lease
 * has expired, which proves the platform ended it), so the stragglers it may
 * have queued after the callable's delete are removed and the row is stamped
 * cancelled for good.
 *
 * Only blasts. A broadcast has nothing queued to delete, its email and SMS have
 * already left the building, so stopping its fan-out IS the whole cancel, and
 * `runFanout` does that itself when it reads `cancelRequestedAtMs`.
 */
async function finishCancellation(
  collection: string,
  id: string,
  workerId: string,
): Promise<void> {
  const ref = db().collection(collection).doc(id);
  const lease = await acquireFanoutLease({ ref, workerId, nowMs: Date.now(), forCancellation: true });
  if (!lease.acquired) return;
  if (collection === BLASTS_COLLECTION) {
    const stragglers = await finishBlastCancellation(id);
    logEvent({
      severity: 'info',
      function: 'outboundFanoutSweep',
      event: 'fanout.cancel.finished',
      extra: { collection, id, stragglers },
    });
    return;
  }
  await releaseFanoutLease({
    ref,
    workerId,
    patch: { fanoutState: 'cancelled' satisfies FanoutState },
    fnName: 'outboundFanoutSweep',
  });
}

/**
 * Takes at most one unfinished send from `collection` and pushes it along.
 *
 * Returns true when it actually worked on one, so the tick stops rather than
 * starting a second send on a budget it has already spent.
 */
async function sweepCollection(
  collection: string,
  workerId: string,
  deadlineMs: number,
): Promise<boolean> {
  const rows = await runningRows(collection);
  for (const row of rows) {
    const now = Date.now();

    if (typeof row.data['cancelRequestedAtMs'] === 'number') {
      // A cancel that landed mid fan-out. The worker stops on its own heartbeat;
      // this is the second half, and it must not run while that worker is still
      // going, which the lease is what decides.
      if (countOf(row.data, 'fanoutLeaseExpiresAtMs') > now) continue;
      await finishCancellation(collection, row.id, workerId);
      return true;
    }

    if (row.data['fanoutRosterReady'] !== true) {
      if (countOf(row.data, 'fanoutLeaseExpiresAtMs') > now) continue;
      await failUnarmedRow(collection, row.id, row.data, workerId);
      return true;
    }

    // `resume*Fanout` takes the lease itself (and refuses a row somebody else
    // holds), because the walk and the lease belong together: taking it here
    // would mean two places that can hold one and only one that can release it.
    const result =
      collection === BLASTS_COLLECTION
        ? await resumeBlastFanout({ blastId: row.id, row: row.data, workerId, deadlineMs })
        : await resumeBroadcastFanout({
            broadcastId: row.id,
            row: row.data,
            workerId,
            deadlineMs,
          });

    if (!result.ran) {
      // This worker never got the lease: another one holds it, or the row
      // stopped being resumable between the query and the claim. Try the next
      // row rather than burning the tick, and specifically rather than
      // reporting work done, which would skip the other collection entirely.
      //
      // `processed` cannot be used for this test. A refused lease hands back the
      // row's STORED counts, so a blast that is half sent and held by somebody
      // else reports a healthy non-zero `processed` while having done nothing
      // here.
      continue;
    }

    logEvent({
      severity: 'info',
      function: 'outboundFanoutSweep',
      event: 'fanout.resumed',
      extra: {
        collection,
        id: row.id,
        processed: result.processed,
        total: result.total,
        complete: result.complete,
        cancelled: result.cancelled,
      },
    });
    return true;
  }
  return false;
}

/**
 * One tick, extracted from the `onSchedule` wrapper so it can be called.
 *
 * `cleanupExpiredShareLinks` is the precedent and its docstring is the reason:
 * a sweep whose whole body is welded into the wrapper has nothing to test, and
 * this one has more to get wrong than a query, a lease, a roster cursor and a
 * cancel hand-off.
 */
export async function outboundFanoutSweepCore(opts: { nowMs?: number; budgetMs?: number } = {}): Promise<void> {
  const startedAtMs = opts.nowMs ?? Date.now();
  const workerId = `sweep-${startedAtMs.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const deadlineMs = startedAtMs + (opts.budgetMs ?? TICK_BUDGET_MS);

  // Blasts first. A blast's copies are only QUEUED, so finishing one late is
  // cheap; a broadcast's email has already gone. That ordering is arbitrary
  // when both are waiting and it is written down so it is not mistaken for a
  // priority rule: whichever is behind catches up on the next tick.
  if (await sweepCollection(BLASTS_COLLECTION, workerId, deadlineMs)) return;
  await sweepCollection(BROADCASTS_COLLECTION, workerId, deadlineMs);
}

export const outboundFanoutSweep = onSchedule(
  {
    schedule: 'every 1 minutes',
    region: 'us-central1',
    // 540 is the ceiling a 2nd-gen function may ask for, and it is deliberately
    // the SAME number `LEASE_MS` is sized against: a 600-second lease cannot
    // expire under a worker the platform has not already ended.
    timeoutSeconds: 540,
    // One vCPU so the walk is not starved, and a 2-instance cap so an
    // overlapping tick is absorbed rather than shed. Two copies cannot double
    // a send in any case, the per-recipient `create()` referees that, but two
    // copies on one roster is twice the Firestore traffic for the same work,
    // and the lease is what stops it.
    ...FULL_CPU_SERIAL,
    secrets: [
      'SMTP2GO_API_KEY',
      'EMAIL_FROM',
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_FROM_NUMBER',
      'SENTRY_DSN',
    ],
  },
  wrapScheduled('outboundFanoutSweep', () => outboundFanoutSweepCore()),
);
