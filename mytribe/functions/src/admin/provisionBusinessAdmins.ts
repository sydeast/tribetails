import { onCall, CallableRequest, HttpsError, type CallableOptions } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { initSentry } from '../lib/sentry';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import {
  BusinessAdminRosterError,
  addBusinessAdminUids,
  defaultAssigneeUidFrom,
  operatorAllowlistUids,
  readBusinessAdmins,
  removeBusinessAdminUids,
  resolveBusinessAdminUids,
  setBusinessAdminUids,
  type RosterChange,
} from '../lib/businessAdmins';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * The write surface for `businessSettings/admins`, the roster that decides who
 * receives business notifications and who a visit defaults to.
 *
 * This exists because that document had two readers and no writer, and in prod
 * it did not exist at all. 16 catalog keys name `businessAdmins` as their
 * primary resolver, so `kincare.requested`, `message.received` and
 * `rating.submitted.bad` all threw "cannot dispatch" and the operator was never
 * told. Nothing in the system could create it, which is why the gap survived.
 *
 * Three intents, three callables, because "write the roster" is ambiguous and
 * the ambiguity is what made the first version of this only able to GROW:
 *
 *   - `provisionBusinessAdmins` adds (union, idempotent, cannot drop anyone).
 *   - `setBusinessAdmins` replaces the roster with exactly what is passed.
 *   - `removeBusinessAdmins` revokes named uids.
 *
 * `lib/businessAdmins.ts` holds the invariants all three share: the roster can
 * never be emptied, the caller can never remove themselves, and it cannot grow
 * past `MAX_ROSTER_SIZE`. A refusal comes back as `failed-precondition` with
 * the way out named in the message.
 */

const AddArgs = z.object({
  /** Extra operator uids to include. The caller is always included. */
  uids: z.array(z.string().min(1)).max(20).optional(),
  /** Who unassigned visits default to. Only applied when none is stored yet. */
  defaultAssigneeUid: z.string().min(1).optional(),
});

/** Authoritative list for `setBusinessAdmins`, or the uids to drop for `removeBusinessAdmins`. */
const UidListArgs = z.object({
  uids: z.array(z.string().min(1)).min(1).max(20),
});

/**
 * Bad input is the caller's fault, so it comes back as `invalid-argument` with
 * the offending field named. Letting a raw ZodError escape would surface as
 * `internal` ("An error occurred") via wrapCallable AND be captured in Sentry
 * as a server bug, which is the wrong signal for a mistyped uid list.
 */
function parseArgs<T extends z.ZodTypeAny>(schema: T, data: unknown, name: string): z.infer<T> {
  try {
    return schema.parse(data ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', `${name} validation failed`, {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }
}

/**
 * Turns a roster refusal into a `failed-precondition` the client can render.
 * A refusal is the roster contract answering ("that would empty the roster"),
 * and its message already names the remedy, so it has to reach the client
 * intact instead of being flattened to an opaque `internal`.
 */
async function guardRefusals<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BusinessAdminRosterError) {
      throw new HttpsError('failed-precondition', err.message, { refusal: err.refusal });
    }
    throw err;
  }
}

/**
 * A uid being ADDED to the roster has to already be on the staff roster, the
 * same gate `assignAuntie` applies before assigning a visit.
 *
 * The roster is a kinfolk-PII distribution list (booking details, inbound
 * customer messages, ratings), so "any uid the caller types" is too wide a
 * grant. Only additions are checked: uids already stored are grandfathered,
 * because a self-heal from `AUNTIE_OPERATOR_UIDS` can legitimately have seeded
 * an operator who has no `staff/{uid}` document yet, and `setBusinessAdmins`
 * must not be blocked from KEEPING them. The caller is exempt for the same
 * reason: they passed `wrapAdminCallable`, so they are an operator by
 * definition, and this is the bootstrap path.
 */
async function assertAdditionsAreStaff(requested: string[], callerUid: string): Promise<void> {
  const current = await readBusinessAdmins();
  const grandfathered = new Set([...current.uids, callerUid]);
  const additions = [...new Set(requested)].filter((uid) => !grandfathered.has(uid));
  if (additions.length === 0) return;

  const firestore = db();
  const snaps = await firestore.getAll(...additions.map((uid) => firestore.collection('staff').doc(uid)));
  const missing = additions.filter((_uid, i) => !snaps[i]?.exists);
  if (missing.length > 0) {
    throw new HttpsError(
      'failed-precondition',
      `No staff record for ${missing.join(', ')}. Business notifications carry kinfolk PII, `
        + 'so only an existing staff member can be added to the business admin roster.',
    );
  }
}

