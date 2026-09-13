import type { DocumentReference } from 'firebase-admin/firestore';
import { logEvent } from './logger';

/**
 * #823: the machinery that lets ONE outbound fan-out survive being cut in half.
 *
 * ── THE WALL, MEASURED ──────────────────────────────────────────────────────
 * `scheduleMarketingBlast` and `broadcastMessage` both fanned out inline, and
 * both carry `timeoutSeconds: 540` — the ceiling a 2nd-gen function is allowed
 * to ask for, so the wall is the same wherever the loop lives. `MAX_AUDIENCE`
 * is 5000 and each recipient costs five to six sequential Firestore round
 * trips, which is on the order of twenty minutes at the cap. A blast to a large
 * audience therefore CANNOT finish in one invocation. It stopped part-way with
 * `fanoutState: 'running'` and partial counts, and nothing resumed it.
 *
 * The fix is not a smaller `MAX_AUDIENCE`. That caps the product to fit the
 * mechanism, and #823 refuses it in those words. The fix is to make the fan-out
 * an interruptible, resumable walk over a FROZEN roster, and to let a cron
 * finish whatever one invocation could not.
 *
 * ── WHY A CRON SWEEP AND NOT CLOUD TASKS ────────────────────────────────────
 * The arithmetic, since #823 asks for it explicitly.
 *
 * The work is Firestore-ROUND-TRIP bound, not CPU bound: a recipient costs
 * ~250ms of waiting and almost no compute. So concurrency is the only dial that
 * would make it finish faster, and concurrency is the dial this project has
 * already been burned by. `lib/runtimeOptions.ts` records the 2026-08-01 Cloud
 * Run reading: 200 vCPU per project per region in `us-central1`, against a
 * measured 16,000 of 400,000 milli vCPU in use. A Cloud Tasks design sized to
 * drain 5000 recipients in a minute needs ~25 concurrent workers, which is
 * 25 vCPU — an eighth of the regional ceiling for one feature — plus a queue,
 * its IAM, a dispatch-rate dial and a second retry semantics to reason about.
 *
 * This design adds ONE `onSchedule` function at `FULL_CPU_SERIAL`
 * (`cpu: 1, maxInstances: 2`), so its worst case is 2 vCPU, one percent of the
 * regional ceiling, and its steady state is one query per minute that usually
 * matches nothing. Two instances rather than one so a tick that overlaps the
 * previous one is absorbed; the second finds the lease held and returns in a
 * single round trip. A 5000-recipient blast finishes in roughly four legs of
 * eight minutes, so about 35 minutes wall clock — and a blast's fan-out runs at
 * SCHEDULE time, hours or days before `fireAtMs`, so those 35 minutes are
 * almost always invisible. Cloud Tasks buys latency this product does not need
 * at a cost in quota and moving parts it has already paid once.
 *
 * ── NO QUERIES, NO INDEXES ──────────────────────────────────────────────────
 * Every read below is BY DOCUMENT ID: the chunk cursor is a number on the row,
 * chunk ids are derived from it, and a recipient's marker id is derived from
 * the recipient id. Nothing here queries a subcollection, so nothing here needs
 * an entry in `firestore.indexes.json`, now or when a new blast shape lands.
 * `notificationBatchSweep`'s docstring is the cautionary tale: a group-scoped
 * `orderBy` threw FAILED_PRECONDITION every five minutes and left a trap for
 * every future key.
 *
 * ── THE MARKER IS THE CORRECTNESS GUARANTEE; THE LEASE IS ONLY ORDER ────────
 * This is the part to read twice.
 *
 * The lease stops two workers picking up the same blast in the normal case. It
 * is NOT what makes a resume safe, because it cannot be: after the 540s request
 * timeout Cloud Run throttles a container's CPU rather than killing it, so a
 * zombie invocation can still trickle writes out for a while, and no expiry
 * this side of the wire can prove it has stopped.
 *
 * What makes a resume safe is [claimRecipient]: a per-recipient
 * `create()` on `{anchor}/fanoutRecipients/{marker}`. `create()` is the one
 * write whose outcome depends on what is already stored, so it is refereed by
 * the SERVER. Of any number of workers reaching one recipient, exactly one
 * wins the claim and the rest are told ALREADY_EXISTS and skip. That holds with
 * the lease, without the lease, and against a zombie that ignores it. The same
 * reasoning `lib/sendIdempotency.ts` gives for the blast row itself, one level
 * down.
 *
 * The lease's expiry is still chosen so a steal is provably safe rather than
 * merely likely: [LEASE_MS] is 600s and the platform ceiling on the worker is
 * 540s, so a lease that has expired belonged to an invocation the platform has
 * already ended.
 *
 * ── A CLAIM IS TAKEN BEFORE THE SEND, NEVER AFTER ───────────────────────────
 * So a worker that dies between claiming and sending leaves a marker stuck at
 * `claimed`, and that recipient is COUNTED AS FAILED and never retried. That is
 * deliberate, and it is the asymmetry #822 established: a missed marketing
 * email is a disappointment, a duplicate one cannot be recalled. Marking after
 * the send would invert it. The stuck marker is reported rather than swallowed:
 * it lands in the row's `failed` count, which is on both screens.
 *
 * ── COUNTS ARE A FUNCTION OF DURABLE STATE ──────────────────────────────────
 * A worker's in-memory tally dies with it, so counts are never accumulated in
 * memory across a resume. At the end of each chunk the markers for that chunk
 * are RE-READ and tallied, and the chunk is closed in a transaction that
 * refuses to run twice. The row's totals therefore describe exactly the chunks
 * that are closed, and `fanoutProcessed` says how many recipients that is. The
 * partial chunk a run stopped inside contributes to neither until it closes.
 */

