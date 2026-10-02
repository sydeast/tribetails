import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { isValidPhone } from '../lib/phoneNormalize';
import {
  SUPPRESSIONS,
  isHardBounced,
  normalizeRecipient,
  redactRecipient,
  suppressionDocId,
} from '../lib/suppressions';

/**
 * The admin's window onto `message_suppressions` (#1083): list what is on the
 * do-not-send list and clear an entry. The collection stays default-deny to
 * clients (`firestore.rules` has no match for it), so these two callables are
 * the only way a person reads or removes a row.
 *
 * Owner-only: neither name is in `lib/auntieAccess.ts`, so `wrapAdminCallable`
 * refuses an Auntie. Clearing a hard bounce puts a dead address back in play,
 * so it is the owner's call.
 *
 * Clear removes a BOUNCE and nothing else. An opt-out is the household's own
 * consent choice and a bounce is a delivery fact, so they are not the same kind
 * of row. A doc that holds both keeps its opt-out (the bounce fields are
 * stripped), and an opt-out-only row cannot be cleared here at all.
 *
 * The doc id is `encodeURIComponent(normalizedRecipient)`, so the full address
 * is recoverable from the id. That is what lets the list show it and what lets
 * clear take it. Clear never accepts the redacted form.
 */
export type SuppressionReason = 'hard_bounce' | 'opt_out';

export type SuppressionSource = 'smtp2go' | 'admin';

export interface MessageSuppressionItem {
  /** Full normalized address (lowercased email or E.164). Admin-only; pass it back to clear. */
  recipient: string;
  recipientRedacted: string;
  channel: 'email' | 'sms';
  reason: SuppressionReason;
  source: SuppressionSource;
  suppressedAtMs: number;
  /** True when the household (or the owner for them) opted out, whether or not it also bounced. */
  optedOut: boolean;

