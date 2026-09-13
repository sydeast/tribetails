import { call } from '../lib/fns';
import type { BroadcastCriteria } from './communicateWrite';

/**
 * Marketing blasts: SCHEDULED campaigns to kinfolk, as against Communicate's
 * broadcast, which sends now.
 *
 * Four callables, all admin-gated, all in MyTribe
 * (`functions/src/admin/{scheduleMarketingBlast,marketingBlasts}.ts`).
 * `scheduleMarketingBlast` was deployed with nothing calling it since May; the
 * other three were added alongside this screen because a screen cannot exist
 * without them (there was no way to preview an audience, list what had been
 * scheduled, or call one back).
 *
 * ── THE AUDIENCE IS THE SAME SHAPE AS EVERYWHERE ELSE ───────────────────────
 * `BroadcastCriteria` (ported from the server's `CriteriaSchema` in
 * `communicateWrite.ts`) is what a broadcast, a saved segment and now a blast
 * all speak. A blast adds one more path, an explicit `audienceUids` list, which
 * is the shape the callable originally took and the mock's "Pick uids" mode.
 * Exactly one of the three goes on the wire; the server refuses two.
 *
 * ── THE FAN-OUT OUTLIVES THE CALL (#823) ────────────────────────────────────
 * `scheduleMarketingBlast` walks its audience for fifteen seconds and hands the
 * rest to a cron sweep, because five thousand recipients at five to six
 * Firestore round trips each cannot finish inside a function's 540-second
 * ceiling. So `pending: true` with `queued` short of `audienceSize` is the
 * ORDINARY reply for any audience past about sixty, not a failure, and
 * `listMarketingBlasts` reports a campaign's progress while it is still being
 * queued. Every count here is a snapshot until `fanoutState` reads 'complete'.
 *
 * ── WHERE THE COPY COMES FROM ───────────────────────────────────────────────
 * NOT from this screen. A blast names a catalog key
 * (`newsletter.announcement` / `survey.event` / `marketing.optin`) and the
 * notification pipeline renders the operator's own template for it
 * (`emailTemplates/{key}`, authored in Template Bank). `data` is the merge
 * context that template is rendered against, which is why this module sends it
 * as a free-form record rather than a fixed subject/body pair: the fields a
 * blast needs are whichever `{{tokens}}` the operator put in their template.
 */

// ── audience ────────────────────────────────────────────────────────────────

/** The three marketing catalog rows `scheduleMarketingBlast` accepts. */
export const MARKETING_KEYS = ['newsletter.announcement', 'survey.event', 'marketing.optin'] as const;
export type MarketingKey = (typeof MARKETING_KEYS)[number];

/** Rail-friendly names for the three keys. The key itself is always shown beside them. */
export const MARKETING_KEY_LABEL: Record<MarketingKey, string> = {
  'newsletter.announcement': 'Newsletter',
  'survey.event': 'Survey or event',
  'marketing.optin': 'Opt-in nudge',
};

/**
 * The audience half of a blast payload: exactly one of the three, never two and
 * never none.
 *
 * `null` is the honest "the form does not describe an audience yet", the same
 * contract `broadcastAudienceArgs` keeps. It is never a `{ kind: 'all' }`
 * fallback, which on a marketing send would silently reach every household on
 * the roster.
 */
export type BlastAudience =
  | { segmentId: string }
  | { criteria: BroadcastCriteria }
  | { audienceUids: string[] };

export function blastAudienceArgs(
  selectedSegmentId: string | null,
  adhocCriteria: BroadcastCriteria | null,
  explicitUids: string[],
  mode: 'segment' | 'criteria' | 'uids',
): BlastAudience | null {
  if (mode === 'segment') {
    return selectedSegmentId !== null && selectedSegmentId !== '' ? { segmentId: selectedSegmentId } : null;
  }
  if (mode === 'uids') {
    return explicitUids.length > 0 ? { audienceUids: explicitUids } : null;
  }
  return adhocCriteria !== null ? { criteria: adhocCriteria } : null;
}

// ── preview ─────────────────────────────────────────────────────────────────

/**
 * What `previewMarketingBlastAudience` returns. Four counted facts, not one
 * number with three caveats:
 *
 *   matched            households (or named accounts) the selection hit
 *   noLinkedAccount    of those, the ones with no MyTribe account to notify
 *   suppressedByPrefs  linked accounts whose marketing opt-in is absent, or
 *                      whose gate the operator turned off
 *   reachable          what is actually left
 *
 * The server computes `suppressedByPrefs` by running the dispatcher's own
 * `resolveChannels`, so this is a prediction of the send rather than an
 * estimate of it.
 */
export interface BlastReach {
  description: string;
  matched: number;
  noLinkedAccount: number;
  suppressedByPrefs: number;
  reachable: number;
}

