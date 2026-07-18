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

/**
 * AO-41 Supplies Tracker (dashboard widget). Admin-only `supplies` collection.
 * listSupplies returns every supply plus how many are at/under par (the widget
 * headline); adjustSupply nudges onHand (clamped at 0, fail loud on a missing
 * supply); upsertSupply creates or updates one. Fail loud: no fabricated stock.
 */

export const SUPPLIES_COLLECTION = 'supplies';

export const AdjustSupplyArgs = z.object({
  supplyId: z.string().min(1).max(200),
  delta: z.number().int().min(-100_000).max(100_000),
});

export const UpsertSupplyArgs = z.object({
  supplyId: z.string().min(1).max(200).optional(),
  name: z.string().min(1).max(200),
  onHand: z.number().int().min(0).max(1_000_000),
  par: z.number().int().min(0).max(1_000_000),
  unit: z.string().min(1).max(40),
});

export interface SupplyRow {
  _id: string;
  name: string;
  onHand: number;
  par: number;
  unit: string;
}

export async function listSuppliesHandler(
  req: CallableRequest<unknown>,
): Promise<{ supplies: SupplyRow[]; lowCount: number }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const snap = await db().collection(SUPPLIES_COLLECTION).get();
  const supplies: SupplyRow[] = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      _id: d.id,
      name: typeof data.name === 'string' ? data.name : '',
      onHand: typeof data.onHand === 'number' ? data.onHand : 0,
      par: typeof data.par === 'number' ? data.par : 0,
      unit: typeof data.unit === 'string' ? data.unit : '',
    };
  });
  supplies.sort((a, b) => a.name.localeCompare(b.name));
  const lowCount = supplies.filter((s) => s.onHand <= s.par).length;

  return { supplies, lowCount };
}

export async function adjustSupplyHandler(
  req: CallableRequest<unknown>,
): Promise<{ onHand: number }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof AdjustSupplyArgs>;
  try {
    args = AdjustSupplyArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'adjustSupply validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const ref = db().collection(SUPPLIES_COLLECTION).doc(args.supplyId);
  const onHand = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new HttpsError('not-found', `Supply ${args.supplyId} does not exist.`);
    }
    const data = snap.data() as Record<string, unknown>;
    const current = typeof data.onHand === 'number' ? data.onHand : 0;
    const next = Math.max(0, current + args.delta); // clamp at 0, never negative stock
    tx.update(ref, { onHand: next, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    return next;
  });

  await writeAuditEntry({
    event: AUDIT_EVENTS.SUPPLY_ADJUSTED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: SUPPLIES_COLLECTION,
    payload: { supplyId: args.supplyId, delta: args.delta, onHand },
  });

  logEvent({
    severity: 'info',
    function: 'adjustSupply',
    event: 'admin.supply.adjusted',
    uid,
    extra: { supplyId: args.supplyId, delta: args.delta, onHand },
  });

  return { onHand };
}

export async function upsertSupplyHandler(
  req: CallableRequest<unknown>,
): Promise<{ id: string }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof UpsertSupplyArgs>;
  try {
    args = UpsertSupplyArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'upsertSupply validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const coll = db().collection(SUPPLIES_COLLECTION);
  const ref = args.supplyId ? coll.doc(args.supplyId) : coll.doc();
  const created = !args.supplyId;
  await ref.set(
    {
      name: args.name,
      onHand: args.onHand,
      par: args.par,
      unit: args.unit,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: uid,
      ...(created ? { createdAt: FieldValue.serverTimestamp() } : {}),
    },
    { merge: true },
  );

  await writeAuditEntry({
    event: AUDIT_EVENTS.SUPPLY_UPSERTED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: SUPPLIES_COLLECTION,
    payload: { id: ref.id, created, name: args.name },
  });

  logEvent({
    severity: 'info',
    function: 'upsertSupply',
    event: 'admin.supply.upserted',
    uid,
    extra: { id: ref.id, created },
  });

  return { id: ref.id };
}

export const listSupplies = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listSupplies', listSuppliesHandler),
);

export const adjustSupply = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('adjustSupply', adjustSupplyHandler),
);

export const upsertSupply = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('upsertSupply', upsertSupplyHandler),
);