  /** smtp2go webhook event id of the bounce, else null. */
  eventId: string | null;
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

/** Rows read per Firestore page while a reason filter skips non-matches. */
const SCAN_PAGE = 100;

/** Hard ceiling on pages scanned for one call, so a rare filter cannot walk the whole collection. */
const MAX_SCAN_PAGES = 10;

const ListArgs = z
  .object({
    reason: z.enum(['all', 'hard_bounce', 'opt_out']).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict();

function parseArgs<S extends z.ZodTypeAny>(schema: S, data: unknown, fn: string): z.infer<S> {
  try {
    return schema.parse(data ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', `${fn} validation failed`, {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }
}

function decodeId(id: string): string {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

function toItem(id: string, data: Record<string, unknown>): MessageSuppressionItem {
  const recipient = decodeId(id);
  const channel: 'email' | 'sms' = data.channel === 'sms' ? 'sms' : 'email';
  const bounced = isHardBounced(data);
  const block = (data.hardBounce ?? null) as Record<string, unknown> | null;
  const eventId = bounced && block && typeof block.eventId === 'string' ? block.eventId : null;
  const redacted =
    typeof data.recipientRedacted === 'string' && data.recipientRedacted !== ''
      ? data.recipientRedacted
      : redactRecipient(channel, recipient);
  return {
    recipient,
    recipientRedacted: redacted,
    channel,
    reason: bounced ? 'hard_bounce' : 'opt_out',
    source: bounced ? 'smtp2go' : 'admin',
    suppressedAtMs: typeof data.suppressedAtMs === 'number' ? data.suppressedAtMs : 0,
    // `suppressExternalRecipient` always stamps `actorUid`; the smtp2go webhook never does.
    optedOut: typeof data.actorUid === 'string' && data.actorUid !== '',
    eventId,
  };
}

export async function listMessageSuppressionsHandler(
  req: CallableRequest<unknown>,
): Promise<{ items: MessageSuppressionItem[]; nextCursor: string | null }> {
  initSentry();
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const args = parseArgs(ListArgs, req.data, 'listMessageSuppressions');
  const limit = args.limit ?? DEFAULT_LIMIT;
  const want = args.reason ?? 'all';
  let after = args.cursor
    ? await db().doc(`${SUPPRESSIONS}/${args.cursor}`).get()
    : null;
  if (after && !after.exists) after = null;

  const items: MessageSuppressionItem[] = [];
  let more = false;
  // The id of the last row READ, matched or not. When the scan ceiling is hit
  // with a rare filter and the page is short, this is where the next call resumes.
  let scannedTo: string | null = null;
  let exhausted = false;
  for (let page = 0; page < MAX_SCAN_PAGES && !more; page += 1) {
    let q = db().collection(SUPPRESSIONS).orderBy('suppressedAtMs', 'desc').limit(SCAN_PAGE);
    if (after) q = q.startAfter(after);
    const snap = await q.get();
    for (const doc of snap.docs) {
      scannedTo = doc.id;
      const item = toItem(doc.id, doc.data() as Record<string, unknown>);
      if (want !== 'all' && item.reason !== want) continue;
      if (items.length === limit) {
        more = true;
        break;
      }
      items.push(item);
    }
    if (snap.docs.length < SCAN_PAGE) {
      exhausted = true;
      break;
    }
    after = snap.docs[snap.docs.length - 1];
  }

  const last = items[items.length - 1];
  if (more && last) return { items, nextCursor: suppressionDocId(last.recipient) };
  // Ceiling hit before the page filled: more rows may exist past what was scanned.
  if (!more && !exhausted && scannedTo) return { items, nextCursor: scannedTo };
  return { items, nextCursor: null };
}

export const listMessageSuppressions = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listMessageSuppressions', listMessageSuppressionsHandler),
);

const ClearArgs = z
  .object({ recipient: z.string().min(1).max(320) })
  .strict()
  .superRefine((val, ctx) => {
    const to = val.recipient.trim();
    // The redacted form (`j***@example.com`) is display-only. Accepting it would
    // let a lookalike address match a different row.
    if (to.includes('*')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recipient'], message: 'the full address is required' });
    } else if (to.includes('@')) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recipient'], message: 'invalid email address' });
      }
    } else if (!isValidPhone(to)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recipient'], message: 'invalid phone number (E.164 expected)' });
    }
  });

export async function clearMessageSuppressionHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; channel: 'email' | 'sms'; recipientRedacted: string; optOutKept: boolean }> {
  initSentry();

  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const args = parseArgs(ClearArgs, req.data, 'clearMessageSuppression');
  const to = args.recipient.trim();
  const channel: 'email' | 'sms' = to.includes('@') ? 'email' : 'sms';
  let normalized: string;
  try {
    normalized = normalizeRecipient(channel, to);
  } catch (err) {
    throw new HttpsError('invalid-argument', (err as Error).message);
  }

  const ref = db().doc(`${SUPPRESSIONS}/${suppressionDocId(normalized)}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'That address is not on the do-not-send list.');

  const item = toItem(ref.id, (snap.data() ?? {}) as Record<string, unknown>);
  if (item.reason !== 'hard_bounce') {
    throw new HttpsError('failed-precondition', "opt_out_stays: an opt-out is the household's choice and cannot be cleared here.");
  }
  const optOutKept = item.optedOut;
  if (optOutKept) {
    // Strip the bounce only. Dropping `reason` too is what returns the doc to a
    // plain opt-out; `isHardBounced` would otherwise still read it as bounced.
    await ref.update({
      reason: FieldValue.delete(),
      source: FieldValue.delete(),
      hardBounce: FieldValue.delete(),
    });
  } else {
    await ref.delete();
  }
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.EXTERNAL_SUPPRESSION_CLEARED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: 'message_suppressions',
    description: `External ${channel} suppression cleared for ${item.recipientRedacted}`,
    payload: {
      channel,
      recipientRedacted: item.recipientRedacted,
      reason: item.reason,
      source: item.source,
      suppressedAtMs: item.suppressedAtMs,
      optOutKept,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'clearMessageSuppression',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });
  logEvent({
    severity: 'info',
    function: 'clearMessageSuppression',
    event: 'admin.external.suppression.cleared',
    uid,
    extra: { channel, recipientRedacted: item.recipientRedacted, reason: item.reason, optOutKept },
  });
  return { ok: true, channel, recipientRedacted: item.recipientRedacted, optOutKept };
}

export const clearMessageSuppression = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('clearMessageSuppression', clearMessageSuppressionHandler),
);
