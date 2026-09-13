import { call } from '../lib/fns';

/**
 * Communicate COMPOSE / BROADCAST write surface: the send path the read-only
 * `Communicate.tsx` ("Recent") screen deferred (see that file's module doc,
 * "Everything else on the wasm screen ... is compose/write surface and is
 * deliberately OUT of scope here"). This module is that surface's api layer.
 *
 * Backend confirmed live: `broadcastMessage`
 * (MyTribe/functions/src/admin/broadcastMessage.ts, `wrapAdminCallable`-gated,
 * `onCall` at line 333). Sends one admin-authored message to every kinfolk a
 * segment/criteria resolves to, across one or more channels (`inapp` | `email`
 * | `sms` | `push`, `ALL_BROADCAST_CHANNELS` at line 53). This screen ships
 * `email`, `sms`, and `push`. Push sends a real FCM multicast against the
 * recipient's `fcm_tokens` (broadcastMessage.ts:250-278), counted per RECIPIENT
 * rather than per device, so a Kinfolk with three phones counts once.
 *
 * `inapp` is a backend channel that ships with full compose UI support
 * (CommunicateCompose.tsx). It requires a subject (broadcastMessage.ts:76) and
 * writes a notification doc consumed by the MyTribe portal feed.
 *
 * ── PAYLOAD, confirmed field-for-field against the backend's zod `Args`
 * (broadcastMessage.ts lines 56-79) ─────────────────────────────────────────
 *   segmentId?: string   -- a saved `audience_segments/{id}`. The segment
 *                           picker is implemented; `listAudienceSegments`,
 *                           `saveAudienceSegment`, and `deleteAudienceSegment`
 *                           ship in `api/audienceSegments.ts`. The screen can
 *                           send either a saved segment or inline criteria.
 *   criteria?: Criteria  -- inline audience filter, one path this screen uses.
 *   channels: Channel[]  -- non-empty, de-duped.
 *   subject?: string     -- REQUIRED when 'email' (or 'inapp') is selected
 *                           (the backend's superRefine at lines 73-78); this
 *                           screen enforces the same rule client-side before
 *                           ever calling `sendBroadcast`.
 *   body: string         -- required, 1-5000 chars.
 * One of segmentId/criteria is required (superRefine line 64-67); this module
 * can send either, resolved by `lib/audienceSegmentEdit.ts#broadcastAudienceArgs`.
 *
 * ── INLINE CRITERIA AND SAVED SEGMENTS ──────────────────────────────────────
 * `audienceCriteria.ts`'s `CriteriaSchema` (lines 24-46) is a small, closed
 * shape: `all` (every active kinfolk) | `status` (kinfolk whose `status` is in
 * a chosen list) | `tags` (kinfolk carrying chosen tags, `any` or `all` match).
 * The compose screen offers both paths for building an audience: inline
 * criteria (no saved-segment dependency) or a saved segment from the catalog
 * (`api/audienceSegments.ts`). This module ports the criteria shape so either
 * path can reuse these exact types without a rewrite.
 *
 * ── NO PRE-SEND RECIPIENT COUNT: A DELIBERATE, RESEARCHED DEFERRAL ─────────
 * The confirm step below shows an audience DESCRIPTION (`describeAudience`,
 * a straight port of the backend's `describeCriteria`, `audienceCriteria.ts`
 * lines 101-112) rather than a live "N recipients" figure, because no such
 * figure exists to show honestly:
 *   - `broadcastMessageHandler` only computes `recipientCount` AFTER it has
 *     already sent (it resolves `kinfolk` server-side inside the handler,
 *     lines 154-160, and only returns the count in its response, line 330).
 *     There is no separate preview/count/dry-run callable anywhere in
 *     MyTribe/functions (grepped for previewAudience / countRecipients /
 *     previewSegment / resolveAudience / estimateRecipients: no matches).
 *   - The wasm reference this screen ports does the identical thing: its
 *     `BroadcastForm` (CommunicateScreen.kt) never shows a pre-send count
 *     either; the ONLY recipient number anywhere in that screen is the
 *     post-send `broadcastSummary()` string ("Reached N kinfolk..."), built
 *     from the callable's response (Broadcast.kt).
 * Fabricating a number the backend has never computed would be exactly the
 * "confident wrong number" class of bug the project's fail-loud policy
 * exists to prevent (see `lib/async.ts`'s doc on the 2026-07-15 StatCard
 * findings: `?: 0` reading as truth on a failed load). Showing the REAL count
 * only once it is real (in the post-send result) is the honest version of
 * the ask; see `CommunicateCompose.tsx` for where that plays out.
 */

