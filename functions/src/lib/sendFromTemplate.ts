import { db } from './firestoreAdmin';
import { sendTemplatedEmail } from './email';

/**
 * Resolves the templateId for a catalog key via the bindings collection.
 * Falls back to the catalog key itself (legacy behavior pre-bindings).
 *
 * `notificationTemplateBindings/{catalogKey}` doc shape:
 *   { templateId: string, active: boolean, audience?: string, triggerKey?: string }
 *
 * If the binding exists but is inactive, we still fall back to the catalog
 * key default, admins disabling a binding must mean "revert to default,"
 * not "send no email."
 */
export async function resolveTemplateId(catalogKey: string): Promise<string> {
  const bindingSnap = await db().doc(`notificationTemplateBindings/${catalogKey}`).get();
  if (bindingSnap.exists) {
    const data = bindingSnap.data() as { templateId?: string; active?: boolean };
    if (data.active !== false && data.templateId) {
      return data.templateId;
    }
  }
  return catalogKey;
}

export async function sendFromTemplate(
  key: string,
  to: string,
  data: Record<string, unknown>,
): Promise<string> {
  const templateId = await resolveTemplateId(key);
  const snap = await db().doc(`emailTemplates/${templateId}`).get();
  if (!snap.exists) throw new Error(`email template missing: ${templateId} (resolved from ${key})`);
  const tpl = snap.data() as { subject: string; body: string; html?: string | null };
  return sendTemplatedEmail({
    to,
    subjectTemplate: tpl.subject,
    bodyTemplate: tpl.body,
    data,
    htmlTemplate: tpl.html ?? undefined,
  });
}
