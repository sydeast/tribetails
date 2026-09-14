import { FieldValue } from 'firebase-admin/firestore';
import { db } from './firestoreAdmin';
import { logEvent } from './logger';

/**
 * Who the business-facing notifications go to, and who a visit is assigned to
 * when nobody picks an Auntie.
 *
 * Source of truth is `businessSettings/admins.uids`. That document had two
 * readers (this one's callers) and NO writer anywhere in the codebase, and in
 * prod it did not exist. 16 catalog keys name `businessAdmins` as their PRIMARY
 * resolver, including `kincare.requested`, `message.received` and
 * `rating.submitted.bad`, so every one of them threw "cannot dispatch" and the
 * operator was never told a booking had been requested. The same document backs
 * `resolveDefaultAssignee`, so every portal-created visit was also written
 * `assignedAuntieUid: null`.
 *
 * ## Read contract
 *
 * `readBusinessAdmins()` is the ONE read. Both resolvers below are projections
 * of the snapshot it returns, so a caller that needs the roster AND the default
 * assignee pays for one read rather than two. `resolveBusinessAdminUids()` and
 * `resolveDefaultAssigneeUid()` are the convenience wrappers that read for you.
 *
 * Recipient resolution order:
 *   1. `businessSettings/admins.uids`, the explicit roster. Always wins.
 *   2. `AUNTIE_OPERATOR_UIDS`, the operator allowlist `lib/staffGate.ts`
 *      already treats as a trusted operator signal. Used as the answer AND
 *      written back best-effort, so the fallback is needed once rather than on
 *      every dispatch.
 *   3. Throw, naming the fix. `provisionBusinessAdmins` seeds the roster.
 *
 * Deliberately NOT a silent empty: a business notification nobody receives is
 * the failure this whole module exists to make impossible.
 *
 * ## The two resolvers deliberately disagree, and this is why
 *
 * `resolveBusinessAdminUidsFrom` and `defaultAssigneeUidFrom` read the same
 * document and have opposite contracts. That is intentional, because the two
 * questions have opposite failure costs:
 *
 * | | recipients (`resolveBusinessAdminUidsFrom`) | assignee (`defaultAssigneeUidFrom`) |
 * |---|---|---|
 * | nothing configured | THROWS | returns `null` |
 * | writes on the read path | yes, best-effort self-heal | never |
 * | why | a notification with no recipient is silent data loss, and the operator learns nothing about a booking, a message or a bad rating | an unassigned visit is a WORKING booking, so failing here would fail a kinfolk's booking over an operator-side configuration gap |
 *
 * The assignee path does not self-heal on purpose: healing means writing, and
 * it sits on `requestBooking`. It does not need to, because the recipient path
 * heals from the same `AUNTIE_OPERATOR_UIDS` value, so the roster converges on
 * the first business notification without the booking path taking write risk.
 *
 * ## Write contract: named intents, never one ambiguous "write"
 *
 * - `addBusinessAdminUids` unions. It can never drop anybody, which is what
 *   makes repeated provisioning and the self-heal safe.
 * - `setBusinessAdminUids` replaces the roster outright.
 * - `removeBusinessAdminUids` revokes named uids. Preferred over `set` for a
 *   revoke button: it cannot clobber a concurrent add.
 *
 * All three go through one guarded transaction, so three invariants hold no
 * matter which is called:
 *
 *   1. The roster can never be left EMPTY. An empty roster IS the outage.
 *   2. The actor can never remove themselves (see `RosterRefusal`).
 *   3. The roster can never exceed `MAX_ROSTER_SIZE`. Every uid on it receives
 *      EVERY business notification, and those carry kinfolk PII: booking
 *      details, inbound customer messages, ratings. The cap bounds how far a
 *      mistaken or malicious add can spread that.
 *
 * ## AUNTIE_OPERATOR_UIDS is a Secret Manager secret
 *
 * It is NOT in `functions/.env`, so it only resolves inside a function that
 * binds it via `secrets: [...]`. A function that does not bind it sees
 * `undefined` with no error. That is why arm (2) is a fallback and not a
 * gate: a function without the binding is not silently wrong, it falls through
 * to (3) and throws with the fix named. Many functions bind it, among them
 * `onBookingsWrite`, `recordFailedLogin`, the roster callables and most portal
 * callables; check a function's own `secrets:` list before relying on the
 * fallback there.
 */