interface PreviewResponse {
  ok: true;
  description?: string;
  matched?: number;
  noLinkedAccount?: number;
  suppressedByPrefs?: number;
  reachable?: number;
}

/** Defensive number read. A missing field reads as 0 only because the server always sends all four. */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export async function previewBlastAudience(key: MarketingKey, audience: BlastAudience): Promise<BlastReach> {
  const res = await call<{ key: MarketingKey } & BlastAudience, PreviewResponse>(
    'previewMarketingBlastAudience',
    { key, ...audience },
  );
  return {
    description: typeof res.description === 'string' ? res.description : '',
    matched: num(res.matched),
    noLinkedAccount: num(res.noLinkedAccount),
    suppressedByPrefs: num(res.suppressedByPrefs),
    reachable: num(res.reachable),
  };
}

// ── schedule ────────────────────────────────────────────────────────────────

export interface ScheduleBlastArgs {
  key: MarketingKey;
  /** Epoch millis. The server refuses anything more than 60s in the past. */
  fireAtMs: number;
  audience: BlastAudience;
  /** Merge context the operator's template for `key` is rendered against. */
  data: Record<string, unknown>;
  /** The operator's own name for this campaign. Optional; the key is the fallback in the list. */
  title?: string;
  /**
   * #814. Minted once per SUBMISSION by `lib/sendIdempotency.ts` and held across
   * every attempt at it. Required here, not optional: see the guard below.
   */
  idempotencyKey: string;
}

export interface ScheduleBlastResult {
  blastId: string;
  matched: number;
  noLinkedAccount: number;
  dispatched: number;
  suppressed: number;
  failed: number;
  /** #814. The blast already existed: this call queued nothing. */
  deduped: boolean;
  /** #814. Its fan-out has not finished, so the counts are a snapshot. */
  pending: boolean;
  /** #823. Recipients accounted for so far, out of `audienceSize`. */
  queued: number;
  /** #823. The frozen roster's size: everyone this blast will reach. */
  audienceSize: number;
}

export async function scheduleBlast(args: ScheduleBlastArgs): Promise<ScheduleBlastResult> {
  if (!args.idempotencyKey) {
    // #814: refused rather than silently sent unkeyed. The call below opts into
    // a retry on `functions/internal`, and the ONE thing that makes that safe is
    // the server deduping on this key. A caller that forgot it would send the
    // whole audience a second marketing email, which cannot be recalled. Same
    // refusal as `createMultiDateBookingRequest` in `api/bookingsWrite.ts`.
    throw new Error('scheduleBlast needs an idempotencyKey. See lib/sendIdempotency.ts.');
  }
  const title = (args.title ?? '').trim();
  const res = await call<Record<string, unknown>, Partial<ScheduleBlastResult> & { ok: true; blastId: string }>(
    'scheduleMarketingBlast',
    {
      key: args.key,
      fireAtMs: args.fireAtMs,
      ...args.audience,
      data: args.data,
      // The server's zod requires min(1) when present, so a blank title has to
      // be absent rather than empty.
      ...(title !== '' ? { title } : {}),
      idempotencyKey: args.idempotencyKey,
    },
    // #814: one retry on a transport failure, safe only because of the key. A
    // deadline is untouched, so the 20s budget stays the visible, operator-driven
    // retry it was built to be, and that retry now lands on the same key.
    { idempotent: true },
  );
  return {
    blastId: res.blastId,
    matched: num(res.matched),
    noLinkedAccount: num(res.noLinkedAccount),
    dispatched: num(res.dispatched),
    suppressed: num(res.suppressed),
    failed: num(res.failed),
    deduped: res.deduped === true,
    pending: res.pending === true,
    queued: num(res.queued),
    audienceSize: num(res.audienceSize),
  };
}

// ── list + cancel ───────────────────────────────────────────────────────────

/**
 * #823 added three. `sending` is a campaign whose fan-out is still walking the
 * roster, `cancelling` one whose stop has been asked for and not yet confirmed,
 * and `failed` one whose fan-out never armed, so nothing was queued and nothing
 * ever will be.
 */
export type BlastStatus = 'scheduled' | 'sending' | 'sent' | 'cancelling' | 'cancelled' | 'failed';

/** #823. How the fan-out itself is doing, beside the campaign's own status. */
export type BlastFanoutState = 'running' | 'stalled' | 'complete' | 'failed' | 'cancelled';

