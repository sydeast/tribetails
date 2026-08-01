import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapCallable } from '../lib/wrapCallable';
import { loadMember, requirePrimary } from '../lib/memberGate';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({
  familyId: z.string().min(1),
  overrides: z.record(z.string(), z.unknown()),
});

const ALLOWED_KEYS = ['layoutDensity', 'accentChoice', 'tileOrder'] as const;

export async function setKinfolkOverridesHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const args = Args.parse(req.data);
  const caller = await loadMember(args.familyId, req.auth.uid);
  requirePrimary(caller);
  const filtered: Record<string, unknown> = {};
  for (const k of ALLOWED_KEYS) {
    if (k in args.overrides) filtered[k] = args.overrides[k];
  }
  await db().doc(`families/${args.familyId}/themeConfig/active`).update({
    kinfolkOverrides: filtered,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.THEME_KINFOLK_OVERRIDES_UPDATED,
    severity: 'info',
    actorRole: 'PRIMARY',
    actorUid: req.auth.uid,
    familyId: args.familyId,
    payload: { keys: Object.keys(filtered) },
  });
  return { ok: true };
}

export const setKinfolkOverrides = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('setKinfolkOverrides', setKinfolkOverridesHandler),
);