const DOC_PATH = { collection: 'businessSettings', doc: 'admins' } as const;

/**
 * Ceiling on the stored roster. See invariant 3 above: this bounds how far
 * kinfolk PII can be fanned out by a mistaken or malicious `add`.
 */
export const MAX_ROSTER_SIZE = 25;

export interface BusinessAdminsSettings {
  /** Business-notification recipients. Empty means "nothing configured". */
  uids: string[];
  /** The explicitly chosen default assignee, or null when none is stored. */
  defaultAssigneeUid: string | null;
}

/** What changed, so a caller can report a revocation rather than guess. */
export interface RosterChange {
  uids: string[];
  removed: string[];
  /** True when the stored `defaultAssigneeUid` named a uid that was revoked. */
  defaultAssigneeCleared: boolean;
}

/** Why a roster mutation was refused. Each maps to one invariant above. */
export type RosterRefusal = 'empty-roster' | 'self-removal' | 'roster-too-large';

/**
 * The caller asked for something the roster contract refuses. Callables map
 * this to `failed-precondition`, and every message names the way out.
 */
export class BusinessAdminRosterError extends Error {
  readonly refusal: RosterRefusal;

  constructor(refusal: RosterRefusal, message: string) {
    super(message);
    this.name = 'BusinessAdminRosterError';
    this.refusal = refusal;
  }
}

/** Order-preserving dedupe. Order matters: `uids[0]` is the implicit assignee. */
function dedupe(uids: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of uids) {
    if (typeof raw !== 'string') continue;
    const uid = raw.trim();
    if (uid && !out.includes(uid)) out.push(uid);
  }
  return out;
}

function normalize(data: unknown): BusinessAdminsSettings {
  const doc = (data ?? {}) as { uids?: unknown; defaultAssigneeUid?: unknown };
  const explicit =
    typeof doc.defaultAssigneeUid === 'string' ? doc.defaultAssigneeUid.trim() : '';
  return {
    uids: Array.isArray(doc.uids) ? dedupe(doc.uids) : [],
    defaultAssigneeUid: explicit || null,
  };
}

/**
 * Arm (2) of the recipient order, read and nothing else.
 *
 * Exported for the read surfaces that have to SHOW who a business notification
 * would reach without changing it. `resolveBusinessAdminUidsFrom` answers the
 * same question but self-heals by writing the roster back, which is right on a
 * dispatch and wrong on a settings screen (see the note in
 * `admin/notificationOverrides.ts`: reading a screen must not quietly edit who
 * receives business mail).
 *
 * Empty unless the calling function binds the `AUNTIE_OPERATOR_UIDS` secret.
 */
export function operatorAllowlistUids(): string[] {
  return dedupe((process.env.AUNTIE_OPERATOR_UIDS ?? '').split(','));
}

function envOperatorUids(): string[] {
  return operatorAllowlistUids();
}

function adminsRef() {
  return db().collection(DOC_PATH.collection).doc(DOC_PATH.doc);
}

/**
 * The single read of `businessSettings/admins`. Hand the result to
 * `resolveBusinessAdminUidsFrom` and/or `defaultAssigneeUidFrom` rather than
 * calling both convenience wrappers, which would read the doc twice.
 */
export async function readBusinessAdmins(): Promise<BusinessAdminsSettings> {
  const snap = await adminsRef().get();
  return normalize(snap.data());
}

/**
 * The one guarded write. Every public mutator is a `next` function over the
 * current roster; the invariants are enforced here so no caller can skip them,
 * and the read-modify-write runs in a transaction so a concurrent add and
 * remove cannot lose each other's edit.
 */
