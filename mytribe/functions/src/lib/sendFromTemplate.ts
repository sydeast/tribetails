import { db } from './firestoreAdmin';
import { sendTemplatedEmail } from './email';
import { sendPartsFor } from './emailFrame';
import { loadEmailFrame } from './emailFrameStore';
import type { EmailFrame } from './emailFrameConfig';
import { assertNotHardBounced } from './suppressions';
import { businessTokens, loadBusinessName } from './businessName';

/**
 * Whether a `notificationTemplateBindings` doc is live, given its `active`
 * field exactly as Firestore hands it back (`undefined` when the doc never
 * set it).
 *
 * A missing field is ON, not off: a binding written before `active` existed,
 * or written by a caller that never sent the field, still dispatches. This is
 * the ONE place that rule is written down. #965 was a client reading a
 * missing field as off while this file (dispatch) already read it as on;
 * every reader of `active`, on the server or a client decoding what the
 * server sent, must call this instead of re-deriving the rule.
 */
export function isBindingActive(active: unknown): boolean {
  return active !== false;
}

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
    if (isBindingActive(data.active) && data.templateId) {
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
    if (isBindingActive(data.active) && data.templateId) activeBindings.set(key, data.templateId);
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

export interface SendFromTemplateOptions {
  /**
   * #1077: the person this mail goes to asked for it just now (the invite
   * verification mail from the claim screen). Sent past a hard-bounce
   * suppression, because refusing it would lock them out with no way back.
   */
  personRequested?: boolean;
}
/**
 * `frame` (#957): the operator's email frame, when the caller already read it
 * for this invocation (`inviteEmails.ts` sends up to three emails and reads it
 * once). Left out, it is read here, once for this send.
 *
 * #1077: refuses an address smtp2go reported as a HARD BOUNCE, before any
 * provider call, by throwing failed-precondition `recipient_hard_bounced`. A
 * throw here fails the caller exactly where a provider failure already would,
 * so every caller's existing error handling covers it. Marketing opt-outs are
 * not consulted: nothing sent through here is marketing.
 *
 * A missing template document THROWS, and never falls back to the repo's seed
 * copy (#1586). The operator decides which notifications exist, and deleting
 * a template is how they say a send should stop (operator ruling 2026-08-18,
 * "I did not need that type of notification"); a repo copy would quietly send
 * it again. A template reaches the bank through Template Import or authoring,
 * and Manage assignments names every key whose send this throw would break.
 */
export async function sendFromTemplate(
  key: string,
  to: string,
  data: Record<string, unknown>,
  frame?: EmailFrame,
  options: SendFromTemplateOptions = {},
): Promise<string> {
  if (!options.personRequested) await assertNotHardBounced(to);
  const tpl = await loadEmailTemplate(key);
  if (!tpl) throw new Error(`email template missing: resolved from ${key}`);
  const resolvedFrame = frame ?? (await loadEmailFrame('sendFromTemplate'));
  const parts = sendPartsFor(tpl, resolvedFrame);
  return sendTemplatedEmail({ to, data: withLink(await withBusinessName(data, parts), parts), templateKey: key, ...parts });
}

/**
 * #2487: `{{link}}` on a direct send. The editor offers `{{link}}` on every
 * template, and the catalog's channel trigger fills it, but a direct send
 * never runs that trigger, so an invite written with it sent an empty button.
 * It is the send's own link: the invite or recovery claim, the address to
 * confirm, or the office's review link. A caller's own `link` wins.
 */
function withLink(
  data: Record<string, unknown>,
  parts: { subjectTemplate: string; bodyTemplate: string; htmlTemplate?: string | undefined },
): Record<string, unknown> {
  const uses = [parts.subjectTemplate, parts.bodyTemplate, parts.htmlTemplate ?? ''].some((t) =>
    /\{\{\s*link\s*\}\}/.test(t),
  );
  const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
  if (!uses || filled(data.link)) return data;
  const own = [data.claimUrl, data.verifyUrl, data.auntieReviewUrl].find(filled);
  return own ? { ...data, link: own } : data;
}

/**
 * #2487: `{{business}}` / `{{Business}}` on a direct send. The template editor
 * offers the business name to every template, and the catalog's senders fill it
 * (`enrichTemplateData`), but a direct send never runs the enricher, so an
 * invite written with it read "Welcome to ". Filled here the same way: the
 * settings name, or the neutral wording when it is unset. A caller's own value
 * wins, and the settings document is read only when the template uses one.
 */
async function withBusinessName(
  data: Record<string, unknown>,
  parts: { subjectTemplate: string; bodyTemplate: string; htmlTemplate?: string | undefined },
): Promise<Record<string, unknown>> {
  const uses = [parts.subjectTemplate, parts.bodyTemplate, parts.htmlTemplate ?? ''].some((t) =>
    /\{\{\s*business\s*\}\}/i.test(t),
  );
  const blank = (v: unknown) => typeof v !== 'string' || v.trim() === '';
  if (!uses || (!blank(data.business) && !blank(data.Business))) return data;
  const tokens = businessTokens(await loadBusinessName('sendFromTemplate'));
  return {
    ...data,
    ...(blank(data.business) ? { business: tokens.business } : {}),
    ...(blank(data.Business) ? { Business: tokens.Business } : {}),
  };
}

