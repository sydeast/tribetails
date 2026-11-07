import { HttpsError } from 'firebase-functions/v2/https';
import { renderEmailParts } from '../lib/email';
import { sendPartsFor } from '../lib/emailFrame';
import { businessTokens, loadBusinessName } from '../lib/businessName';
import { loadEmailTemplate } from '../lib/sendFromTemplate';
import { fallbackEmail } from '../notifications/fallbackTemplate';
import { getNotificationDef } from '../notifications/catalog';
import type { NotificationDef } from '../notifications/types';
/**
 * What a marketing blast will SAY, rendered the way the send renders it (#1587).
 *
 * The blast screens used to ask for a campaign key and a handful of bare
 * token/value rows and show no copy anywhere, so an operator scheduled an email
 * to real households without once reading it. The copy is not on the blast: it
 * is the operator's own `emailTemplates/{key}` document, rendered against the
 * `data` the blast carries. This reads that document and renders it with the
 * same `renderEmailParts` the sender uses, so the preview cannot disagree with
 * the inbox.
 *
 * ── THE THREE KINDS OF MERGE FIELD ──────────────────────────────────────────
 *   automatic  the pipeline fills it for every send (`business`, `Business`).
 *              The operator is never asked for it.
 *   provided   the blast's `data` carries a non-blank value for it.
 *   missing    the template names it and nothing supplies it. A send would
 *              render it blank, so the screen asks for it by name instead of
 *              waiting for the operator to know the token's spelling.
 *
 * A template that does not exist is not an error: the sender falls back to
 * generic wording (`notifications/fallbackTemplate.ts`), and the preview shows
 * that same wording with `usedFallback: true` so the operator sees what would
 * really go out and knows to author the template.
 */
export type MergeFieldSource = 'automatic' | 'provided' | 'missing';
export interface MergeFieldStatus {
  name: string;
  source: MergeFieldSource;
}
export interface MarketingCopyPreview {
  subject: string;
  /** The plain-text body, as rendered for the text part of the email. */
  text: string;
  /** The framed HTML body, when the template has one. */
  html: string | null;
  /** True when no template document exists and the generic wording is what would send. */
  usedFallback: boolean;
  /** Every merge field the template names, in first-seen order. */
  fields: MergeFieldStatus[];
}
/** Merge fields the send pipeline fills for every recipient, so the operator is never asked for them. */
const AUTOMATIC_FIELDS: ReadonlySet<string> = new Set(['business', 'Business', 'businessLabel', 'recipientUid', 'notificationKey']);
const TOKEN_RE = /\{\{\{?\s*([A-Za-z_][\w.]*)\s*\}?\}\}/g;
/** The merge-field names a set of templates reference, first-seen order, no repeats. Block helpers (`{{#if}}`) are not fields. */
export function mergeFieldNames(...templates: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of templates) {
    if (!t) continue;
    for (const m of t.matchAll(TOKEN_RE)) {
      const name = m[1]!;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}
function isFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}
/** Classifies each named field against the blast's own `data`. Pure. */
export function classifyFields(names: string[], data: Record<string, unknown>): MergeFieldStatus[] {
  return names.map((name) => ({
    name,
    source: AUTOMATIC_FIELDS.has(name) ? 'automatic' : isFilled(data[name]) ? 'provided' : 'missing',
  }));
}
export async function previewMarketingCopy(
  key: string,
  data: Record<string, unknown>,
): Promise<MarketingCopyPreview> {
  let def: NotificationDef;
  try {
    def = getNotificationDef(key);
  } catch {
    throw new HttpsError('invalid-argument', `Unknown campaign ${key}.`);
  }
  const businessName = await loadBusinessName('previewMarketingBlastCopy');
  const renderData = { ...data, ...businessTokens(businessName), businessLabel: businessTokens(businessName).business };
  let parts: { subjectTemplate: string; bodyTemplate: string; htmlTemplate?: string };
  let usedFallback = false;
  const tpl = await loadEmailTemplate(key);
  if (tpl) {
    try {
      parts = sendPartsFor(tpl);
    } catch (err) {
      throw new HttpsError(
        'failed-precondition',
        `The template for ${def.label} is damaged: ${err instanceof Error ? err.message : 'unreadable'}. Re-save it in Template Bank.`,
      );
    }
  } else {
    const generic = fallbackEmail(def, businessName);
    parts = { subjectTemplate: generic.subject, bodyTemplate: generic.body };
    usedFallback = true;
  }
  const rendered = renderEmailParts({ ...parts, data: renderData });
  const names = mergeFieldNames(parts.subjectTemplate, parts.bodyTemplate, parts.htmlTemplate);
  return {
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html ?? null,
    usedFallback,
    fields: classifyFields(names, data),
  };
}