async function mutateRoster(opts: {
  reason: string;
  /** The uid that must survive the mutation, or null when there is no actor. */
  actorUid: string | null;
  /** Only ever SETS a default assignee; never overwrites one already chosen. */
  defaultAssigneeUid?: string | undefined;
  next: (current: BusinessAdminsSettings) => string[];
}): Promise<RosterChange> {
  const ref = adminsRef();
  const change = await db().runTransaction(async (tx) => {
    const current = normalize((await tx.get(ref)).data());
    const next = dedupe(opts.next(current));

    if (next.length === 0) {
      throw new BusinessAdminRosterError(
        'empty-roster',
        `${opts.reason}: that would leave businessSettings/admins.uids empty. `
          + 'With nobody on the roster every business notification fails to dispatch, so you '
          + 'would stop being told about bookings, messages and bad ratings. That is the '
          + 'outage this document exists to prevent. Keep at least one admin on it.',
      );
    }

    if (next.length > MAX_ROSTER_SIZE) {
      throw new BusinessAdminRosterError(
        'roster-too-large',
        `${opts.reason}: a roster of ${next.length} uids is over the limit of ${MAX_ROSTER_SIZE}. `
          + 'Everyone on this roster receives every business notification, and those carry '
          + 'kinfolk PII. Revoke uids with removeBusinessAdmins before adding more.',
      );
    }

    if (opts.actorUid && !next.includes(opts.actorUid)) {
      throw new BusinessAdminRosterError(
        'self-removal',
        `${opts.reason}: you cannot take your own uid off the business admin roster. `
          + 'To stop receiving business notifications, use saveMyAdminNotificationPrefs. '
          + 'To come off the roster entirely, another admin has to remove you.',
      );
    }

    const removed = current.uids.filter((uid) => !next.includes(uid));
    const payload: Record<string, unknown> = {
      uids: next,
      updatedAt: FieldValue.serverTimestamp(),
    };

    // The stored default assignee is the operator's choice and is normally left
    // alone. The one exception is a revocation that names them: leaving it would
    // keep assigning new visits to somebody whose access was just removed, so
    // the field is cleared and assignment falls back to the surviving `uids[0]`.
    // Logged at `warn` below, never silent.
    let defaultAssigneeCleared = false;
    if (current.defaultAssigneeUid && removed.includes(current.defaultAssigneeUid)) {
      payload['defaultAssigneeUid'] = FieldValue.delete();
      defaultAssigneeCleared = true;
    } else if (!current.defaultAssigneeUid) {
      const chosen = opts.defaultAssigneeUid?.trim() || next[0];
      if (chosen) payload['defaultAssigneeUid'] = chosen;
    }

    tx.set(ref, payload, { merge: true });
    return { uids: next, removed, defaultAssigneeCleared };
  });

  // Logged outside the transaction: a contended transaction runs its body more
  // than once, and a retried attempt is not a second roster change.
  logEvent({
    severity: change.removed.length > 0 ? 'warn' : 'info',
    function: 'businessAdmins',
    event: 'businessAdmins.roster.written',
    extra: {
      reason: opts.reason,
      count: change.uids.length,
      removed: change.removed,
      defaultAssigneeCleared: change.defaultAssigneeCleared,
    },
  });
  return change;
}

/**
 * Grow the roster. Idempotent, merge-only, and never narrowing: `uids` is the
 * union of what is stored and what is passed, so calling it twice or with a
 * partial list cannot drop an operator. This is the arm the self-heal and
 * `provisionBusinessAdmins` use, and its non-narrowing property is exactly what
 * makes them safe to run repeatedly.
 *
 * Throws rather than returning `[]` when the result would be empty: a caller
 * that asked to add nothing to an empty roster asked for the outage.
 */
export async function addBusinessAdminUids(
  uids: string[],
  opts: { defaultAssigneeUid?: string | undefined; reason: string },
): Promise<string[]> {
  const change = await mutateRoster({
    reason: opts.reason,
    // An add can never drop anybody, so there is nobody to protect from it.
    actorUid: null,
    defaultAssigneeUid: opts.defaultAssigneeUid,
    next: (current) => [...current.uids, ...uids],
  });
  return change.uids;
}

/**
 * Replace the roster with exactly `uids`. The authoritative-set counterpart to
 * `addBusinessAdminUids`, for a roster editor that submits the whole list.
 *
 * `actorUid` must appear in `uids`; this refuses rather than silently
 * re-inserting them, so a UI that dropped the actor by accident is told.
 */
export async function setBusinessAdminUids(
  uids: string[],
  opts: { actorUid: string; reason: string },
): Promise<RosterChange> {
  return mutateRoster({
    reason: opts.reason,
    actorUid: opts.actorUid,
    next: () => uids,
  });
}

/**
 * Revoke named uids. Preferred over `setBusinessAdminUids` for a revoke button:
 * it names only what is being taken away, so a concurrent add is preserved
 * rather than clobbered.
 *
 * A revoked uid stays revoked. The self-heal in `resolveBusinessAdminUidsFrom`
 * only fires when the stored roster is EMPTY, and the invariants above make an
 * empty roster unreachable through this API, so `AUNTIE_OPERATOR_UIDS` cannot
 * resurrect somebody who was removed. (Emptying the doc by hand in the Firestore
 * console WOULD let the env allowlist re-seed everyone it names. Use these
 * callables, not the console.)
 */