/** The fan-out's own state, stored on the anchor row. */
export type FanoutState = 'running' | 'complete' | 'failed' | 'cancelled';

/** What happened for one recipient. Written onto that recipient's marker. */
export type RecipientOutcome = 'sent' | 'suppressed' | 'failed';

/** A marker's stored state: a claim in progress, an outcome, or an abandoned claim. */
export type MarkerState = RecipientOutcome | 'claimed' | 'abandoned';

/**
 * 100, and the number is a compromise between two costs that pull opposite ways.
 *
 * Larger chunks mean fewer closing transactions and fewer marker re-reads, but
 * a coarser progress number (the row only moves when a chunk closes) and more
 * work redone when a chunk is re-entered... except nothing is redone, because
 * the markers are per recipient. So the real pull is progress granularity: at
 * ~250ms a recipient, 100 recipients is ~25 seconds, which is how often the
 * count on the operator's screen moves. 500 would be two minutes of apparent
 * stillness on a screen whose whole point is saying that something is moving.
 */
export const FANOUT_CHUNK = 100;

/**
 * 600 seconds, and the relationship to 540 is the whole argument.
 *
 * 540 is `timeoutSeconds` on both callables and on the sweep, and it is the
 * ceiling a 2nd-gen function may ask for. A lease older than 600s therefore
 * belongs to an invocation the platform has already ended: a steal cannot race
 * a request that is still being served. The extra minute is slack for clock
 * skew between the writer and the stealer.
 *
 * It is NOT the safety mechanism. See the header: that is the per-recipient
 * `create()`, which holds even against a throttled zombie still writing after
 * its request ended.
 */
export const LEASE_MS = 600_000;

/**
 * How long a CALLABLE may spend fanning out before it hands the rest to the
 * sweep. Fifteen seconds.
 *
 * Chosen against the CLIENT's budget rather than the platform's. Both admin
 * clients give a callable 20 seconds
 * (`auntieos-admin/src/lib/fns.ts#CALLABLE_TIMEOUT_MS`), so a reply inside 15 is
 * one the operator actually reads. Letting the handler run to its 540s ceiling
 * instead would mean every large send reached the operator as a client timeout,
 * an automatic retry and a dedupe replay — the failure #822 made SAFE but never
 * made pleasant.
 *
 * A small send is unaffected: at roughly 250ms a recipient, up to ~50 recipients
 * still finishes inline exactly as it did before, and replies `pending: false`.
 */
export const INLINE_FANOUT_BUDGET_MS = 15_000;

/**
 * How often the run stops to re-read the row: every 25 recipients, about six
 * seconds of work.
 *
 * Two questions are asked at once, which is why it is one constant: has the
 * operator asked to cancel (so the run stops rather than queueing another 75
 * copies behind their back), and does this worker still hold the lease. Per
 * recipient would double the round trips for a fact that changes on a human
 * timescale; per chunk would leave a cancel unnoticed for 25 seconds.
 */
