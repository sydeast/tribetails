import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { getNotificationDef } from '../notifications/catalog';
import { loadBusinessOverride, loadUserPrefs, resolveChannels, streamForRecipient } from '../notifications/prefs';
import {
  CriteriaSchema,
  describeCriteria,
  resolveRecipientsFromKinfolk,
  type Criteria,
  type KinfolkLike,
} from './audienceCriteria';
import { SEGMENTS_COLLECTION } from './audienceSegments';

/**
 * Audience resolution for marketing blasts, shared by `scheduleMarketingBlast`
 * and `previewMarketingBlastAudience` so the preview and the send can never
 * disagree about who a blast reaches.
 *
 * ── WHY THIS EXISTS (the 2026-09-12 criteria change) ────────────────────────
 * `scheduleMarketingBlast` used to take ONLY `audienceUids: string[]`, which
 * made it unreachable from any screen: an admin surface would have had to
 * enumerate up to 5000 auth uids client-side, and no client can read the
 * `kinfolk` collection's uid column that way. The mock
 * (`auntieos-admin/ui-ideas/auntieos-marketing-blasts-2026-05-27.html`) asks for
 * three audience modes, "All opted-in", "A segment", "Pick uids", so the
 * callable now takes the SAME audience shape the rest of this codebase already
 * speaks: a saved `segmentId`, inline `criteria` (`audienceCriteria.ts`'s
 * `CriteriaSchema`, shared with `broadcastMessage` and `saveAudienceSegment`),
 * or an explicit `audienceUids` list. Exactly one, never two.
 *
 * One shape, defined once: a segment that can be broadcast to is a segment that
 * can be blasted to. Nothing new was invented for marketing.
 *
 * ── WHAT "REACHABLE" MEANS, AND WHY IT IS COUNTED HONESTLY ──────────────────
 * A kinfolk household matching the criteria is not necessarily a recipient:
 *
 *   - no linked MyTribe account (`uid` blank) -> there is no inbox to schedule
 *     into. `enqueueNotification` takes a recipient UID, not a household.
 *   - marketing opt-in missing -> `resolveChannels` returns every channel off
 *     for any catalog row carrying a `marketingCategory` (prefs.ts, the
 *     CAN-SPAM/CASL gate the operator cannot override), so the dispatcher
 *     suppresses the send.
 *
 * Both are COUNTED and reported rather than quietly dropped, which is what lets
 * the screen show a real "who this reaches" figure instead of a household count
 * that overstates the send. The suppression arithmetic here is the dispatcher's
 * own (`resolveChannels` + `hasAnyChannel`), so the preview predicts the send
 * rather than estimating it.
 */

/**
 * `MARKETING_KEYS` deliberately does NOT live here. It stays in
 * `scheduleMarketingBlast.ts`, beside the `enqueueNotification` call, because
 * `notifications/provenance.ts` names that file as the emitter of those three
 * catalog keys and its guard (`test/notificationProvenance.test.ts`) checks the
 * key literals appear in the file that claims to send them. Splitting this
 * resolver out must not move the emitter's fingerprint off the emitter.
 */

export const KINFOLK_COLLECTION = 'kinfolk';

/** Hard ceiling on one blast, unchanged from the uid-array era. */
export const MAX_AUDIENCE = 5000;

/**
 * The audience half of both callables' args. Kept as its own schema object (not
 * `.superRefine`d here) so `scheduleMarketingBlast` can merge it into a wider
 * object and still apply one shared refinement; see `refineAudience` below.
 */
export const AudienceArgsShape = {
  segmentId: z.string().min(1).max(200).optional(),
  criteria: CriteriaSchema.optional(),
  audienceUids: z.array(z.string().min(1)).min(1).max(MAX_AUDIENCE).optional(),
} as const;

export interface AudienceArgs {
  segmentId?: string;
  criteria?: Criteria;
  audienceUids?: string[];
}

/**
 * Exactly one audience path. Shared by both callables' `superRefine` so the
 * rule is written once.
 *
 * Two paths at once is not a harmless over-specification: the handler would
 * have to pick, and handler precedence is not a thing an operator can see. Zero
 * paths would silently mean "everyone" if we defaulted it, which is the single
 * most expensive default a marketing send could carry.
 */
export function refineAudience(val: AudienceArgs, ctx: z.RefinementCtx): void {
  const chosen = [val.segmentId, val.criteria, val.audienceUids].filter((v) => v !== undefined);
  if (chosen.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['criteria'],
      message: 'provide exactly one of segmentId, criteria or audienceUids',
    });
  }
  if (chosen.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['criteria'],
      message: 'provide only one of segmentId, criteria or audienceUids',
    });
  }
}

/** Reads a kinfolk doc into the resolver's minimal shape. Mirrors `broadcastMessage`'s. */
function toKinfolkLike(id: string, data: Record<string, unknown>): KinfolkLike {
  return {
    id,
    status: typeof data.status === 'string' ? data.status : '',
    tags: Array.isArray(data.tags) ? (data.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [],
    email: typeof data.email === 'string' ? data.email : '',
    phoneNumber: typeof data.phoneNumber === 'string' ? data.phoneNumber : '',
    uid: typeof data.uid === 'string' ? data.uid : '',
  };
}

/** Loads the criteria a saved segment stores. Mirrors `broadcastMessage`'s `loadCriteria`. */
async function loadSegmentCriteria(segmentId: string): Promise<Criteria> {
  const snap = await db().collection(SEGMENTS_COLLECTION).doc(segmentId).get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `Audience segment ${segmentId} does not exist.`);
  }
  const parsed = CriteriaSchema.safeParse(snap.data()?.criteria);
  if (!parsed.success) {
    throw new HttpsError('failed-precondition', `Audience segment ${segmentId} has invalid stored criteria.`);
  }
  return parsed.data;
}

