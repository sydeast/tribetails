import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveInvoiceWriteActor, testOwnsDoc } from '../lib/testMode';
import { invoiceStateOf, paymentStandingOf, invoiceEditScope } from '../lib/invoiceEditPolicy';
import { paidCentsFromPayments, invoiceTotalCentsOf, type PaymentAmount } from '../lib/invoiceMath';
import { validateResponse } from '../lib/callableResponse';
import {
  InvoiceEditScopeSchema,
  InvoiceStateSchema,
  OkSchema,
} from '../lib/invoiceResponseSchema';

/**
 * Sets the invoice<->session link IN BOTH DIRECTIONS, atomically. W2-1 of
 * ADR-0002 (docs/adr/0002-callable-only-invoice-writes.md): this absorbs the
 * two direct Firestore writes Android performs today,
 * `AuntieRepository.updateInvoiceSessionIds` (invoice side) and
 * `AuntieRepository.updateSessionInvoiceId` (session side, called once per
 * added and once per removed session).
 *
 * WHY ONE CALLABLE OWNS BOTH SIDES. Android's `saveLinks` writes the invoice
 * first and then loops the sessions, logging and CONTINUING on a per-session
 * failure. A session write that fails mid-loop leaves the invoice claiming a
 * session that still points elsewhere (or nowhere), and nothing ever
 * reconciles the two. Here every read happens before any write inside one
 * Firestore transaction: either the invoice's `sessionIds` and every touched
 * session's `invoiceId` all change together, or none of them do.
 *
 * `sessionIds` IS THE FULL NEW SET, not a delta, matching what Android's edit
 * screen holds when the operator hits save. The delta is derived HERE against
 * the stored set, inside the transaction, so two concurrent saves cannot both
 * compute against the same stale snapshot. Link and unlink are the same
 * operation: sessions newly in the set gain `invoiceId`, sessions dropped from
 * it are cleared. An empty array unlinks everything.
 *
 * THE ATTRIBUTION STAMPS ARE ANDROID'S, byte for byte. The invoice gets
 * `_attribution: 'manual'` (the operator curated this set by hand, true for
 * an unlink too, which is why Android writes 'manual' on the invoice even when
 * the set only shrank); an added session gets `'manual'`; a removed session
 * gets `'manual_unlink'` with `invoiceId: ''`, an EMPTY STRING, not a delete,
 * because `listUninvoicedSessions` treats absent, empty and whitespace as one
 * unclaimed state and a delete would split that state in two.
 * `_attributionAt` is an ISO-8601 STRING, not a server Timestamp: the Android
 * `Invoice` model decodes it as a non-null Kotlin `String`, and a Timestamp
 * there throws under `toObject()` and blanks the whole invoice list (the
 * Class B decode crash documented on that model). `updatedAt` is a server
 * Timestamp, the convention of every callable writer; both models tolerate it
 * (`Invoice` does not declare the field, `KinCareSession.updatedAt` is `Any?`).
 *
 * TESTMODE IS ENFORCED SERVER-SIDE (lib/testMode.ts): a sandbox caller may
 * only link an invoice and sessions whose `kinfolkId` equals their
 * `testTribeId` claim. Staff are unscoped, and there is deliberately NO
 * invoice/session kinfolk-equality check on the staff path: legacy rows carry
 * blank kinfolkIds, and Android performs no such check today, so adding one
 * here would refuse links that currently succeed.
 *
 * STATE PERSIST (ADR-0002 decision 2): the classifier's `status` + `editScope`
 * are stamped onto the invoice on every write. Linking changes none of the
 * classifier's inputs, so this normalizes rather than transitions (e.g. a
 * stored 'QUOTE' is re-stamped as its classified 'quote'; every reader already
 * lowercases before comparing). Computed inline via lib/invoiceEditPolicy;
 * the shared stamping helper and the sweep over existing writers belong to the
 * parallel feat/invoice-state-persist branch, which will normalize this site
 * too.
 *
 * Linking is NOT gated on editScope: attributing which sessions a paid or
 * cancelled invoice covered is legitimate after-the-fact bookkeeping (it moves
 * no money), and Android permits it today.
 */
// Exported so the callable-contract drift guard can freeze this request shape.
export const Args = z.object({
  invoiceId: z.string().min(1).max(200),
  /** The invoice's complete new session set. Duplicates are collapsed. */
  sessionIds: z.array(z.string().min(1).max(200)).max(200),
});

/**
 * The RESPONSE shape (ADR-0001 step W3-1), and the source of the TS type
 * below: the schema is the authority for both directions, so the hand-written
 * interface this replaced is gone rather than kept beside it as a second
 * description to drift from.
 *
 * `added` / `removed` are the DELTA the server derived inside its transaction
 * against the stored set. The caller sent a full set and cannot have computed
 * them. Android's `decodeInvoiceSessionLinks` reads all three lists.
 */
export const Result = z
  .object({
    ok: OkSchema,
    invoiceId: z.string().min(1),
    /** The stored set after this write. */
    sessionIds: z.array(z.string()),
    /** Sessions that gained `invoiceId` in this write. */
    added: z.array(z.string()),
    /** Sessions whose `invoiceId` was cleared in this write. */
    removed: z.array(z.string()),
    /**
     * The classifier state persisted onto the doc (ADR-0002). NOT nullable and
     * NOT a free string: linking always stamps, so a caller that reads this
     * field is reading the same eight-state vocabulary the doc now carries.
     */
    status: InvoiceStateSchema,
    editScope: InvoiceEditScopeSchema,
  })
  .strict();

export type LinkInvoiceSessionsResult = z.infer<typeof Result>;