export interface MarketingBlast {
  id: string;
  key: string;
  title: string;
  fireAtMs: number;
  status: BlastStatus;
  audienceDescription: string;
  matched: number;
  noLinkedAccount: number;
  dispatched: number;
  suppressed: number;
  failed: number;
  cancelledAtMs: number | null;
  /** #823. `stalled` is running with a long-dead lease: queueing that stopped moving. */
  fanoutState: BlastFanoutState;
  /** #823. Recipients accounted for, out of `audienceSize`. */
  queued: number;
  /** #823. The frozen roster's size. 0 on a campaign written before this shipped. */
  audienceSize: number;
}

const BLAST_STATUSES: readonly BlastStatus[] = [
  'scheduled',
  'sending',
  'sent',
  'cancelling',
  'cancelled',
  'failed',
];

/**
 * An unknown status from a future deploy reads as 'scheduled', which is the one
 * that still offers Cancel, so the operator keeps a way to act on a campaign
 * this build does not understand.
 */
function narrowStatus(v: unknown): BlastStatus {
  return BLAST_STATUSES.includes(v as BlastStatus) ? (v as BlastStatus) : 'scheduled';
}

const FANOUT_STATES: readonly BlastFanoutState[] = [
  'running',
  'stalled',
  'complete',
  'failed',
  'cancelled',
];

/**
 * An unknown fan-out state reads as 'complete', and so does a missing one: a
 * campaign from a backend that does not report progress is not in flight, and a
 * progress bar that could never move would be worse than no progress bar.
 */
function narrowFanoutState(v: unknown): BlastFanoutState {
  return FANOUT_STATES.includes(v as BlastFanoutState) ? (v as BlastFanoutState) : 'complete';
}

interface ListResponse {
  ok: true;
  blasts?: Array<Partial<MarketingBlast> & { id?: string }>;
}

/**
 * Every blast, newest fire time first (the server orders it; this re-sorts
 * anyway because a row with no `fireAtMs` would otherwise sit wherever the
 * server's index happened to leave it).
 *
 * A row with no id is dropped: it could never be cancelled, so rendering a
 * Cancel button beside it would be a button that cannot work.
 */
export async function listMarketingBlasts(limit?: number): Promise<MarketingBlast[]> {
  const res = await call<{ limit?: number }, ListResponse>(
    'listMarketingBlasts',
    limit === undefined ? {} : { limit },
  );
  const rows = Array.isArray(res.blasts) ? res.blasts : [];
  return rows
    .filter((r): r is typeof r & { id: string } => typeof r.id === 'string' && r.id !== '')
    .map((r) => ({
      id: r.id,
      key: typeof r.key === 'string' ? r.key : '',
      title: typeof r.title === 'string' ? r.title : '',
      fireAtMs: num(r.fireAtMs),
      // Narrowed rather than cast: an unknown status from a future deploy reads
      // as 'scheduled', which is the one that still offers Cancel, so the
      // operator keeps a way to act on a row this build does not understand.
      status: narrowStatus(r.status),
      audienceDescription: typeof r.audienceDescription === 'string' ? r.audienceDescription : '',
      matched: num(r.matched),
      noLinkedAccount: num(r.noLinkedAccount),
      dispatched: num(r.dispatched),
      suppressed: num(r.suppressed),
      failed: num(r.failed),
      cancelledAtMs: typeof r.cancelledAtMs === 'number' ? r.cancelledAtMs : null,
      fanoutState: narrowFanoutState(r.fanoutState),
      queued: num(r.queued),
      audienceSize: num(r.audienceSize),
    }))
    .sort((a, b) => b.fireAtMs - a.fireAtMs);
}

export interface CancelBlastResult {
  /** Queued copies deleted by this call. */
  cancelled: number;
  /**
   * #823. False when the blast was still being queued, so the fan-out was ASKED
   * to stop rather than proven to have stopped. The sweep confirms it within a
   * minute, and the campaign reads 'cancelling' until it does.
   */
  stopped: boolean;
  /** #823. Recipients the frozen roster still held that were never queued at all. */
  neverQueued: number;
}

/**
 * Cancels a scheduled blast.
 *
 * Throws `failed-precondition` "already_fired" when there is nothing left to
 * stop, the fire time has passed AND the fan-out is finished, which the screen
 * surfaces rather than hiding: a cancel that came too late is something the
 * operator needs to know. A blast still being queued past its own fire time is
 * NOT that case and is cancellable, because its un-queued remainder is real.
 */
export async function cancelMarketingBlast(blastId: string): Promise<CancelBlastResult> {
  const res = await call<
    { blastId: string },
    { ok: true; cancelled?: number; stopped?: boolean; neverQueued?: number }
  >('cancelMarketingBlast', { blastId });
  return {
    cancelled: num(res.cancelled),
    // `!== false` rather than `=== true`: a backend older than #823 sends
    // neither field and really did finish the cancel synchronously, so the
    // honest reading for it is "stopped".
    stopped: res.stopped !== false,
    neverQueued: num(res.neverQueued),
  };
}