const HEARTBEAT_EVERY = 25;

/** A per-chunk or whole-row tally. `abandoned` is folded into `failed` on the row. */
export interface FanoutTally {
  sent: number;
  suppressed: number;
  failed: number;
  abandoned: number;
}

export function emptyTally(): FanoutTally {
  return { sent: 0, suppressed: 0, failed: 0, abandoned: 0 };
}

function addTally(a: FanoutTally, b: FanoutTally): FanoutTally {
  return {
    sent: a.sent + b.sent,
    suppressed: a.suppressed + b.suppressed,
    failed: a.failed + b.failed,
    abandoned: a.abandoned + b.abandoned,
  };
}

/** A stored count, read back defensively. Absent reads as 0, never as a guess. */
export function countOf(data: Record<string, unknown>, field: string): number {
  const v = data[field];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Firestore's ALREADY_EXISTS (gRPC status 6), however the SDK surfaced it. */
export function isAlreadyExists(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  if (e?.code === 6) return true;
  return typeof e?.message === 'string' && e.message.includes('ALREADY_EXISTS');
}

/**
 * The chunk document id for an attempt and an index.
 *
 * The attempt prefix exists for one caller: `broadcastMessage` lets a same-key
 * retry re-run a send left at `fanoutState: 'failed'`, because all-failed means
 * nobody heard anything and re-running cannot duplicate a delivery (#822's
 * reasoning, unchanged). A fresh attempt gets fresh chunk and marker ids rather
 * than clearing the old ones, so the first attempt's record survives and the
 * retry cannot be silently no-opped by markers it did not write.
 *
 * Zero-padded so the ids sort the way the indices do, for anyone reading the
 * subcollection in a console.
 */
export function chunkDocId(attempt: number, index: number): string {
  return `a${attempt}c${String(index).padStart(5, '0')}`;
}

/** The marker document id for a recipient within an attempt. See [chunkDocId]. */
export function markerDocId(attempt: number, recipientId: string): string {
  return `a${attempt}_${recipientId}`;
}

/** The roster fields written onto the anchor row when a fan-out is armed. */
export interface RosterFields {
  fanoutAttempt: number;
  fanoutTotal: number;
  fanoutChunkCount: number;
  fanoutNextChunk: number;
  fanoutProcessed: number;
  fanoutStartedAtMs: number;
  /**
   * The row's promise that every chunk it names exists.
   *
   * Written LAST, after the roster commits, because the two writes cannot be
   * one: the chunks live under the row and the row is claimed before them. A
   * worker that died in between leaves `false`, which the sweep reads as "this
   * fan-out never armed" and fails the row rather than walking a roster that is
   * not all there. Nothing was sent in that window, so failing it is the honest
   * answer and the operator can schedule again.
   */
  fanoutRosterReady: true;
}

/**
 * Freezes the recipient list into `{anchor}/fanoutChunks/{id}` and returns the
 * row fields that describe it.
 *
 * THE ROSTER IS FROZEN ON PURPOSE. A resume must reach the audience the
 * operator saw and approved, not whatever the criteria happen to match forty
 * minutes later. Re-resolving on resume would let a household added to a tag in
 * the meantime receive a campaign nobody decided to send them, and would let one
 * removed from it fall out of a send that had already started.
 *
 * Recipient IDS only, never contact details. `broadcastMessage`'s contract is
 * "no plaintext recipient is stored (only aggregate counts)" and a roster of
 * email addresses and phone numbers would quietly break it. The sender re-reads
 * the household at send time, which costs one round trip and has the side
 * benefit that a corrected address is used.
 */
export async function writeFanoutRoster(opts: {
  ref: DocumentReference;
  attempt: number;
  recipientIds: readonly string[];
  nowMs: number;
}): Promise<{ fields: RosterFields; chunks: string[][] }> {
  const { ref, attempt, recipientIds, nowMs } = opts;
  const chunks = ref.collection('fanoutChunks');
  const inMemory: string[][] = [];
  // BATCHED, and the reason is the inline budget. At MAX_AUDIENCE the roster is
  // 50 documents, and 50 sequential `set()` calls is ~12 seconds of round trips
  // — the entire budget the callable has before the client's 20-second deadline,
  // spent before a single recipient is reached. One batch commit per 100 chunks
  // is one round trip for the whole roster.
  const PER_BATCH = 100;
  let index = 0;
  let batch = ref.firestore.batch();
  let queued = 0;
  for (let i = 0; i < recipientIds.length; i += FANOUT_CHUNK) {
    const ids = recipientIds.slice(i, i + FANOUT_CHUNK);
    inMemory.push([...ids]);
    batch.set(chunks.doc(chunkDocId(attempt, index)), {
      index,
      attempt,
      recipientIds: ids,
      state: 'pending',
      createdAtMs: nowMs,
    });
    index += 1;
    queued += 1;
    if (queued === PER_BATCH) {
      await batch.commit();
      batch = ref.firestore.batch();
      queued = 0;
    }
  }
  if (queued > 0) await batch.commit();
  return {
    fields: {
      fanoutAttempt: attempt,
      fanoutTotal: recipientIds.length,
      fanoutChunkCount: index,
      fanoutNextChunk: 0,
      fanoutProcessed: 0,
      fanoutStartedAtMs: nowMs,
      fanoutRosterReady: true,
    },
    chunks: inMemory,
  };
}

/** Why a worker did not get to run. */
export type LeaseRefusal = 'held' | 'not-running' | 'cancel-requested';

export interface LeaseResult {
  acquired: boolean;
  refusal?: LeaseRefusal;
  /** The row as the lease transaction saw it. */
  row: Record<string, unknown>;
}

/**
 * Takes the fan-out lease on `ref`, or reports who has it.
 *
 * A transaction rather than a `create()` because the lease is a FIELD on a row
 * that already exists, so there is no id to collide on. That makes it weaker
 * than the claim in `sendIdempotency.ts`, which is fine: see the header on why
 * the lease is ordering rather than correctness.
 */
export async function acquireFanoutLease(opts: {
  ref: DocumentReference;
  workerId: string;
  nowMs: number;
  /** Allow taking the lease on a row whose cancel has been requested, to finish stopping it. */
  forCancellation?: boolean;
}): Promise<LeaseResult> {
  const { ref, workerId, nowMs, forCancellation } = opts;
  return ref.firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const row = (snap.data() ?? {}) as Record<string, unknown>;
    if (!snap.exists) return { acquired: false, refusal: 'not-running' as const, row };
    if (row['fanoutState'] !== 'running') {
      return { acquired: false, refusal: 'not-running' as const, row };
    }
    if (forCancellation !== true && typeof row['cancelRequestedAtMs'] === 'number') {
      return { acquired: false, refusal: 'cancel-requested' as const, row };
    }
    const expires = countOf(row, 'fanoutLeaseExpiresAtMs');
    const owner = row['fanoutLeaseOwner'];
    if (owner !== workerId && expires > nowMs) {
      return { acquired: false, refusal: 'held' as const, row };
    }
    tx.set(
      ref,
      {
        fanoutLeaseOwner: workerId,
        fanoutLeaseExpiresAtMs: nowMs + LEASE_MS,
        fanoutUpdatedAtMs: nowMs,
      },
      { merge: true },
    );
    return { acquired: true, row };
  });
}

