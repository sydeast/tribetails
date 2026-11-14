import { createHash } from 'node:crypto';
import { FieldValue, Timestamp, type DocumentReference, type Transaction } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { captureFunctionError } from '../lib/sentry';
import { resolveActor, type ResolvedActor } from '../lib/resolveActor';
import { fillBusinessPlaceholders, loadBusinessName } from '../lib/businessName';
import { buildNotificationDetail, householdNoticeLine } from './buildNotificationDetail';
import { visitTimesForStream } from './visitDates';
import { getNotificationDef } from './catalog';
import {
  loadHouseholdSendGate,
  type HouseholdSendGate,
  type HouseholdSendGateState,
} from './householdSendGate';
import {
  loadBusinessOverride,
  loadUserPrefs,
  notificationDisabledFor,
  resolveChannels,
  streamForRecipient,
} from './prefs';
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

/**
 * Why a recipient got nothing from one enqueue.
 *
 * 'gate' is NOT a flavour of 'prefs', and callers must not fold the two
 * together. `prefs` means the notification is OFF for this recipient: the
 * operator disabled it, or it is marketing-class and they never opted in.
 * Turning every delivery channel off is not 'prefs' (#1505); that copy is
 * written as a record and nothing is sent. `gate` means the whole product has
 * not opened yet and this copy was household-bound (see
 * notifications/householdSendGate.ts).
 * A caller deciding how long to wait before retrying needs the difference: a
 * prefs suppression can sit for as long as the preference does, and a gate
 * suppression clears the day the operator flips one boolean.
 */
export type SuppressionReason = 'duplicate' | 'prefs' | 'gate';

export interface Suppression {
  recipientUid: string;
  reason: SuppressionReason;
  /** For 'duplicate': the doc the earlier delivery wrote. */
  existingId?: string;
  /** For 'duplicate': when the earlier delivery happened (ms epoch). */
  lastAtMs?: number;
  /** For 'gate': what the settings document said ('absent' | 'off' | 'read-failed'). */
  gateState?: HouseholdSendGateState;
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
  /**
   * #1507: recipients (uids) whose record in `written` was written with EVERY
   * delivery channel off. The notifications list behind the bell shows the
   * alert (#1505); nothing was emailed, texted or pushed, and no work order
   * exists. A caller that tells an admin "sent" reads this so the admin is told
   * the notice reached the household in the app only. Optional so a hand-built
   * outcome in a test still type-checks; the dispatcher always sets it.
   */
  appOnly?: string[];
  /**
   * #1816/#1838: the delivery channels of each copy in `written`, by
   * recipient uid (empty for an `appOnly` one). A caller that tells an admin
   * "Dre East was sent an email" reads this. Optional for the same reason as
   * `appOnly`; the dispatcher always sets it.
   */
  channelsByRecipient?: Record<string, Channel[]>;
}

/**
 * The prefs half of one copy's fate, decided once and shared by the dispatch
 * loop and the dry run below, so a confirm and the send never ask two
 * different questions (#1816: the KinTale confirm promised a notice the send
 * path could not deliver).
 */
interface CopyDecision {
  stream: AudienceStream;
  /** Non-null when the notification is off as a whole for this copy. */
  disabled: ReturnType<typeof notificationDisabledFor>;
  channels: ResolvedChannels;
}

async function copyDecision(
  def: NotificationDef,
  recipient: { uid: string; collection: 'clients' | 'staff' },
): Promise<CopyDecision> {
  const [userPrefs, businessOverride] = await Promise.all([
    loadUserPrefs(recipient.uid, recipient.collection),
    loadBusinessOverride(def.key),
  ]);
  const stream = streamForRecipient(def, recipient.collection);
  return {
    stream,
    disabled: notificationDisabledFor(def, userPrefs, businessOverride, stream),
    channels: resolveChannels(def, userPrefs, businessOverride, stream),
  };
}

/** What the dispatcher WOULD do with a household's copy of [key], without writing anything. */
export type HouseholdCopyPreview =
  /** The key has no household audience: the household is never sent it. */
  | { kind: 'not_household' }
  /** The notification is off for this household (`prefs` in the dispatch). */
  | { kind: 'prefs' }
  /** The household send gate is shut (`gate` in the dispatch). */
  | { kind: 'gate' }
  /** A record would be written, delivered on these channels (none: the notifications list only). */
  | { kind: 'send'; channels: Channel[] };

