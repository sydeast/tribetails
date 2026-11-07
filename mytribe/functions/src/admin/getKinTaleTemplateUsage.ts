import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
/**
 * #1591: what a KinTale template is used by, so the delete-for-good confirm can
 * say how many KinTales used it before the operator commits.
 *
 * Operator ruling, 2026-11-05 docket: "both". Remove archives a template
 * (restorable, hidden from the list and from new KinTales); deleting for good
 * happens only from inside the archive, with the warning that names this
 * count. A KinTale is a `kin_care_reports` doc and records the template it was
 * written from in `templateId`; the built-in default has no doc and no id on
 * the report, so it is never counted here.
 *
 * Reads only. Owner-only through `wrapAdminCallable`, the same split as the
 * `kintale_templates` write rule (`allow write: if isOwner()`).
 */
export const GetKinTaleTemplateUsageArgs = z.object({
  templateId: z.string().min(1).max(200),
});
export interface KinTaleTemplateUsage {
  templateId: string;
  /** False when no such template doc exists (already gone, or a stale id). */
  exists: boolean;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  /** True when the template sits in the archive (the only place it can be deleted from). */
  archived: boolean;
  /** KinTales (sent or draft) written from this template. */
  kintaleCount: number;
  /** Other live (active, not archived) templates a service type could fall back to. */
  otherActiveTemplateCount: number;
}
export async function getKinTaleTemplateUsageHandler(
  req: CallableRequest<unknown>,
): Promise<KinTaleTemplateUsage> {
  initSentry();
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = GetKinTaleTemplateUsageArgs.parse(req.data);
  const firestore = db();
  const [tplSnap, countSnap, activeSnap] = await Promise.all([
    firestore.collection('kintale_templates').doc(args.templateId).get(),
    firestore.collection('kin_care_reports').where('templateId', '==', args.templateId).count().get(),
    firestore.collection('kintale_templates').where('isActive', '==', true).get(),
  ]);
  const data = (tplSnap.exists ? tplSnap.data() : undefined) as Record<string, unknown> | undefined;
  const otherActive = activeSnap.docs.filter(
    (d) => d.id !== args.templateId && (d.data() as Record<string, unknown>)['archived'] !== true,
  ).length;
  return {
    templateId: args.templateId,
    exists: tplSnap.exists,
    name: typeof data?.['name'] === 'string' ? (data['name'] as string) : '',
    isDefault: data?.['isDefault'] === true,
    isActive: data?.['isActive'] !== false,
    archived: data?.['archived'] === true,
    kintaleCount: Number(countSnap.data().count ?? 0),
    otherActiveTemplateCount: otherActive,
  };
}
export const getKinTaleTemplateUsage = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('getKinTaleTemplateUsage', getKinTaleTemplateUsageHandler),
);