/**
 * Hands the lease back, so the next tick can pick the blast up immediately
 * rather than waiting out [LEASE_MS].
 *
 * Best-effort: a release that fails is not an error, because an unreleased
 * lease expires on its own. Saying so in a log beats throwing away a fan-out
 * leg that actually succeeded.
 */
export async function releaseFanoutLease(opts: {
  ref: DocumentReference;
  workerId: string;
  patch?: Record<string, unknown>;
  fnName: string;
}): Promise<void> {
  const { ref, workerId, patch, fnName } = opts;
  try {
    await ref.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const row = (snap.data() ?? {}) as Record<string, unknown>;
      // Never clear a lease somebody else now holds: this worker's release is
      // about ITS claim, and a blind clear would evict a live successor.
      const mine = row['fanoutLeaseOwner'] === workerId;
      tx.set(
        ref,
        {
          ...(patch ?? {}),
          ...(mine ? { fanoutLeaseOwner: null, fanoutLeaseExpiresAtMs: 0 } : {}),
          fanoutUpdatedAtMs: Date.now(),
        },
        { merge: true },
      );
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: fnName,
      event: 'fanout.lease.release.failed',
      extra: { path: ref.path, err: (err as Error)?.message },
    });
  }
}

/** What one run of the fan-out did. */
export interface FanoutRunResult {
  /** True when this worker held the lease and walked at least one recipient's worth of roster. */
  ran: boolean;
  /** Set when it did not: who stopped it. */
  refusal?: LeaseRefusal;
  /** True when every chunk is closed, so the fan-out is finished for good. */
  complete: boolean;
  /** True when the run stopped because the operator asked for it. */
  cancelled: boolean;
  /** True when the run stopped because it ran out of budget, so more remains. */
  outOfBudget: boolean;
  /** Durable row totals PLUS the unclosed partial chunk this run holds. */
  totals: FanoutTally;
  /** Recipients accounted for by those totals. */
  processed: number;
  /** Roster size. */
  total: number;
  /**
   * The row as this run last wrote it (or read it, when it closed no chunk).
   *
   * Handed back so a caller can report its own shaped fields — the broadcast's
   * `perChannel` and `reach` — without a read-back round trip against a document
   * this process just wrote.
   */
  rowFields: Record<string, unknown>;
}

