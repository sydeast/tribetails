import { db } from './firestoreAdmin';
import { sendTemplatedEmail } from './email';
import { sendPartsFor } from './emailFrame';

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

/** Everything the bindings collection says, read once. */
export interface TemplateBindings {
  /** Every key that has a binding doc, active or not. */
  boundKeys: Set<string>;
  /** key -> templateId for bindings that are NOT inactive. */
  activeBindings: Map<string, string>;
}
/**
 * THE one read of `notificationTemplateBindings`, for every caller that needs
 * to answer "what does this key send right now" in bulk.
 *
 * `resolveTemplateId` above is the single-key version and reads one doc, which
 * is right on the send path. Anything rendering a LIST (the Assignments screen
 * via listCatalogKeys, the notification gate's "which template writes it" line
 * via getBusinessNotificationOverrides) needs the whole collection, and each of
 * those growing its own loop is how two admin screens start disagreeing about
 * which template a key sends. The inactive-binding rule in particular is easy
 * to get subtly wrong in a second copy: an inactive binding falls back to the
 * default, because disabling a binding means "revert to default", not "send
 * nothing", and that decision is made here exactly once.
 *
 * A doc's `catalogKey` field wins over its id when present, matching what
 * `listCatalogKeys` has always done for hand-seeded rows.
 */
export async function readTemplateBindings(): Promise<TemplateBindings> {
  const snap = await db().collection('notificationTemplateBindings').get();
  const boundKeys = new Set<string>();
  const activeBindings = new Map<string, string>();
  for (const d of snap.docs) {
    const data = d.data() as { catalogKey?: string; templateId?: string; active?: boolean };
    const key = (typeof data.catalogKey === 'string' && data.catalogKey) || d.id;
    if (!key) continue;
    boundKeys.add(key);
    if (data.active !== false && data.templateId) activeBindings.set(key, data.templateId);
  }
  return { boundKeys, activeBindings };
}
/** One `emailTemplates/{id}` document, as the senders consume it. */
export interface EmailTemplateDoc {
  subject: string;
  /** Old format only. */
  body?: string | null;
  /** Old format only. */
  html?: string | null;
  /** #953: 'visual' means headline + content, framed at send time. */
  format?: 'visual';
  headline?: string;
  content?: string;
}

/**
 * Resolves a catalog key to its email template document, or NULL when that
 * document does not exist.
 *
 * Split out of `sendFromTemplate` so a caller can tell "the operator has not
 * authored this yet" apart from "the send failed", WITHOUT matching on an error
 * message and without paying a second read to pre-check. `emailChannel` uses it
 * to fall back to generic wording; see `notifications/fallbackTemplate.ts`.
 */
export async function loadEmailTemplate(key: string): Promise<EmailTemplateDoc | null> {
  const templateId = await resolveTemplateId(key);
  const snap = await db().doc(`emailTemplates/${templateId}`).get();
  if (!snap.exists) return null;
  return snap.data() as EmailTemplateDoc;
}

export async function sendFromTemplate(
  key: string,
  to: string,
  data: Record<string, unknown>,
): Promise<string> {
  const tpl = await loadEmailTemplate(key);
  if (!tpl) throw new Error(`email template missing: resolved from ${key}`);
  return sendTemplatedEmail({ to, data, ...sendPartsFor(tpl) });
}