type InvoiceDoc = {
  kinfolkId?: string;
  invoiceNumber?: string;
  sessionIds?: unknown;
  // The classifier's inputs (lib/invoiceEditPolicy.ts#InvoiceStateDoc) and the
  // cents total (lib/invoiceMath.ts#invoiceTotalCentsOf), declared so the doc
  // satisfies both weak types.
  status?: unknown;
  amountDue?: unknown;
  total?: unknown;
  totalCents?: unknown;
  creditRedeemedAt?: unknown;
  [k: string]: unknown;
};

/** The stored session set, tolerant of legacy docs where the field is absent or junk. */
function storedSessionIds(data: InvoiceDoc): string[] {
  return Array.isArray(data.sessionIds)
    ? data.sessionIds.filter((s): s is string => typeof s === 'string')
    : [];
}

export async function linkInvoiceSessionsHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const actor = resolveInvoiceWriteActor(req, 'linkInvoiceSessions');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'linkInvoiceSessions validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const newIds = Array.from(new Set(args.sessionIds));
  const invRef = db().collection('invoices').doc(args.invoiceId);
  const nowIso = new Date().toISOString();

  const outcome = await db().runTransaction(async (tx) => {
    const invSnap = await tx.get(invRef);
    if (!invSnap.exists) {
      throw new HttpsError('not-found', `Invoice '${args.invoiceId}' not found.`);
    }
    const data = invSnap.data() as InvoiceDoc;
    if (!testOwnsDoc(actor.testMode, data.kinfolkId ?? '')) {
      throw new HttpsError('permission-denied', 'This invoice is outside your test sandbox.');
    }

    const current = storedSessionIds(data);
    const currentSet = new Set(current);
    const newSet = new Set(newIds);
    const added = newIds.filter((id) => !currentSet.has(id));
    const removed = current.filter((id) => !newSet.has(id));

    // ALL reads before ANY write (a Firestore transaction requirement, and the
    // point of the design: nothing is written until every touched doc has been
    // proven to exist and to be in scope).
    const touched = [...added, ...removed];
    const sessionRefs = touched.map((id) => db().collection('kin_care_sessions').doc(id));
    const sessionSnaps = await Promise.all(sessionRefs.map((ref) => tx.get(ref)));
    const missing: string[] = [];
    sessionSnaps.forEach((snap, i) => {
      const sid = touched[i];
      if (!snap.exists) {
        missing.push(sid);
        return;
      }
      const sData = snap.data() as { kinfolkId?: string } | undefined;
      if (!testOwnsDoc(actor.testMode, sData?.kinfolkId ?? '')) {
        throw new HttpsError('permission-denied', `Session '${sid}' is outside your test sandbox.`);
      }
    });
    if (missing.length > 0) {
      // Fail-loud and atomic, unlike Android's log-and-continue loop: a link
      // set naming a session that does not exist is a caller bug, and writing
      // the rest would store an invoice that claims it.
      throw new HttpsError(
        'failed-precondition',
        `Session(s) not found: ${missing.join(', ')}.`,
        { code: 'session_not_found', missing },
      );
    }

    const paymentsSnap = await tx.get(invRef.collection('payments'));
    const paidCents = paidCentsFromPayments(paymentsSnap.docs.map((d) => d.data() as PaymentAmount));
    const state = invoiceStateOf(data);
    const scope = invoiceEditScope(state, paymentStandingOf(invoiceTotalCentsOf(data), paidCents));

    tx.set(
      invRef,
      {
        sessionIds: newIds,
        _attribution: 'manual',
        _attributionAt: nowIso,
        status: state,
        editScope: scope,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    added.forEach((sid) => {
      tx.set(
        db().collection('kin_care_sessions').doc(sid),
        {
          invoiceId: args.invoiceId,
          _attribution: 'manual',
          _attributionAt: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });
    removed.forEach((sid) => {
      tx.set(
        db().collection('kin_care_sessions').doc(sid),
        {
          invoiceId: '',
          _attribution: 'manual_unlink',
          _attributionAt: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });

    return { data, added, removed, state, scope };
  });

  await writeAuditEntry({
    event: AUDIT_EVENTS.BILLING_INVOICE_SESSIONS_LINKED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: actor.uid,
    targetUid: args.invoiceId,
    targetCollection: 'invoices',
    familyId: outcome.data.kinfolkId,
    description: `Invoice ${outcome.data.invoiceNumber ?? args.invoiceId} session links set to ${newIds.length} session(s) (${outcome.added.length} linked, ${outcome.removed.length} unlinked)`,
    payload: {
      invoiceId: args.invoiceId,
      sessionCount: newIds.length,
      added: outcome.added,
      removed: outcome.removed,
      status: outcome.state,
      editScope: outcome.scope,
      testMode: actor.testMode.active,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'linkInvoiceSessions',
      event: 'audit.write.failed',
      uid: actor.uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'linkInvoiceSessions',
    event: 'admin.invoice.sessionsLinked',
    uid: actor.uid,
    extra: {
      invoiceId: args.invoiceId,
      sessionCount: newIds.length,
      addedCount: outcome.added.length,
      removedCount: outcome.removed.length,
      testMode: actor.testMode.active,
    },
  });

  return validateResponse('linkInvoiceSessions', Result, {
    ok: true,
    invoiceId: args.invoiceId,
    sessionIds: newIds,
    added: outcome.added,
    removed: outcome.removed,
    status: outcome.state,
    editScope: outcome.scope,
  });
}

export const linkInvoiceSessions = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  // wrapCallable, NOT wrapAdminCallable: the gate must also admit a scoped
  // test admin (ADR-0002 funnels the sandbox through this same callable).
  // resolveInvoiceWriteActor at the top of the handler is the whole gate.
  wrapCallable('linkInvoiceSessions', linkInvoiceSessionsHandler),
);