/**
 * #1816/#1838/#2027/#1841: a dry run of `enqueueNotificationDetailed` for ONE
 * household login, in the same order and through the same helpers: the
 * household audience, `copyDecision` (prefs, then channels), then the send
 * gate. It cannot predict a duplicate (that needs the content), and it does
 * not resolve the login: the caller passes the one the dispatch would get
 * (`resolveKinfolkUid`).
 */
export async function previewHouseholdCopy(key: string, recipientUid: string): Promise<HouseholdCopyPreview> {
  const def = getNotificationDef(key);
  if (def.external === true || def.audiences.kinfolk !== true) return { kind: 'not_household' };
  const resolvers = [def.recipientResolver, def.secondaryResolver];
  if (!resolvers.includes('kinfolkAcct') && !resolvers.includes('specificUid')) return { kind: 'not_household' };
  const decision = await copyDecision(def, { uid: recipientUid, collection: 'clients' });
  if (decision.disabled !== null) return { kind: 'prefs' };
  const gate = await loadHouseholdSendGate(db());
  if (!gate.live) return { kind: 'gate' };
  return { kind: 'send', channels: activeChannelList(decision.channels) };
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
 * Returns the list of notification document IDs written (one per recipient).
 * Empty array = every recipient was suppressed: the notification is off for
 * them (operator disabled, or marketing without opt-in), the household gate is
 * shut, or (#832) the same notification already reached them inside
 * NOTIFICATION_DEDUPE_WINDOW_MS. A caller that needs to tell those apart uses
 * `enqueueNotificationDetailed`.
 *
 * An id in the list means the notifications record exists; it does not promise
 * a delivery behind it (#1505). A recipient with every delivery channel off
 * still counts as written, because the list behind the bell shows the record.
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

  const outcome: EnqueueOutcome = { written: [], suppressed: [], unresolved, appOnly: [], channelsByRecipient: {} };
  /**
   * THE PRE-LAUNCH HOUSEHOLD GATE, read at most once per enqueue and only when
   * a household copy is actually about to be written.
   *
   * Lazy on purpose: `security.account.locked.operator` and every other
   * staff-only key resolves nobody in `clients/`, so the operator's alerts cost
   * no extra Firestore read and cannot be held up by this document at all.
   */
  let gate: HouseholdSendGate | null = null;
  const householdGate = async (): Promise<HouseholdSendGate> => {
    gate ??= await loadHouseholdSendGate(db());
    return gate;
  };
  /** #1564: a roster copy has already been written carrying the business email. */
  let businessEmailCarried = false;
  let gateSuppressed = 0;
  /** The state the gate reported when it last held a copy back, for the summary line. */
  let gateSuppressedState: HouseholdSendGateState = 'absent';
  for (const recipient of recipients) {
    // Audience revamp 2026-07: each copy gates through its own stream view
    // (clients -> kinfolk; staff -> staff when the key serves staff, else business).
    // The same per-copy answer also decides what the card detail may say, so it
    // is resolved once here and threaded down rather than re-derived (#380).
    // #1816/#1838: the prefs read and the two prefs answers below are
    // `copyDecision`, which the dry run `previewHouseholdCopy` calls too.
    const decision = await copyDecision(def, recipient);
    const { stream } = decision;

    /**
     * THE PREFS CHECK, and since #1505 it asks a narrower question than "is
     * anything to be delivered". Only a notification that is OFF as a whole is
     * suppressed here: the operator disabled it on this stream, or it is
     * marketing-class and this recipient never opted in. Both are reported as
     * 'prefs', as before.
     *
     * A recipient who leaves the notification on but turns every delivery
     * channel off (email, SMS, push) is NOT suppressed. The notifications list
     * behind the bell (#1316) is a channel of its own, read straight off
     * `notifications/{id}`, and it cannot be turned off from the prefs screen.
     * So the copy walks on, through the gate and into `routeByDeliveryMode`,
     * which writes the record and no work order: nothing is sent, and the
     * alert is still there when they open the list.
     */
    const { disabled } = decision;
    if (disabled !== null) {
      logEvent({
        severity: 'info',
        function: 'enqueueNotification',
        event: 'notification.suppressed',
        uid: recipient.uid,
        extra: {
          key: def.key,
          reason: disabled === 'operator' ? 'disabled-by-operator' : 'marketing-not-opted-in',
        },
      });
      outcome.suppressed.push({ recipientUid: recipient.uid, reason: 'prefs' });
      continue;
    }

    let channels = decision.channels;
    /**
     * ONE BUSINESS EMAIL PER EVENT (#1564). Operator ruling, 2026-11-05 docket:
     * every business email goes to the business contact email in settings, so
     * each roster admin's copy would land in the same inbox. The first roster
     * copy written with email on carries it; later roster copies keep their
     * record (the bell) and their push and SMS, without the email.
     */
    if (recipient.businessRoster === true && channels.email && businessEmailCarried) {
      channels = { ...channels, email: false };
    }
    // #1973: this copy is a notifications-list record only (see `listOnlyFor`).
    if (args.listOnlyFor?.includes(recipient.uid) === true) {
      channels = { ...channels, email: false, sms: false, push: false };
    }
    const recordOnly = !hasAnyChannel(channels);
    if (recordOnly) {
      logEvent({
        severity: 'info',
        function: 'enqueueNotification',
        event: 'notification.record-only',
        uid: recipient.uid,
        extra: { key: def.key, reason: 'no-delivery-channels' },
      });
    }

    /**
     * THE GATE. Household-bound copies stop here until the operator opens the
     * product; staff and operator copies walk straight past.
     *
     * `stream` is the classification and it is not a heuristic: it is the same
     * per-copy value `resolveChannels` was just handed, and `streamForRecipient`
     * returns 'kinfolk' exactly when the resolver put this recipient in
     * `clients/`. Every notification with a household-side resolver
     * (`kinfolkAcct`, `specificUid`) declares `audiences.kinfolk`, and no other
     * resolver can produce a `clients/` recipient, so there is no key this has
     * to guess about. `householdSendGateGuard.test.ts` pins that invariant so a
     * new catalog row cannot quietly drift out from under it, and a `both`-key's
     * business copy is unaffected: `kincare.booking.confirm` still reaches every
     * admin while the household's copy waits.
     *
     * PLACED HERE, BETWEEN THE PREFS CHECK AND `routeByDeliveryMode`, and the
     * position is the whole safety argument:
     *
     *   - BEFORE `routeByDeliveryMode`, because that is what writes the
     *     `notificationDedupe` ledger. A gated `invoice.overdue` that still
     *     stamped the ledger would come back 'duplicate' on the first run after
     *     launch, inside OVERDUE_DEDUPE_WINDOW_MS, and `processOverdueInvoice`
     *     would write `overdueNotifiedAtMs` from the ledger's time. Every
     *     invoice that existed while the gate was shut would be marked notified
     *     without anyone having been notified. Sitting above that write is what
     *     makes "flip it on and the backlog still goes out" true rather than
     *     hoped for.
     *   - AFTER the prefs check, so a copy the operator switched off is not
     *     counted as something the gate held back. A copy with every delivery
     *     channel off still reaches the gate (#1505): with the gate shut it is
     *     not written at all, record included, which is the one case in which
     *     a kinfolk's list stays empty on purpose.
     */
    if (stream === 'kinfolk') {
      const { live, state } = await householdGate();
      if (!live) {
        gateSuppressed += 1;
        gateSuppressedState = state;
        logEvent({
          severity: 'info',
          function: 'enqueueNotification',
          event: 'notification.gated.household',
          uid: recipient.uid,
          extra: {
            key: def.key,
            recipientType: 'household',
            stream,
            gateState: state,
            channels: activeChannelList(channels),
          },
        });
        outcome.suppressed.push({ recipientUid: recipient.uid, reason: 'gate', gateState: state });
        continue;
      }
    }

    const routed = await routeByDeliveryMode(def, args, recipient.uid, channels, actor, stream);
    if (routed.kind === 'written') {
      outcome.written.push(routed.id);
      if (recipient.businessRoster === true && channels.email) businessEmailCarried = true;
      // Reported only for a record that was actually written (#1507): a gated
      // copy logged `record-only` above and then wrote nothing, and a duplicate
      // wrote nothing new. Both are already in `suppressed`.
      if (recordOnly) outcome.appOnly?.push(recipient.uid);
      // #1816/#1838: how this copy goes out, for an admin told who heard and how.
      if (outcome.channelsByRecipient) outcome.channelsByRecipient[recipient.uid] = activeChannelList(channels);
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

  /**
   * One summary line per enqueue, so the operator can read what the gate cost
   * without counting per-recipient lines. Emitted only when something was
   * actually held back, at warn rather than info: while the gate is shut this
   * is the record of mail the business meant to send and did not.
   */
  if (gateSuppressed > 0) {
    logEvent({
      severity: 'warn',
      function: 'enqueueNotification',
      event: 'notification.gated.household.summary',
      extra: {
        key: def.key,
        recipientType: 'household',
        gateState: gateSuppressedState,
        suppressedCount: gateSuppressed,
        // Records written for the other copies, whether or not a channel is
        // behind each one (#1505); the field name predates that distinction.
        deliveredCount: outcome.written.length,
      },
    });
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

/**
 * #2093: the title and the line under it stored on one copy of a notice. The
 * household's copy reads the catalog's `householdTitle` ("A quote was
 * accepted"); every other copy keeps the operator's `label` ("Kinfolk accepted
 * a quote") and `description`. A `{business}` placeholder is filled the way
 * `getNotificationCatalog` fills it, and only a title that carries one pays for
 * the settings read.
 *
 * #1831: the household's description is '' here. Its line is built from the
 * copy's own facts by `householdNoticeLine` once the detail is resolved; the
 * Notification settings sentence (`householdDescription`) describes a KIND of
 * notice and is never the line under one.
 */
export async function noticeCopyFor(
  def: Pick<NotificationDef, 'label' | 'description' | 'householdTitle'>,
  stream: AudienceStream,
): Promise<{ title: string; description: string }> {
  if (stream !== 'kinfolk') return { title: def.label, description: def.description };
  const title = def.householdTitle?.trim() || def.label;
  if (!/\{business/i.test(title)) return { title, description: '' };
  const name = await loadBusinessName('dispatcher');
  return { title: fillBusinessPlaceholders(title, name), description: '' };
}
/** The title half of {@link noticeCopyFor}. */
export async function noticeTitleFor(
  def: Pick<NotificationDef, 'label' | 'householdTitle'> & Partial<Pick<NotificationDef, 'description'>>,
  stream: AudienceStream,
): Promise<string> {
  return (await noticeCopyFor({ description: '', ...def }, stream)).title;
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
  // #1863: this copy's own visit times. The household's copy reads what the
  // household is shown (a window in Time Blocks mode), every other copy the
  // clock. After the dedupe identity, which stays the dispatch's own.
  args = { ...args, data: visitTimesForStream(args.data ?? {}, stream) };
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
  // #2093: the household's own copy is worded to its reader (#1372).
  const copy = await noticeCopyFor(def, stream);
  // #1831: under the household's title goes what happened, from this copy's own
  // facts (which Kin, which KinCare, when; the KinTale; the Kin), never the
  // Notification settings sentence that describes the kind of notice. '' when
  // there is nothing to add, and the list shows the title alone.
  const description =
    stream === 'kinfolk'
      ? householdNoticeLine({ key: def.key, recipientUid, detail, data: args.data })
      : copy.description;
  const content = {
    key: def.key,
    category: def.category,
    recipientUid,
    actorUid: args.actorUid ?? null,
    // AO-28: human-renderable content on the entry itself (title + description
    // from the catalog def) + the resolved actor identity, so a client renders
    // "<title> — <actorName>" with an avatar instead of a bare key.
    title: copy.title,
    description,
    // #1831: marks the household's copy as carrying a line built from its
    // facts. The notifications list shows this field and never an older row's
    // `description`, which holds the operator's or the settings wording.
    ...(stream === 'kinfolk' ? { householdLine: description } : {}),
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
  // `stream` lets the batch sweep word a digest for its reader (#1898). The
  // promotion copies named fields only, so it never reaches the notification.
  const queueDoc = { ...content, channels: activeChannels, stream };

  switch (def.deliveryMode) {
    case 'trigger': {
      return writeOnce(def.key, identity, recipientUid, windowMs, (w) => {
        const ref = db().collection('notifications').doc();
        w.set(ref, content);
        // NO WORK ORDER WHEN THERE IS NOTHING TO DELIVER (#1505). The work order
        // exists to drive delivery: `onNotificationDispatchCreate` fans it out
        // into channel subdocs and `listNotificationDeliveries` reads it back as
        // the record of what was attempted. With every channel off there is
        // nothing to fan out and nothing to list, and the fan-out would only
        // stamp it `no-channels` and stop. The record above is the whole
        // delivery here: it is what the notifications list reads. The dedupe
        // ledger is still written by `writeOnce`, so a retry of this same event
        // is refused exactly as it would be with a channel on.
        if (activeChannels.length === 0) return ref.id;
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
