import { createHash } from 'node:crypto';
import { FieldValue, Timestamp, type DocumentReference, type Transaction } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { captureFunctionError } from '../lib/sentry';
import { resolveActor, type ResolvedActor } from '../lib/resolveActor';
import { buildNotificationDetail } from './buildNotificationDetail';
import { getNotificationDef } from './catalog';
import { loadBusinessOverride, loadUserPrefs, resolveChannels, streamForRecipient } from './prefs';
import { resolveRecipients } from './recipientResolver';
import { NoRecipientsError, isRecipientsUnavailable } from './recipientErrors';
import type {
  AudienceStream,
  Channel,
  EnqueueArgs,
  NotificationDef,
  NotificationTargetType,
  ResolvedChannels,
} from './types';

const ALL_CHANNELS: Channel[] = ['email', 'sms', 'push'];

/**
 * The work-order collection. `notificationDispatch/{id}` is id-matched to
 * `notifications/{id}` and holds every field the delivery pipeline needs:
 * mode, channel list, dispatch status, and the per-channel subdocs beneath it.
 *
 * IT USED TO BE THE SAME DOCUMENT, and that was the defect behind operator
 * ruling R5. `notifications/{id}` is mail: it is what an operator or a kinfolk
 * reads and acts on. The dispatch record is plumbing: which transports were
 * chosen, whether the fan-out ran, what the provider said. Both were written to
 * the inbox doc, so the Notifications screen rendered "trigger", "channels:
 * email, sms" and "dispatched" as primary card content, and both admin clients
 * put a "Dispatched" counter in the stat strip. The operator's words: "there are
 * many Activity Log records and workflow (Channels, trigger, and dispatched are
 * activity log not notification) in Notifications."
 *
 * The record of what the pipeline DID is not lost by moving it here, it is
 * promoted: `onNotificationDispatchCreate` writes NOTIFICATION_DISPATCHED and
 * `onNotificationChannelCreate` writes NOTIFICATION_RECEIVED, both into the
 * hash-chained `activity_log`, which is where the operator said this belongs and
 * where the second of those two already went.
 */
export const DISPATCH_COLLECTION = 'notificationDispatch';

/**
 * #832 DECISION (operator to confirm): the dispatcher refuses to deliver the
 * same notification to the same person twice inside this window.
 *
 * WHY 5 MINUTES. The number sits between two bounds read off how notifications
 * are actually sent in this codebase:
 *
 *   - LOWER BOUND, the retry surface. Every admin callable runs under the 60s
 *     default timeout, and a client that timed out retries (or the operator
 *     presses again). A retry lands one to two minutes after the first attempt,
 *     so the window has to comfortably clear that. 5 minutes covers a timeout,
 *     a retry and a second impatient press.
 *   - UPPER BOUND, the catalog's own "these repeats are one event" horizon.
 *     Debounced keys use `debounceMs ?? 30 min`, but a debounce keeps the NEWEST
 *     content; a dedupe drops it. Suppressing later content for as long as a
 *     debounce would lose real updates (a booking changed twice in a quarter
 *     hour). So the window stays well under 30 minutes.
 *
 * WHAT COUNTS AS "THE SAME". `(key, identity, recipientUid)`, where identity is
 * the issue's `targetId` EXTENDED by the per-event id a caller already puts in
 * `data` (see EVENT_ID_FIELDS). The bare tuple is too coarse for live keys:
 * `message.received` (portal/sendKinfolkMessage.ts) targets the HOUSEHOLD, so
 * two different messages inside the window would collapse into one, and the
 * same holds for two comments on one KinTale or two payments on one invoice.
 * A retry of ONE message carries the same messageId and is still refused.
 *
 * One named constant, on purpose: change it here and every notification path
 * moves with it.
 */
export const NOTIFICATION_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