/** Reads the markers for a chunk in one batched round trip, keyed by recipient id. */
async function readMarkers(
  ref: DocumentReference,
  attempt: number,
  recipientIds: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (recipientIds.length === 0) return out;
  const markers = ref.collection('fanoutRecipients');
  const refs = recipientIds.map((id) => markers.doc(markerDocId(attempt, id)));
  const snaps = await ref.firestore.getAll(...refs);
  snaps.forEach((snap, i) => {
    if (!snap.exists) return;
    out.set(recipientIds[i], (snap.data() ?? {}) as Record<string, unknown>);
  });
  return out;
}

/** The stored state of one marker, or undefined when there is no marker. */
function markerState(marker: Record<string, unknown> | undefined): MarkerState | undefined {
  const state = marker?.['state'];
  return typeof state === 'string' ? (state as MarkerState) : undefined;
}

/**
 * Claims one recipient, or reports that somebody already has.
 *
 * THE SINGLE POINT OF CORRECTNESS in this file. `create()` is refereed by the
 * server, so two workers reaching the same recipient produce exactly one claim
 * and exactly one send, whatever either of them believes about the lease.
 */
async function claimRecipient(opts: {
  ref: DocumentReference;
  attempt: number;
  recipientId: string;
  chunkIndex: number;
  nowMs: number;
}): Promise<boolean> {
  const { ref, attempt, recipientId, chunkIndex, nowMs } = opts;
  const marker = ref.collection('fanoutRecipients').doc(markerDocId(attempt, recipientId));
  try {
    await marker.create({
      recipientId,
      attempt,
      chunkIndex,
      state: 'claimed' satisfies MarkerState,
      claimedAtMs: nowMs,
    });
    return true;
  } catch (err) {
    if (isAlreadyExists(err)) return false;
    throw err;
  }
}

/**
 * Extra row fields a caller wants folded in when a chunk closes, derived from
 * the chunk's stored markers and the row as the closing transaction saw it.
 *
 * Exists for `broadcastMessage`, whose report is a per-CHANNEL tally that the
 * coarse sent/suppressed/failed tally cannot carry. Deriving it from markers
 * rather than from a counter in the worker's memory is what makes it survive
 * the worker.
 */
export type ChunkRowFields = (
  row: Record<string, unknown>,
  markers: Array<Record<string, unknown>>,
) => Record<string, unknown>;

/** Tallies a chunk from what its markers actually say, stamping any stuck claim abandoned. */
async function tallyChunkFromMarkers(opts: {
  ref: DocumentReference;
  attempt: number;
  recipientIds: readonly string[];
}): Promise<{ tally: FanoutTally; markers: Array<Record<string, unknown>> }> {
  const { ref, attempt, recipientIds } = opts;
  const stored = await readMarkers(ref, attempt, recipientIds);
  const tally = emptyTally();
  const markers: Array<Record<string, unknown>> = [];
  for (const id of recipientIds) {
    const marker = stored.get(id);
    if (marker) markers.push(marker);
    const state = markerState(marker);
    if (state === 'sent') tally.sent += 1;
    else if (state === 'suppressed') tally.suppressed += 1;
    else if (state === 'failed') tally.failed += 1;
    else if (state === 'abandoned') tally.abandoned += 1;
    else {
      // Either a claim whose worker died before it wrote an outcome, or no
      // marker at all (which cannot happen for a chunk we just walked, and is
      // still counted rather than silently dropped). Never retried: see the
      // header on why a claim is taken BEFORE the send.
      await ref
        .collection('fanoutRecipients')
        .doc(markerDocId(attempt, id))
        .set(
          { recipientId: id, attempt, state: 'abandoned' satisfies MarkerState, abandonedAtMs: Date.now() },
          { merge: true },
        );
      tally.abandoned += 1;
    }
  }
  return { tally, markers };
}