// ── audience criteria (ports audienceCriteria.ts's CriteriaSchema) ─────────

export interface BroadcastCriteriaAll {
  kind: 'all';
}
export interface BroadcastCriteriaStatus {
  kind: 'status';
  statuses: string[];
}
export interface BroadcastCriteriaTags {
  kind: 'tags';
  tags: string[];
  tagMatch: 'any' | 'all';
}

export type BroadcastCriteria = BroadcastCriteriaAll | BroadcastCriteriaStatus | BroadcastCriteriaTags;

/**
 * Human-readable one-liner for a criteria, echoed in the confirm Dialog and
 * (were it ever persisted, which this screen does not do) in an audit trail.
 * Ports `describeCriteria` (audienceCriteria.ts lines 101-112) verbatim.
 */
export function describeAudience(criteria: BroadcastCriteria): string {
  switch (criteria.kind) {
    case 'all':
      return 'All active kinfolk';
    case 'status':
      return `Status: ${criteria.statuses.join(', ')}`;
    case 'tags':
      return `Tags (${criteria.tagMatch}): ${criteria.tags.join(', ')}`;
  }
}

// ── channels ────────────────────────────────────────────────────────────────

/**
 * All four channels `broadcastMessage` dispatches, in the server's own order
 * (`ALL_BROADCAST_CHANNELS`, broadcastMessage.ts:53).
 *
 * `inapp` used to be excluded here as "the one backend channel without a
 * compose UI". It has one now. It writes a notification doc the MyTribe portal
 * feed reads, and like email it requires a subject, which becomes the
 * notification title.
 *
 * There is deliberately no KinTale channel. In the archive, KinTale
 * participates as the "Visit report" MESSAGE TYPE in Personalize, not as a
 * broadcast destination, and the dispatcher has no KinTale delivery leg. A
 * KinTale chip here would be a button that cannot deliver.
 */
export const BROADCAST_CHANNELS = ['inapp', 'email', 'sms', 'push'] as const;
export type BroadcastChannel = (typeof BROADCAST_CHANNELS)[number];

// ── send payload / result ───────────────────────────────────────────────────

/**
 * Exactly one of `segmentId` / `criteria`, never both and never neither. The
 * server's superRefine requires at least one; sending both would mean shipping
 * two answers to one question and letting handler precedence pick the audience.
 * `lib/audienceSegmentEdit.ts#broadcastAudienceArgs` is what builds this half.
 */
export interface SendBroadcastArgs {
  /** A saved `audience_segments/{id}`. The server loads its stored criteria. */
  segmentId?: string;
  /** An inline filter built in the form. */
  criteria?: BroadcastCriteria;
  channels: BroadcastChannel[];
  /** Required by the backend when 'email' or 'inapp' is in `channels`; validated by the caller before send. */
  subject?: string;
  body: string;
  /**
   * #814. Minted once per SUBMISSION by `lib/sendIdempotency.ts` and held across
   * every attempt at it, so a dropped reply can be retried without sending the
   * whole audience a second copy. Required here, not optional: see the guard in
   * `sendBroadcast`.
   */
  idempotencyKey: string;
}

/** One channel's outcome tally. Mirrors the backend's `ChannelCounts` (broadcastMessage.ts lines 84-88). */
export interface BroadcastChannelCounts {
  sent: number;
  skipped: number;
  failed: number;
}

/**
 * `broadcastMessage`'s response shape (broadcastMessageHandler's return type,
 * broadcastMessage.ts lines 127-131). All four channels are always present in
 * `perChannel`, just all-zero when the channel was not selected. `Partial`
 * anyway, and read through `channelCountsOf`, because this is a callable
 * response rather than a proof and a screen that renders "undefined skipped"
 * has told the operator nothing.
 */