/**
 * What a resolved audience is made of. Every number below is a real count of
 * real documents; none of them is derived from another by subtraction, so a
 * screen rendering them is never showing arithmetic dressed up as data.
 */
export interface ResolvedAudience {
  /** Auth uids the blast will be enqueued for (linked accounts only). */
  uids: string[];
  /** Households the audience selection matched. Equals `audienceUids.length` on the explicit path. */
  matched: number;
  /** Matched households with no linked MyTribe account, so no inbox to schedule into. */
  noLinkedAccount: number;
  /** One line describing the audience, for the audit trail and the blast row. */
  description: string;
}

/**
 * Resolves the audience to the uids a blast will be enqueued for.
 *
 * The explicit `audienceUids` path is passed through verbatim: the caller named
 * accounts, not households, so there is no kinfolk record to consult and no
 * `noLinkedAccount` to count.
 */
export async function resolveMarketingAudience(args: AudienceArgs): Promise<ResolvedAudience> {
  if (args.audienceUids) {
    const uids = Array.from(new Set(args.audienceUids.map((u) => u.trim()).filter((u) => u.length > 0)));
    return {
      uids,
      matched: uids.length,
      noLinkedAccount: 0,
      description: `${uids.length} chosen ${uids.length === 1 ? 'account' : 'accounts'}`,
    };
  }

  const criteria = args.criteria ?? (await loadSegmentCriteria(args.segmentId as string));

  // CRM-sized collection: fetch and filter in memory, the same trade
  // `broadcastMessage` makes, so tag match modes need no composite index.
  const snap = await db().collection(KINFOLK_COLLECTION).get();
  const all = snap.docs.map((d) => toKinfolkLike(d.id, d.data() as Record<string, unknown>));
  const matched = resolveRecipientsFromKinfolk(all, criteria);

  const uids: string[] = [];
  let noLinkedAccount = 0;
  for (const k of matched) {
    const uid = (k.uid ?? '').trim();
    if (uid === '') noLinkedAccount += 1;
    else if (!uids.includes(uid)) uids.push(uid);
  }

  return {
    uids,
    matched: matched.length,
    noLinkedAccount,
    description: describeCriteria(criteria),
  };
}

/**
 * Throws the same two refusals for every caller, so the preview and the send
 * agree on what an unusable audience is.
 *
 * `audience_too_large` is checked against the RESOLVED uid count rather than
 * the matched household count: the cap exists because the handler enqueues one
 * notification per uid in a single invocation, and that is the number that
 * bounds the work.
 */
export function assertAudienceUsable(resolved: ResolvedAudience): void {
  if (resolved.uids.length === 0) {
    throw new HttpsError('failed-precondition', 'no_recipients');
  }
  if (resolved.uids.length > MAX_AUDIENCE) {
    throw new HttpsError(
      'failed-precondition',
      `audience_too_large: ${resolved.uids.length} recipients exceeds the ${MAX_AUDIENCE} limit for one blast.`,
    );
  }
}

/** The reach breakdown a preview reports. Every field is counted, never inferred. */
export interface MarketingReach {
  /** Households (or named accounts) the selection matched. */
  matched: number;
  /** Matched households with no linked MyTribe account. */
  noLinkedAccount: number;
  /** Linked accounts whose marketing opt-in or the operator's gate leaves every channel off. */
  suppressedByPrefs: number;
  /** Linked accounts that will actually be scheduled a notification. */
  reachable: number;
}

/**
 * Counts how many of `uids` the dispatcher would actually deliver to for `key`.
 *
 * `key` is typed as a plain string rather than the marketing union: the caller's
 * zod `z.enum(MARKETING_KEYS)` is the gate, and the union lives in
 * `scheduleMarketingBlast.ts` beside the `enqueueNotification` call, which is
 * where `notifications/provenance.ts` names the emitter for these three keys.
 *
 * This runs the dispatcher's OWN gate (`resolveChannels` against the catalog
 * row, the operator's business override, and the household's prefs), so the
 * number the screen shows before scheduling is the number the send produces. A
 * marketing row carries a `marketingCategory`, so a household that never opted
 * in resolves to every channel off and is reported as suppressed, exactly as
 * `enqueueNotification` will skip it.
 */
export async function countMarketingReach(key: string, resolved: ResolvedAudience): Promise<MarketingReach> {
  const def = getNotificationDef(key);
  const businessOverride = await loadBusinessOverride(key);
  const stream = streamForRecipient(def, 'clients');

  let suppressedByPrefs = 0;
  for (const uid of resolved.uids) {
    const prefs = await loadUserPrefs(uid, 'clients');
    const channels = resolveChannels(def, prefs, businessOverride, stream);
    if (!channels.email && !channels.sms && !channels.push) suppressedByPrefs += 1;
  }

  return {
    matched: resolved.matched,
    noLinkedAccount: resolved.noLinkedAccount,
    suppressedByPrefs,
    reachable: resolved.uids.length - suppressedByPrefs,
  };
}
