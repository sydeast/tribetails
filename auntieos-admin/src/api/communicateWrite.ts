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
 * only `email` and `sms` (the two channels `Communicate.tsx`'s own "Recent"
 * list already reads back via `listRecentSends`/`sendChannelOf`); `inapp` and
 * `push` are real backend capabilities but have no compose UI anywhere yet
 * (wasm or React) and are left for a follow-up rather than bolted on here
 * un-designed.
 *
 * ── PAYLOAD, confirmed field-for-field against the backend's zod `Args`
 * (broadcastMessage.ts lines 56-79) ─────────────────────────────────────────
 *   segmentId?: string   -- a saved `audience_segments/{id}` (NOT ported here;
 *                           `listAudienceSegments`/`saveAudienceSegment` are a
 *                           separate, un-built admin surface, see the module
 *                           doc below).
 *   criteria?: Criteria  -- inline audience filter, THE path this screen uses.
 *   channels: Channel[]  -- non-empty, de-duped.
 *   subject?: string     -- REQUIRED when 'email' (or 'inapp') is selected
 *                           (the backend's superRefine at lines 73-78); this
 *                           screen enforces the same rule client-side before
 *                           ever calling `sendBroadcast`.
 *   body: string         -- required, 1-5000 chars.
 * One of segmentId/criteria is required (superRefine line 64-67); this module
 * always sends `criteria`, never `segmentId`.
 *
 * ── WHY INLINE CRITERIA, NOT A SEGMENT PICKER ───────────────────────────────
 * `audienceCriteria.ts`'s `CriteriaSchema` (lines 24-46) is a small, closed
 * shape: `all` (every active kinfolk) | `status` (kinfolk whose `status` is in
 * a chosen list) | `tags` (kinfolk carrying chosen tags, `any` or `all` match).
 * Building the SAME criteria inline needs no new dependency (no
 * `listAudienceSegments` port, no saved-segment CRUD); reusing a SAVED segment
 * would. This module ports the criteria shape verbatim so a later segment
 * picker can reuse these exact types without a rewrite.
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

// ── channels this screen ships (see the module doc for why inapp/push wait) ─

export const BROADCAST_CHANNELS = ['email', 'sms'] as const;
export type BroadcastChannel = (typeof BROADCAST_CHANNELS)[number];

// ── send payload / result ───────────────────────────────────────────────────

export interface SendBroadcastArgs {
  criteria: BroadcastCriteria;
  channels: BroadcastChannel[];
  /** Required by the backend when 'email' is in `channels`; validated by the caller before send. */
  subject?: string;
  body: string;
}

/** One channel's outcome tally. Mirrors the backend's `ChannelCounts` (broadcastMessage.ts lines 84-88). */
export interface BroadcastChannelCounts {
  sent: number;
  skipped: number;
  failed: number;
}

/**
 * `broadcastMessage`'s response shape (broadcastMessageHandler's return type,
 * broadcastMessage.ts lines 127-131), narrowed to the two channels this screen
 * sends. The live backend also returns `inapp`/`push` entries in `perChannel`
 * (they are always present, just all-zero when the channel wasn't selected);
 * this module only types the two this screen cares about and reads the rest
 * defensively (see `channelCountsOf` below) rather than assuming the wire
 * shape never grows a field this screen doesn't know about yet.
 */
export interface SendBroadcastResult {
  ok: true;
  broadcastId: string;
  recipientCount: number;
  perChannel: Partial<Record<BroadcastChannel, BroadcastChannelCounts>>;
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
  return call<SendBroadcastArgs, SendBroadcastResult>('broadcastMessage', args);
}