/**
 * The dedupe ledger: one doc per `(key, identity, recipientUid)`, holding when
 * that notification was last delivered and which doc it produced. Server-only
 * (admin SDK); no client reads or writes it, so it needs no rule.
 *
 * GROWTH. A doc is overwritten on every delivery of the SAME notification, but
 * most identities are one-off (a message id, a comment id, a content hash), so
 * left alone the collection grows with every distinct notification ever sent.
 * Each doc therefore carries `expiresAt`, and a Firestore TTL policy on
 * `notificationDedupe.expiresAt` (declared in mytribe/firestore.indexes.json,
 * deployed by the release's indexes step) deletes it once it can no longer
 * matter. See DEDUPE_LEDGER_RETENTION_MS.
 */
export const DEDUPE_COLLECTION = 'notificationDedupe';

/**
 * How long a ledger doc is kept after its last delivery. A doc only matters for
 * NOTIFICATION_DEDUPE_WINDOW_MS; the rest is margin, because Firestore's TTL
 * deletes are not immediate (typically within 24 hours of `expiresAt`) and an
 * operator reading a recent duplicate report wants the entry still there.
 * Nothing reads `expiresAt` to decide a dedupe: the window check uses `lastAtMs`,
 * so a doc the TTL has not reached yet can never suppress a send.
 */
export const DEDUPE_LEDGER_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Per-event ids callers already thread through `data`, most specific first.
 * Each one tells two events on the same target apart. Adding a field here is
 * how a new caller whose events repeat on one target keeps them distinct
 * without passing `dedupeKey`.
 */
const EVENT_ID_FIELDS = [
  'messageId',
  'commentId',
  'noteId',
  'paymentId',
  'stripeEventId',
  'ratingId',
  'incidentId',
  'blastId',
  // `onFamilyKinWrite` targets the HOUSEHOLD and names the pet only here, so
  // two different pets marked inactive back to back would otherwise collapse.
  'kinId',
  // `expireStaleInvites` targets the TRIBE and names the invite only here, so
  // two invites for one tribe expiring in the same nightly run would collapse.
  'inviteId',
] as const;

/**
 * The identity half of the dedupe tuple. '' means "nothing names this event",
 * and such a notification is never deduped: two sends of it cannot be told
 * apart from two genuine events, and refusing one would be a guess.
 */
export function dedupeIdentityOf(
  args: Pick<EnqueueArgs, 'data' | 'dedupeKey' | 'key'>,
  target: { targetType: NotificationTargetType; targetId: string },
): string {
  if (typeof args.dedupeKey === 'string' && args.dedupeKey !== '') return `key:${args.dedupeKey}`;
  const parts: string[] = [];
  if (target.targetId !== '') parts.push(`${target.targetType}:${target.targetId}`);
  const data = args.data ?? {};
  for (const field of EVENT_ID_FIELDS) {
    const v = data[field];
    if (typeof v === 'string' && v !== '') {
      parts.push(`${field}:${v}`);
      break;
    }
  }
  return parts.join('#');
}

/**
 * Hashed because the identity carries caller-supplied ids and a Firestore doc
 * id may not contain `/`. The readable parts are stored on the doc itself.
 */
function dedupeDocId(key: string, identity: string, recipientUid: string): string {
  return createHash('sha256').update(`${key}|${identity}|${recipientUid}`).digest('hex');
}

/**
 * When the notification `key` named by `dedupeKey` last reached `recipientUid`,
 * from the ledger, or null when it never did.
 *
 * READ-ONLY AND ADVISORY. It never decides whether to SEND; `enqueueNotification`
 * does that atomically. It lets a caller recognise that an action it is about to
 * refuse has in fact already been done (#832: `resendQuote` answering a client
 * retry of a resend that completed).
 */
export async function lastDeliveredAtMs(key: string, dedupeKey: string, recipientUid: string): Promise<number | null> {
  if (dedupeKey === '' || recipientUid === '') return null;
  const identity = dedupeIdentityOf({ key, data: {}, dedupeKey }, { targetType: '', targetId: '' });
  const snap = await db().collection(DEDUPE_COLLECTION).doc(dedupeDocId(key, identity, recipientUid)).get();
  const v = snap.exists ? (snap.data() as { lastAtMs?: unknown }).lastAtMs : undefined;
  return typeof v === 'number' ? v : null;
}