/**
 * Closes a chunk and folds its tally into the row, once and only once.
 *
 * The transaction re-reads the chunk and refuses if it is already `done`, so a
 * second worker that walked the same chunk cannot double the row's counts. That
 * is the counting twin of the per-recipient claim: the claim stops a second
 * SEND, this stops a second COUNT.
 */
async function closeChunk(opts: {
  ref: DocumentReference;
  chunkRef: DocumentReference;
  tally: FanoutTally;
  markers: Array<Record<string, unknown>>;
  chunkRowFields?: ChunkRowFields;
  size: number;
  index: number;
  nowMs: number;
}): Promise<Record<string, unknown> | null> {
  const { ref, chunkRef, tally, markers, chunkRowFields, size, index, nowMs } = opts;
  return ref.firestore.runTransaction(async (tx) => {
    const chunkSnap = await tx.get(chunkRef);
    const chunk = (chunkSnap.data() ?? {}) as Record<string, unknown>;
    if (chunk['state'] === 'done') return null;
    const rowSnap = await tx.get(ref);
    const row = (rowSnap.data() ?? {}) as Record<string, unknown>;
    tx.set(
      chunkRef,
      { state: 'done', doneAtMs: nowMs, tally },
      { merge: true },
    );
    const patch: Record<string, unknown> = {
      // Caller-shaped row fields, computed from the chunk's MARKERS rather than
      // from any in-memory counter, so a transaction retry recomputes the same
      // delta and a resumed run does not lose what a dead one did. This is how
      // `broadcastMessage` keeps its per-channel tally honest across a hand-off;
      // see its `broadcastChunkRowFields`.
      ...(chunkRowFields ? chunkRowFields(row, markers) : {}),
      // `failed` carries abandoned claims too. They are the same fact to an
      // operator (this household did not get it) and splitting them on the
      // screen would be pipeline detail on a campaign card.
      dispatched: countOf(row, 'dispatched') + tally.sent,
      suppressed: countOf(row, 'suppressed') + tally.suppressed,
      failed: countOf(row, 'failed') + tally.failed + tally.abandoned,
      fanoutProcessed: countOf(row, 'fanoutProcessed') + size,
      fanoutNextChunk: Math.max(countOf(row, 'fanoutNextChunk'), index + 1),
      fanoutUpdatedAtMs: nowMs,
    };
    tx.set(ref, patch, { merge: true });
    // The patch is handed BACK rather than re-read afterwards. A run that closed
    // a chunk already knows the row's totals, because it just computed them from
    // the row the transaction read and the chunk's markers; re-reading would be
    // an extra round trip for an answer that could only be the same or newer,
    // and "newer" here means another worker's write, which is not what this
    // invocation should report having done.
    return patch;
  });
}

/**
 * Walks the frozen roster from wherever it was left, until the roster is
 * exhausted, the budget runs out, or the operator cancels.
 *
 * `sendOne` is passed in rather than imported, and that is not a style choice.
 * `test/notificationProvenance.test.ts` asserts that the set of files calling
 * `enqueueNotification` or `resolveChannels` is EXACTLY the set of files named
 * in `notifications/provenance.ts`, so that no emitter can land undocumented.
 * Pulling either call into this shared engine would make this file an
 * undocumented emitter of every catalog key any caller uses. Keeping the send
 * at its own call site keeps provenance true and keeps the key literals in the
 * file that claims to send them.
 */