function requireCaller(req: CallableRequest<unknown>): string {
  const callerUid = req.auth?.uid;
  if (!callerUid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  return callerUid;
}

/**
 * Seeds or grows the roster. Idempotent and never narrowing: the stored roster
 * is unioned with whatever is passed, so calling it twice (or with a partial
 * list) cannot drop an operator. Safe to call any time.
 *
 * The caller is always included. That is what makes this work for a solo
 * operator with no env allowlist bound and no roster to copy from.
 */
export async function provisionBusinessAdminsHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; uids: string[] }> {
  initSentry();
  const callerUid = requireCaller(req);

  const args = parseArgs(AddArgs, req.data, 'provisionBusinessAdmins');
  const uids = [...new Set([callerUid, ...(args.uids ?? [])])];
  await assertAdditionsAreStaff(uids, callerUid);

  const written = await guardRefusals(() =>
    addBusinessAdminUids(uids, {
      defaultAssigneeUid: args.defaultAssigneeUid,
      reason: 'provisionBusinessAdmins',
    }),
  );

  logEvent({
    severity: 'info',
    function: 'provisionBusinessAdmins',
    event: 'businessAdmins.provisioned',
    uid: callerUid,
    extra: { count: written.length },
  });

  return { ok: true, uids: written };
}

/**
 * Replaces the roster with exactly `uids`, the authoritative-set counterpart to
 * `provisionBusinessAdmins`. For a roster editor that submits the whole list.
 *
 * Refuses (rather than silently re-inserting) when the caller left themselves
 * out, so a UI that dropped them by accident is told instead of locking them
 * out of their own business notifications.
 */
export async function setBusinessAdminsHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true } & RosterChange> {
  initSentry();
  const callerUid = requireCaller(req);
  const args = parseArgs(UidListArgs, req.data, 'setBusinessAdmins');
  await assertAdditionsAreStaff(args.uids, callerUid);

  const change = await guardRefusals(() =>
    setBusinessAdminUids(args.uids, { actorUid: callerUid, reason: 'setBusinessAdmins' }),
  );

  logEvent({
    severity: change.removed.length > 0 ? 'warn' : 'info',
    function: 'setBusinessAdmins',
    event: 'businessAdmins.rosterSet',
    uid: callerUid,
    extra: { count: change.uids.length, removed: change.removed },
  });

  return { ok: true, ...change };
}

/**
 * Revokes named uids. The minimal-blast-radius path and the one a revoke button
 * should call: it names only what is being taken away, so it cannot clobber a
 * concurrent add the way a whole-list `set` can.
 */
export async function removeBusinessAdminsHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true } & RosterChange> {
  initSentry();
  const callerUid = requireCaller(req);
  const args = parseArgs(UidListArgs, req.data, 'removeBusinessAdmins');

  const change = await guardRefusals(() =>
    removeBusinessAdminUids(args.uids, { actorUid: callerUid, reason: 'removeBusinessAdmins' }),
  );

  logEvent({
    severity: 'warn',
    function: 'removeBusinessAdmins',
    event: 'businessAdmins.rosterRevoked',
    uid: callerUid,
    extra: {
      count: change.uids.length,
      removed: change.removed,
      defaultAssigneeCleared: change.defaultAssigneeCleared,
    },
  });

  return { ok: true, ...change };
}

/**
 * Read-only health check: reports whether business notifications can currently
 * be delivered, without sending one. Returns `ok:false` plus the reason instead
 * of throwing, so a status surface can render the problem.
 */
export async function checkBusinessAdminsHandler(
  _req: CallableRequest<unknown>,
): Promise<{ ok: boolean; uids: string[]; reason: string | null }> {
  initSentry();
  try {
    const uids = await resolveBusinessAdminUids('checkBusinessAdmins');
    return { ok: true, uids, reason: null };
  } catch (err) {
    return { ok: false, uids: [], reason: err instanceof Error ? err.message : 'unknown' };
  }
}

/** Where the roster lives, in the words the notification gate already uses. */
const ROSTER_PATH = 'businessSettings/admins.uids';

/** One person on the roster, resolved from a uid to somebody with a name. */
export interface BusinessAdminMember {
  uid: string;
  /** From `staff/{uid}`. Null when there is no staff record, or it has no name. */
  displayName: string | null;
  email: string | null;
  /**
   * False when no `staff/{uid}` document exists for this uid. A real state, not
   * an error: the self-heal in `lib/businessAdmins.ts` can seed an operator
   * from `AUNTIE_OPERATOR_UIDS` who never had a staff record, and
   * `setBusinessAdmins` grandfathers them in deliberately. They still receive
   * every business notification, so they belong on this list with the uid
   * showing rather than being quietly dropped from it.
   */
  hasStaffRecord: boolean;
  /** True when unassigned visits default to this person. */
  defaultAssignee: boolean;
}