/** Timestamp-likes become millis and object keys are sorted, so equal content hashes equally. */
function canonical(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o['toMillis'] === 'function') return (o['toMillis'] as () => number)();
    if (Array.isArray(value)) return value.map(canonical);
    return Object.keys(o)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canonical(o[k]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * A `dedupeKey` that names an event by WHAT IT SAYS (#832).
 *
 * For callers whose events repeat on one target with no per-event id: an
 * invoice edited twice, a visit changed twice, a note added twice. A retry of
 * the same event carries the same content and so the same key, and is deduped;
 * a second real event carries different content and sends. `scope` names the
 * entity and the kind of event, e.g. `invoice:inv1:updated`, because the key
 * REPLACES the derived identity rather than extending it.
 */
export function contentDedupeKey(scope: string, content: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(canonical(content))).digest('hex').slice(0, 32);
  return `${scope}#${digest}`;
}

/** Why a recipient got nothing from one enqueue. */
export type SuppressionReason = 'duplicate' | 'prefs';

export interface Suppression {
  recipientUid: string;
  reason: SuppressionReason;
  /** For 'duplicate': the doc the earlier delivery wrote. */
  existingId?: string;
  /** For 'duplicate': when the earlier delivery happened (ms epoch). */
  lastAtMs?: number;
}

/** #866: a resolver whose lookup FAILED (not one with nobody by definition). */
export interface UnresolvedResolver {
  resolver: string;
  error: string;
}

export interface EnqueueOutcome {
  /** Doc ids written, one per recipient that was delivered to. */
  written: string[];
  /** Every recipient that was NOT delivered to, and why. */
  suppressed: Suppression[];
  /**
   * #866: resolvers whose lookup failed while another resolver still found
   * recipients. Those recipients were delivered to; this audience was not, and a
   * caller that owns a retry (the Stripe webhook, `recordPayment`) retries it.
   * Empty when every resolver answered.
   */
  unresolved: UnresolvedResolver[];
}

/**
 * Resolves the originating entity (targetType + targetId) for a dispatch so the
 * notification doc carries a deep-link reference for open-linked + quick
 * approve/deny in the client.
 *
 * Precedence:
 *   1. Explicit args.targetType / args.targetId from a caller that knows the
 *      entity (booking confirm/request, invoice issued, kintale).
 *   2. Derived from well-known id keys in `args.data` so existing callers that
 *      already thread these ids get a target ref for free.
 *   3. '' for both when nothing is resolvable (always-safe default; never throws).
 */
export function resolveTargetRef(args: EnqueueArgs): {
  targetType: NotificationTargetType;
  targetId: string;
} {
  const explicitType = args.targetType;
  const explicitId = typeof args.targetId === 'string' ? args.targetId : '';
  if (explicitType && explicitId !== '') {
    return { targetType: explicitType, targetId: explicitId };
  }

  const data = args.data ?? {};
  const str = (v: unknown): string => (typeof v === 'string' && v.length > 0 ? v : '');

  // Ordered most-specific first. Booking/invoice/kintale are actionable entities;
  // kinfolk is the catch-all household reference.
  const invoiceId = str(data.invoiceId);
  if (invoiceId) return { targetType: 'invoice', targetId: invoiceId };

  const taleId = str(data.taleId) || str(data.reportId);
  if (taleId) return { targetType: 'kintale', targetId: taleId };

  const bookingId = str(data.bookingId) || str(data.visitId) || str(data.batchId);
  if (bookingId) return { targetType: 'booking', targetId: bookingId };

  const kinfolkId = str(data.kinfolkId) || str(data.familyId);
  if (kinfolkId) return { targetType: 'kinfolk', targetId: kinfolkId };

  return { targetType: '', targetId: '' };
}

/**
 * Single entrypoint for emitting any auto-notification.
 *
 * Behavior by deliveryMode:
 *   trigger   → writes notifications/{auto} → onCreate trigger fans out to channel subdocs
 *   debounced → writes pendingNotifications/{uid}_{key}; bumps fireAfter on collision
 *   batched   → appends to notificationBatch/{uid}/{batchKey}/{auto}
 *   scheduled → writes scheduledNotifications/{auto} with fireAt
 *
 * Caller responsibilities:
 *   - Provide recipientUid for specificUid/kinfolkAcct resolvers.
 *   - Provide args.data.assignedAuntieUid for auntieAssignedToKincare resolver.
 *   - Provide fireAtMs for 'scheduled' mode (defaults to "now" if omitted, logs warning).
 *
 * Returns the list of dispatch document IDs written (one per recipient).
 * Empty array = every recipient was suppressed, by prefs or (#832) because the
 * same notification already reached them inside NOTIFICATION_DEDUPE_WINDOW_MS.
 * A caller that needs to tell those apart uses `enqueueNotificationDetailed`.
 */
export async function enqueueNotification(args: EnqueueArgs): Promise<string[]> {
  return (await enqueueNotificationDetailed(args)).written;
}

/**
 * `enqueueNotification`, reporting per recipient what was suppressed and why.
 */
export async function enqueueNotificationDetailed(args: EnqueueArgs): Promise<EnqueueOutcome> {
  const def = getNotificationDef(args.key);

  // External keys are delivered by another system (e.g., Firebase Auth Console
  // sends password.reset emails). The catalog row exists for documentation /
  // cross-reference only, short-circuit before resolver/channel fan-out.
  if (def.external === true) {
    logEvent({
      severity: 'info',
      function: 'enqueueNotification',
      event: 'notification.external.skipped',
      extra: {
        key: def.key,
        message: `[external] skipping ${def.key}, delivered by external system`,
      },
    });
    return { written: [], suppressed: [], unresolved: [] };
  }

  // #866: TWO KINDS OF "THIS RESOLVER FOUND NOBODY", KEPT APART.
  //   - nobody BY DEFINITION (`recipients-unavailable`: no household uid, no
  //     assigned Auntie, an empty roster): that resolver is empty, as always.
  //   - the lookup FAILED (the office roster read, say): that resolver is empty
  //     for THIS delivery too, so every other audience still gets its copy, as
  //     main delivered it, but the failure is recorded in `unresolved`, logged at
  //     error and reported to Sentry, and a caller that owns a retry can retry it.
  // Only when nobody at all was found does the difference decide the throw: a
  // failed lookup rethrows its own (retryable) error; nobody by definition throws
  // `NoRecipientsError` (final). See notifications/recipientErrors.ts.
  const unresolvedErrors: Array<{ resolver: string; err: unknown }> = [];
  const tryResolve = async (resolver?: typeof def.recipientResolver) => {
    const name = resolver ?? def.recipientResolver;
    try {
      return await resolveRecipients(def, args, resolver);
    } catch (err) {
      if (!isRecipientsUnavailable(err)) {
        unresolvedErrors.push({ resolver: name, err });
        return [];
      }
      logEvent({
        severity: 'info',
        function: 'enqueueNotification',
        event: 'resolver.skipped',
        extra: {
          key: def.key,
          resolver: name,
          err: (err as Error)?.message,
        },
      });
      return [];
    }
  };
  const primary = await tryResolve();
  const secondary = def.secondaryResolver ? await tryResolve(def.secondaryResolver) : [];
  if (primary.length === 0 && secondary.length === 0) {
    if (unresolvedErrors.length > 0) throw unresolvedErrors[0]!.err;
    throw new NoRecipientsError(
      `enqueueNotification(${def.key}): no recipients resolved from any resolver`,
    );
  }
  const unresolved: UnresolvedResolver[] = unresolvedErrors.map((u) => ({
    resolver: u.resolver,
    error: (u.err as Error)?.message ?? String(u.err),
  }));
  if (unresolved.length > 0) {
    logEvent({
      severity: 'error',
      function: 'enqueueNotification',
      event: 'resolver.lookup.failed',
      extra: { key: def.key, unresolved, deliveredToOthers: true },
    });
    try {
      captureFunctionError(unresolvedErrors[0]!.err, {
        function: 'enqueueNotification',
        key: def.key,
        unresolved,
      });
    } catch {
      // Reporting must never undo a delivery; the error log above already has it.
    }
  }
  const seen = new Set<string>();
  const recipients = [...primary, ...secondary].filter((r) => {
    if (seen.has(r.uid)) return false;
    seen.add(r.uid);
    return true;
  });

  // AO-28: resolve the actor's name + photo ONCE (not per recipient) so every
  // written NotificationEntry can render who caused it with an avatar.
  const actor = await resolveActor(args.actorUid);

  const outcome: EnqueueOutcome = { written: [], suppressed: [], unresolved };
  for (const recipient of recipients) {
    const [userPrefs, businessOverride] = await Promise.all([
      loadUserPrefs(recipient.uid, recipient.collection),
      loadBusinessOverride(def.key),
    ]);
    // Audience revamp 2026-07: each copy gates through its own stream view
    // (clients -> kinfolk; staff -> staff when the key serves staff, else business).
    // The same per-copy answer also decides what the card detail may say, so it
    // is resolved once here and threaded down rather than re-derived (#380).
    const stream = streamForRecipient(def, recipient.collection);
    const channels = resolveChannels(def, userPrefs, businessOverride, stream);

    if (!hasAnyChannel(channels)) {
      logEvent({
        severity: 'info',
        function: 'enqueueNotification',
        event: 'notification.suppressed',
        uid: recipient.uid,
        extra: { key: def.key, reason: 'no-channels-after-prefs' },
      });
      outcome.suppressed.push({ recipientUid: recipient.uid, reason: 'prefs' });
      continue;
    }

    const routed = await routeByDeliveryMode(def, args, recipient.uid, channels, actor, stream);
    if (routed.kind === 'written') {
      outcome.written.push(routed.id);
    } else {
      logEvent({
        severity: 'info',
        function: 'enqueueNotification',
        event: 'notification.deduped',
        uid: recipient.uid,
        extra: {
          key: def.key,
          identity: routed.identity,
          existingId: routed.existingId,
          lastAtMs: routed.lastAtMs,
          windowMs: dedupeWindowOf(args),
        },
      });
      outcome.suppressed.push({
        recipientUid: recipient.uid,
        reason: 'duplicate',
        existingId: routed.existingId,
        lastAtMs: routed.lastAtMs,
      });
    }
  }

  return outcome;
}

type Routed =
  | { kind: 'written'; id: string }
  | { kind: 'duplicate'; identity: string; existingId: string; lastAtMs: number };

/**
 * Runs `write` only if `(key, identity, recipientUid)` was not delivered inside
 * NOTIFICATION_DEDUPE_WINDOW_MS, and records the delivery, in ONE transaction.
 *
 * The read of the ledger and the notification writes commit together or not at
 * all, so two attempts racing each other cannot both pass the check: Firestore
 * serializes the transactions and retries the loser, which then reads the
 * winner's ledger entry and stands down. A read-then-write outside a
 * transaction could not promise that.
 *
 * `identity === ''` skips the ledger entirely (see `dedupeIdentityOf`).
 */
/** The one write primitive a delivery needs; a Transaction and a WriteBatch both satisfy it. */
interface Writer {
  set(ref: DocumentReference, data: Record<string, unknown>): unknown;
}

/** The duplicate-check window for one call: the caller's own when it passed one, else the default. */
export function dedupeWindowOf(args: Pick<EnqueueArgs, 'dedupeWindowMs'>): number {
  const w = args.dedupeWindowMs;
  return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : NOTIFICATION_DEDUPE_WINDOW_MS;
}

async function writeOnce(
  key: string,
  identity: string,
  recipientUid: string,
  windowMs: number,
  write: (w: Writer) => string,
  collectionPath: string,
): Promise<Routed> {
  if (identity === '') {
    // No ledger to consult, but the notification and its work order still land
    // together: a batch commits atomically, same as the transaction below.
    const batch = db().batch();
    const id = write(batch);
    await batch.commit();
    return { kind: 'written', id };
  }
  const nowMs = Date.now();
  const ledgerRef: DocumentReference = db().collection(DEDUPE_COLLECTION).doc(dedupeDocId(key, identity, recipientUid));
  return db().runTransaction(async (tx: Transaction): Promise<Routed> => {
    const snap = await tx.get(ledgerRef);
    const prior = snap.exists ? (snap.data() as { lastAtMs?: unknown; notificationId?: unknown }) : undefined;
    const lastAtMs = typeof prior?.lastAtMs === 'number' ? prior.lastAtMs : null;
    if (lastAtMs !== null && nowMs - lastAtMs < windowMs) {
      return {
        kind: 'duplicate',
        identity,
        existingId: typeof prior?.notificationId === 'string' ? prior.notificationId : '',
        lastAtMs,
      };
    }
    const id = write(tx);
    tx.set(ledgerRef, {
      key,
      identity,
      recipientUid,
      notificationId: id,
      collection: collectionPath,
      lastAtMs: nowMs,
      windowMs,
      // The TTL field. Refreshed on every delivery, so a notification that keeps
      // recurring keeps its entry; see DEDUPE_LEDGER_RETENTION_MS. Never shorter
      // than the window this delivery was checked under, so a caller that looks
      // back further finds the entry for as long as it looks.
      expiresAt: Timestamp.fromMillis(nowMs + Math.max(DEDUPE_LEDGER_RETENTION_MS, windowMs)),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { kind: 'written', id };
  });
}

function hasAnyChannel(c: ResolvedChannels): boolean {
  return c.email || c.sms || c.push;
}

function activeChannelList(c: ResolvedChannels): Channel[] {
  return ALL_CHANNELS.filter((ch) => c[ch]);
}

async function routeByDeliveryMode(
  def: NotificationDef,
  args: EnqueueArgs,
  recipientUid: string,
  channels: ResolvedChannels,
  actor: ResolvedActor,
  stream: AudienceStream,
): Promise<Routed> {
  const { targetType, targetId } = resolveTargetRef(args);
  const identity = dedupeIdentityOf(args, { targetType, targetId });
  const windowMs = dedupeWindowOf(args);
  // R5: the entity detail the CARD renders, resolved server-side once, here.
  // Every value in it (household, pets, service, date, time, notes, amount) was
  // already being computed downstream for outbound templates and thrown away;
  // see buildNotificationDetail's docstring for the full accounting.
  //
  // `stream` is what keeps staff-only fields off a household's copy (#380). It
  // is per-copy, not per-key: `kincare.changed` writes one copy to the operator
  // and one to the kinfolk, and only the operator's may carry the booking notes.
  const detail = await buildNotificationDetail(
    def.key,
    recipientUid,
    args.data,
    actor.actorName,
    stream,
  );

  /**
   * THE INBOX CONTENT, and nothing else. No `status`, no `mode`, no `channels`:
   * those describe the delivery pipeline and now live on the work-order doc
   * (see DISPATCH_COLLECTION above). Typed loosely rather than as
   * `NotificationDoc` because `createdAt` is a FieldValue sentinel here and a
   * Timestamp on read, which no single interface can honestly say.
   */
  const content = {
    key: def.key,
    category: def.category,
    recipientUid,
    actorUid: args.actorUid ?? null,
    // AO-28: human-renderable content on the entry itself (title + description
    // from the catalog def) + the resolved actor identity, so a client renders
    // "<title> — <actorName>" with an avatar instead of a bare key.
    title: def.label,
    description: def.description,
    actorName: actor.actorName,
    actorPhotoUrl: actor.actorPhotoUrl,
    data: args.data,
    // Omitted entirely when nothing resolved, so a client can distinguish
    // "no detail available" from "detail with every field blank".
    ...(detail ? { detail } : {}),
    // Deep-link reference for open-linked + quick approve/deny. Always present
    // (additive; '' when no entity is resolvable) so the client can branch on it.
    targetType,
    targetId,
    createdAt: FieldValue.serverTimestamp(),
  };

  const activeChannels = activeChannelList(channels);

  /**
   * The queue documents (`pendingNotifications`, `notificationBatch`,
   * `scheduledNotifications`) are workflow records in their own right: nothing
   * reads them as an inbox, and a sweep promotes them into a real notification
   * later. So they legitimately carry `status`/`mode`/`channels` alongside the
   * content the sweep will hand on. This is the base for all three.
   */
  const queueDoc = { ...content, channels: activeChannels };

  switch (def.deliveryMode) {
    case 'trigger': {
      return writeOnce(def.key, identity, recipientUid, windowMs, (w) => {
        const ref = db().collection('notifications').doc();
        w.set(ref, content);
        // The work order is written under the same id. Its onCreate trigger fans
        // out to channel subdocs, and that trigger reads the notification it is
        // delivering, so the mail must exist before the postman is called. Both
        // now commit in one atomic write (#832), so the work order can never be
        // visible without its notification.
        w.set(db().collection(DISPATCH_COLLECTION).doc(ref.id), {
          notificationId: ref.id,
          key: def.key,
          recipientUid,
          data: args.data,
          mode: 'trigger',
          channels: activeChannels,
          status: 'pending',
          createdAt: FieldValue.serverTimestamp(),
        });
        return ref.id;
      }, 'notifications');
    }

    case 'debounced': {
      const docId = `${recipientUid}_${def.key}`;
      const fireAfterMs = Date.now() + (def.debounceMs ?? 30 * 60 * 1000);
      const ref = db().collection('pendingNotifications').doc(docId);
      await ref.set(
        {
          ...queueDoc,
          status: 'pending',
          mode: 'debounced',
          debounceStrategy: def.debounceStrategy ?? 'snapshot',
          fireAfterMs,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      // Not routed through writeOnce (#832): the deterministic
      // `${uid}_${key}` id already collapses every repeat onto one queue row,
      // and a repeat is MEANT to bump fireAfterMs and carry the newest content.
      // A dedupe here would drop exactly the update a debounce exists to keep.
      return { kind: 'written', id: ref.id };
    }

    case 'batched': {
      if (!def.batchKey) {
        throw new Error(`catalog(${def.key}): batched mode requires batchKey`);
      }
      // PATH CONTRACT. 4 segments: notificationBatch/{uid}/{batchKey}/{auto}.
      // Do not add an `items` level. Handoff notes from 2026-05-10 and this
      // file's own docstring long claimed `.../{batchKey}/items/{auto}`, which
      // is 5 segments and therefore not a document path Firestore can hold; it
      // was never written. Two consumers are pinned to the shape below:
      // `firestore.rules` (`match /notificationBatch/{uid}/{batchKey}/{id}`)
      // and `scheduled/notificationBatchSweep.ts`, whose parent walk reads uid
      // and batchKey straight off these segments. Changing the depth here
      // breaks both and strands every row already written.
      //
      // `queueDoc.createdAt` (serverTimestamp) is the item's age field. The
      // sweep sorts on it in memory rather than in the query, so no
      // COLLECTION_GROUP index is needed for this or any future batchKey; see
      // the sweep's docstring. Renaming or dropping it silently ages every
      // item off `createTime` instead.
      const batchKey = def.batchKey;
      return writeOnce(def.key, identity, recipientUid, windowMs, (w) => {
        const ref = db()
          .collection('notificationBatch')
          .doc(recipientUid)
          .collection(batchKey)
          .doc();
        w.set(ref, { ...queueDoc, status: 'pending', mode: 'batched' });
        return ref.id;
      }, `notificationBatch/${recipientUid}/${batchKey}`);
    }

    case 'scheduled': {
      const fireAtMs = args.fireAtMs ?? Date.now();
      if (!args.fireAtMs) {
        logEvent({
          severity: 'warn',
          function: 'enqueueNotification',
          event: 'notification.scheduled.missing-fireAt',
          uid: recipientUid,
          extra: { key: def.key, fallbackFireAtMs: fireAtMs },
        });
      }
      // Deduped HERE, at enqueue, and not at promotion: the sweep that turns
      // this row into a notification already promotes and deletes inside one
      // transaction, so the only place a second copy can be born is this write.
      return writeOnce(def.key, identity, recipientUid, windowMs, (w) => {
        const ref = db().collection('scheduledNotifications').doc();
        w.set(ref, { ...queueDoc, status: 'pending', mode: 'scheduled', fireAtMs });
        return ref.id;
      }, 'scheduledNotifications');
    }

    default: {
      const exhaustive: never = def.deliveryMode;
      throw new Error(`enqueueNotification(${def.key}): unknown deliveryMode '${String(exhaustive)}'`);
    }
  }
}