export async function removeBusinessAdminUids(
  uids: string[],
  opts: { actorUid: string; reason: string },
): Promise<RosterChange> {
  const drop = new Set(dedupe(uids));
  return mutateRoster({
    reason: opts.reason,
    actorUid: opts.actorUid,
    next: (current) => current.uids.filter((uid) => !drop.has(uid)),
  });
}

/**
 * The business admin uids, from an already-read snapshot. Throws (never returns
 * empty) so a caller cannot mistake "no admins configured" for "delivered to
 * nobody, fine".
 *
 * The self-heal write-back never changes what this returns. It runs on the
 * notification dispatch path, so a write failure here must not fail a dispatch
 * that would otherwise have succeeded: the resolved uids come back whether or
 * not the write lands, and a failed write is logged at `error` and retried by
 * the next dispatch. Concurrent dispatches all miss and all heal, which is
 * harmless because the write is a union and therefore idempotent.
 */
export async function resolveBusinessAdminUidsFrom(
  settings: BusinessAdminsSettings,
  context: string,
): Promise<string[]> {
  if (settings.uids.length > 0) return settings.uids;

  const fromEnv = envOperatorUids();
  if (fromEnv.length > 0) {
    logEvent({
      severity: 'warn',
      function: 'businessAdmins',
      event: 'businessAdmins.roster.healed',
      extra: {
        context,
        count: fromEnv.length,
        note: 'businessSettings/admins was empty; resolved from AUNTIE_OPERATOR_UIDS',
      },
    });
    try {
      await addBusinessAdminUids(fromEnv, { reason: `self-heal:${context}` });
    } catch (err) {
      logEvent({
        severity: 'error',
        function: 'businessAdmins',
        event: 'businessAdmins.roster.healWriteFailed',
        errorMessage: err instanceof Error ? err.message : String(err),
        extra: {
          context,
          note: 'write-back failed; recipients were still resolved and the dispatch was NOT failed. '
            + 'The next dispatch retries the heal. Call provisionBusinessAdmins to fix it for good.',
        },
      });
    }
    return fromEnv;
  }

  logEvent({
    severity: 'error',
    function: 'businessAdmins',
    event: 'businessAdmins.roster.missing',
    extra: {
      context,
      note: 'businessSettings/admins.uids is empty and AUNTIE_OPERATOR_UIDS is unset in this function',
    },
  });
  // #866: nobody by definition, not a failed read, so the dispatcher treats this
  // resolver as empty (code 'recipients-unavailable', see
  // notifications/recipientErrors.ts). The code is set inline rather than by
  // importing that module, so this lib keeps no dependency on the notifications
  // tree.
  throw Object.assign(
    new Error(
      `${context}: businessSettings/admins.uids is empty, so this business notification has no recipient. `
        + 'Seed the roster by calling the provisionBusinessAdmins callable as an operator, '
        + 'or bind AUNTIE_OPERATOR_UIDS on this function to let it self-heal.',
    ),
    { code: 'recipients-unavailable' },
  );
}

/** Reads the doc, then `resolveBusinessAdminUidsFrom`. */
export async function resolveBusinessAdminUids(context: string): Promise<string[]> {
  return resolveBusinessAdminUidsFrom(await readBusinessAdmins(), context);
}

/**
 * The default-assignee uid from an already-read snapshot: the stored choice,
 * else the first admin, else the first env operator, else null.
 *
 * Pure and never throws, unlike `resolveBusinessAdminUidsFrom` above. See "The
 * two resolvers deliberately disagree" in the module header: an unassigned
 * visit is a working booking, so this must never fail a kinfolk's booking, and
 * it takes no write risk on that path either.
 */
export function defaultAssigneeUidFrom(settings: BusinessAdminsSettings): string | null {
  if (settings.defaultAssigneeUid) return settings.defaultAssigneeUid;
  if (settings.uids.length > 0) return settings.uids[0];
  const fromEnv = envOperatorUids();
  return fromEnv.length > 0 ? fromEnv[0] : null;
}

/** Reads the doc, then `defaultAssigneeUidFrom`. */
export async function resolveDefaultAssigneeUid(): Promise<string | null> {
  return defaultAssigneeUidFrom(await readBusinessAdmins());
}