export async function runFanout(opts: {
  ref: DocumentReference;
  workerId: string;
  /** Wall-clock instant this run must stop by. Checked per RECIPIENT, not per chunk. */
  deadlineMs: number;
  /**
   * Reaches one recipient and reports what happened. May write its own detail
   * onto the marker by returning it alongside the outcome; that detail is what
   * [chunkRowFields] later folds into the row.
   */
  sendOne: (recipientId: string) => Promise<RecipientOutcome | { outcome: RecipientOutcome; detail: Record<string, unknown> }>;
  fnName: string;
  /** True when this worker already holds the lease (the callable took it to arm the row). */
  leaseHeld?: boolean;
  chunkRowFields?: ChunkRowFields;
  /**
   * The roster this run already holds in memory, and the row as the caller just
   * wrote it.
   *
   * Only the INLINE leg can pass these, because only it just built them. It
   * saves a read per chunk plus a read of a row this invocation wrote a
   * millisecond ago. A resume passes neither and reads both, which is the point:
   * it has no memory of the run it is continuing.
   */
  armed?: { row: Record<string, unknown>; chunks: ReadonlyArray<readonly string[]> };
}): Promise<FanoutRunResult> {
  const { ref, workerId, deadlineMs, sendOne, fnName, leaseHeld, chunkRowFields, armed } = opts;

  let row: Record<string, unknown>;
  if (armed) {
    row = armed.row;
  } else if (leaseHeld === true) {
    row = ((await ref.get()).data() ?? {}) as Record<string, unknown>;
  } else {
    const lease = await acquireFanoutLease({ ref, workerId, nowMs: Date.now() });
    if (!lease.acquired) {
      const stored = lease.row;
      return {
        ran: false,
        refusal: lease.refusal,
        complete: stored['fanoutState'] === 'complete',
        cancelled: stored['fanoutState'] === 'cancelled',
        outOfBudget: false,
        totals: {
          sent: countOf(stored, 'dispatched'),
          suppressed: countOf(stored, 'suppressed'),
          failed: countOf(stored, 'failed'),
          abandoned: 0,
        },
        processed: countOf(stored, 'fanoutProcessed'),
        total: countOf(stored, 'fanoutTotal'),
        rowFields: stored,
      };
    }
    row = lease.row;
  }

  const attempt = countOf(row, 'fanoutAttempt');
  const chunkCount = countOf(row, 'fanoutChunkCount');
  const total = countOf(row, 'fanoutTotal');
  const chunks = ref.collection('fanoutChunks');

  // The partial chunk this run is inside. It contributes to the reply but NOT
  // to the row, because an unclosed chunk is not a durable fact.
  let partial = emptyTally();
  let partialProcessed = 0;
  let cancelled = false;
  let outOfBudget = false;
  let index = countOf(row, 'fanoutNextChunk');
  let sinceHeartbeat = 0;
  // The row as this run last WROTE it, which is what the reply is built from.
  // Seeded with the row the lease read, so a run that closes no chunk still
  // reports what is stored rather than nothing.
  let rowFields: Record<string, unknown> = row;

  chunkLoop: for (; index < chunkCount; index += 1) {
    const chunkRef = chunks.doc(chunkDocId(attempt, index));
    let recipientIds: string[];
    if (armed) {
      recipientIds = [...(armed.chunks[index] ?? [])];
    } else {
      const chunkSnap = await chunkRef.get();
      const chunk = (chunkSnap.data() ?? {}) as Record<string, unknown>;
      if (!chunkSnap.exists) {
        // A roster chunk the row promised and Firestore does not hold. Nothing
        // can be sent from it and skipping silently would leave the walk stuck
        // on it forever, so it is logged and stepped over.
        logEvent({
          severity: 'warn',
          function: fnName,
          event: 'fanout.chunk.missing',
          extra: { path: chunkRef.path },
        });
        continue;
      }
      if (chunk['state'] === 'done') continue;
      recipientIds = Array.isArray(chunk['recipientIds'])
        ? (chunk['recipientIds'] as unknown[]).filter((v): v is string => typeof v === 'string')
        : [];
    }

    const known = await readMarkers(ref, attempt, recipientIds);
    let finishedChunk = true;

    for (const recipientId of recipientIds) {
      // Anything with a marker is already accounted for, including a stuck
      // `claimed` one: see the header. `tallyChunkFromMarkers` stamps those
      // abandoned when the chunk closes.
      if (known.has(recipientId)) continue;

      if (Date.now() >= deadlineMs) {
        outOfBudget = true;
        finishedChunk = false;
        break;
      }

      if (sinceHeartbeat >= HEARTBEAT_EVERY) {
        sinceHeartbeat = 0;
        const fresh = ((await ref.get()).data() ?? {}) as Record<string, unknown>;
        if (typeof fresh['cancelRequestedAtMs'] === 'number') {
          cancelled = true;
          finishedChunk = false;
          break;
        }
        if (fresh['fanoutLeaseOwner'] !== workerId) {
          // Somebody took the lease over. Stop rather than race: the markers
          // make a race harmless, but two workers on one roster is still twice
          // the Firestore traffic for the same work. The labelled break leaves
          // the chunk OPEN — it is not this worker's to close any more — which
          // is why `finishedChunk` is not set here.
          break chunkLoop;
        }
      }
      sinceHeartbeat += 1;

      const claimed = await claimRecipient({
        ref,
        attempt,
        recipientId,
        chunkIndex: index,
        nowMs: Date.now(),
      });
      if (!claimed) continue;

      let outcome: RecipientOutcome;
      let detail: Record<string, unknown> = {};
      try {
        const said = await sendOne(recipientId);
        if (typeof said === 'string') {
          outcome = said;
        } else {
          outcome = said.outcome;
          detail = said.detail;
        }
      } catch (err) {
        outcome = 'failed';
        logEvent({
          severity: 'warn',
          function: fnName,
          event: 'fanout.recipient.failed',
          extra: { path: ref.path, recipientId, err: (err as Error)?.message },
        });
      }
      await ref
        .collection('fanoutRecipients')
        .doc(markerDocId(attempt, recipientId))
        .set({ ...detail, state: outcome, settledAtMs: Date.now() }, { merge: true });

      partialProcessed += 1;
      if (outcome === 'sent') partial.sent += 1;
      else if (outcome === 'suppressed') partial.suppressed += 1;
      else partial.failed += 1;
    }

    if (!finishedChunk) break;

    const closing = await tallyChunkFromMarkers({ ref, attempt, recipientIds });
    const patch = await closeChunk({
      ref,
      chunkRef,
      tally: closing.tally,
      markers: closing.markers,
      chunkRowFields,
      size: recipientIds.length,
      index,
      nowMs: Date.now(),
    });
    if (patch === null) {
      // Another worker closed this chunk first, so its totals are in the row and
      // not in this run's hand. Read them rather than guess.
      rowFields = ((await ref.get()).data() ?? {}) as Record<string, unknown>;
    } else {
      rowFields = patch;
    }
    // The chunk's durable tally has replaced this run's in-memory one for those
    // recipients, so the partial is cleared rather than added twice.
    partial = emptyTally();
    partialProcessed = 0;
  }

  const durable: FanoutTally = {
    sent: countOf(rowFields, 'dispatched'),
    suppressed: countOf(rowFields, 'suppressed'),
    failed: countOf(rowFields, 'failed'),
    abandoned: 0,
  };
  const complete = !cancelled && countOf(rowFields, 'fanoutNextChunk') >= chunkCount;

  return {
    ran: true,
    complete,
    cancelled,
    outOfBudget,
    totals: addTally(durable, partial),
    processed: countOf(rowFields, 'fanoutProcessed') + partialProcessed,
    total,
    rowFields,
  };
}