/** Which arm of the recipient order answered. */
export type BusinessAdminRosterSource = 'roster' | 'operatorAllowlist' | 'none';

export interface ListBusinessAdminsResult {
  members: BusinessAdminMember[];
  source: BusinessAdminRosterSource;
  rosterPath: string;
  /** Why there is nobody, when there is nobody. Null when there are members. */
  reason: string | null;
}

/**
 * WHO a business notification reaches, by name (issue #450).
 *
 * The notification gate could say "every business admin, that is 4 people
 * today" and name the Firestore document, and stop there. For every other
 * audience the gate answers with a description of a person; for this one the
 * operator had to go and read the roster themselves, which is the "look it up
 * yourself" #396 was filed against.
 *
 * READ ONLY, AND THAT IS THE POINT. `resolveBusinessAdminUids` answers the same
 * question on the dispatch path and SELF-HEALS by writing the roster back from
 * `AUNTIE_OPERATOR_UIDS`. That is right for a dispatch and wrong here, for the
 * same reason `admin/notificationOverrides.ts` gives for not calling it either:
 * opening a settings screen must not quietly edit who receives business mail.
 * So this walks the same recipient order by hand, using
 * `operatorAllowlistUids()` for arm (2), and reports which arm answered in
 * `source` instead of writing anything.
 *
 * `hasStaffRecord: false` is how an allowlist-seeded operator with no
 * `staff/{uid}` document appears. They are on the list, because they do receive
 * the mail; there is simply no name to put next to the uid.
 */
export async function listBusinessAdminsHandler(
  _req: CallableRequest<unknown>,
): Promise<ListBusinessAdminsResult> {
  initSentry();
  const settings = await readBusinessAdmins();
  const fromRoster = settings.uids.length > 0;
  const uids = fromRoster ? settings.uids : operatorAllowlistUids();

  if (uids.length === 0) {
    return {
      members: [],
      source: 'none',
      rosterPath: ROSTER_PATH,
      reason:
        `${ROSTER_PATH} is empty and this function has no operator allowlist to fall back on, `
        + 'so a business notification currently reaches nobody and fails to dispatch. '
        + 'Call provisionBusinessAdmins as an operator to seed the roster.',
    };
  }

  const defaultAssigneeUid = defaultAssigneeUidFrom(settings);
  const firestore = db();
  const snaps = await firestore.getAll(...uids.map((uid) => firestore.collection('staff').doc(uid)));
  const members: BusinessAdminMember[] = uids.map((uid, i) => {
    const snap = snaps[i];
    const data = (snap?.exists ? snap.data() : undefined) as
      | { displayName?: unknown; email?: unknown }
      | undefined;
    const displayName = typeof data?.displayName === 'string' ? data.displayName.trim() : '';
    const email = typeof data?.email === 'string' ? data.email.trim() : '';
    return {
      uid,
      displayName: displayName || null,
      email: email || null,
      hasStaffRecord: snap?.exists === true,
      defaultAssignee: uid === defaultAssigneeUid,
    };
  });

  return {
    members,
    source: fromRoster ? 'roster' : 'operatorAllowlist',
    rosterPath: ROSTER_PATH,
    reason: null,
  };
}

const CALLABLE_OPTS: CallableOptions = {
  region: 'us-central1',
  cors: TRIBETAILS_CORS,
  // AUNTIE_OPERATOR_UIDS is a Secret Manager secret, not a functions/.env
  // value, so it only resolves in a function that binds it here. Unbound it
  // reads `undefined` with no error. See lib/businessAdmins.ts.
  secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
};

export const provisionBusinessAdmins = onCall(
  CALLABLE_OPTS,
  wrapAdminCallable('provisionBusinessAdmins', provisionBusinessAdminsHandler),
);

export const setBusinessAdmins = onCall(
  CALLABLE_OPTS,
  wrapAdminCallable('setBusinessAdmins', setBusinessAdminsHandler),
);

export const removeBusinessAdmins = onCall(
  CALLABLE_OPTS,
  wrapAdminCallable('removeBusinessAdmins', removeBusinessAdminsHandler),
);

export const checkBusinessAdmins = onCall(
  CALLABLE_OPTS,
  wrapAdminCallable('checkBusinessAdmins', checkBusinessAdminsHandler),
);
export const listBusinessAdmins = onCall(
  CALLABLE_OPTS,
  wrapAdminCallable('listBusinessAdmins', listBusinessAdminsHandler),
);