export interface SendBroadcastResult {
  ok: true;
  broadcastId: string;
  recipientCount: number;
  perChannel: Partial<Record<BroadcastChannel, BroadcastChannelCounts>>;
  /**
   * How far the broadcast actually got, per HOUSEHOLD (#386). `recipientCount`
   * is who the segment MATCHED; this is who heard it, now that every recipient
   * passes through their notification preferences before anything is attempted.
   * Optional, and read through `reachOf`, for the same reason `perChannel` is
   * `Partial`: it is a callable response, and a deployment that predates the
   * field must not make this screen render a fabricated number.
   */
  reach?: BroadcastReach;
  /**
   * #814. True when the server recognised this `idempotencyKey` and answered
   * from the broadcast an earlier attempt already sent. Nothing left the
   * building on this call, and the screen says so rather than reporting a send
   * that did not happen twice. Optional for the same reason `reach` is: a
   * deployment that predates the field must not make this read as `false`
   * when it is really "unknown". `=== true` is the only truthy test used.
   */
  deduped?: boolean;
  /** #814. That earlier attempt's fan-out has not finished, so the counts are a snapshot. */
  pending?: boolean;
}

/** Recipient-level outcome of a broadcast. Mirrors the backend's `BroadcastReach`. */
export interface BroadcastReach {
  /** Households the segment resolved to. */
  targeted: number;
  /** Households that received the broadcast on at least one channel. */
  reached: number;
  /** Households whose notification preferences left every channel off. */
  suppressedByPrefs: number;
}

/**
 * Defensive read of the recipient-level reach. Returns null when the response
 * carries no usable `reach`, so a caller renders "we don't know" rather than a
 * confident zero.
 */
export function reachOf(result: SendBroadcastResult | null | undefined): BroadcastReach | null {
  const r = result?.reach;
  if (
    typeof r?.targeted !== 'number' ||
    typeof r?.reached !== 'number' ||
    typeof r?.suppressedByPrefs !== 'number'
  ) {
    return null;
  }
  return { targeted: r.targeted, reached: r.reached, suppressedByPrefs: r.suppressedByPrefs };
}

/** Defensive read of one channel's counts from a (possibly wider) perChannel map. Never fabricates a nonzero count. */
export function channelCountsOf(
  perChannel: SendBroadcastResult['perChannel'] | null | undefined,
  channel: BroadcastChannel,
): BroadcastChannelCounts {
  const c = perChannel?.[channel];
  return {
    sent: typeof c?.sent === 'number' ? c.sent : 0,
    skipped: typeof c?.skipped === 'number' ? c.skipped : 0,
    failed: typeof c?.failed === 'number' ? c.failed : 0,
  };
}

/**
 * `broadcastMessage` (admin-gated `wrapAdminCallable`): sends `args.body`
 * (and `args.subject` for email) to every kinfolk `args.criteria` resolves to,
 * across `args.channels`. Throws (via `lib/fns.call`) on:
 *   - auth/network failure (unauthenticated, deadline-exceeded, ...)
 *   - `invalid-argument` (zod validation failed server-side)
 *   - `failed-precondition` "no_recipients" (the criteria matched nobody)
 *   - `unavailable` "broadcast_all_failed" (every attempted send failed)
 * Never swallowed: the screen surfaces every one of these fail-loud, exactly
 * the `listRecentSends`/`deleteFormSchema` convention this repo already uses.
 */
export async function sendBroadcast(args: SendBroadcastArgs): Promise<SendBroadcastResult> {
  if (!args.idempotencyKey) {
    // #814: refused rather than silently sent unkeyed. The call below opts into
    // a retry on `functions/internal`, and the only thing that makes that safe
    // is the server deduping on this key, this callable sends real email and
    // SMS, so an unkeyed retry is an unrecallable second copy. Same refusal as
    // `createMultiDateBookingRequest` in `api/bookingsWrite.ts`.
    throw new Error('sendBroadcast needs an idempotencyKey. See lib/sendIdempotency.ts.');
  }
  return call<SendBroadcastArgs, SendBroadcastResult>('broadcastMessage', args, { idempotent: true });
}