/**
 * The fan-out's one-word state for a reader, derived rather than stored.
 *
 * `stalled` is the state #823 asks for by name: a row still saying `running`
 * whose lease expired and whose worker never came back. It is not a fourth
 * stored value, because a stored one would be wrong from the moment the sweep
 * picked the blast up again and nothing would be there to correct it — the same
 * reasoning `blastStatus` already uses for scheduled/sent/cancelled.
 */
export type FanoutProgressState = 'running' | 'stalled' | 'complete' | 'failed' | 'cancelled';

/**
 * A stalled fan-out is one whose lease has been gone for two sweep ticks.
 *
 * One tick would flag every hand-off, because a leg that releases its lease is
 * legitimately unowned until the next tick picks it up.
 */
export const STALLED_AFTER_MS = 120_000;

export function fanoutProgressState(
  row: Record<string, unknown>,
  nowMs: number,
): FanoutProgressState {
  const state = row['fanoutState'];
  if (state === 'complete' || state === 'failed' || state === 'cancelled') return state;
  if (state !== 'running') return 'complete';
  const updated = countOf(row, 'fanoutUpdatedAtMs');
  const leaseExpires = countOf(row, 'fanoutLeaseExpiresAtMs');
  if (leaseExpires > nowMs) return 'running';
  if (updated > 0 && nowMs - updated > STALLED_AFTER_MS) return 'stalled';
  return 'running';
}
