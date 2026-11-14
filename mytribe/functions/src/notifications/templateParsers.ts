/**
 * Pure parsers for on-disk notification template files.
 * No I/O, no Firestore. Tested in isolation under functions vitest config.
 */

export interface EmailTxtParsed {
  subject: string;
  body: string;
}

export function parseEmailTxt(raw: string): EmailTxtParsed {
  const firstNewline = raw.indexOf('\n');
  const firstLine = firstNewline === -1 ? raw : raw.slice(0, firstNewline);
  if (!firstLine.startsWith('Subject: ')) {
    throw new Error(`parseEmailTxt: first line must start with "Subject: ", got: ${JSON.stringify(firstLine)}`);
  }
  const subject = firstLine.slice('Subject: '.length).trim();
  const sepIdx = raw.indexOf('\n\n');
  if (sepIdx === -1) {
    throw new Error('parseEmailTxt: missing "\\n\\n" separator, body is empty');
  }
  const body = raw.slice(sepIdx + 2);
  if (body.trim().length === 0) {
    throw new Error('parseEmailTxt: body is empty (whitespace only after separator)');
  }
  return { subject, body };
}

/**
 * Final safety net applied to ALREADY-RENDERED template output. Handlebars
 * blanks a missing simple `{{x}}` to an empty string, but a malformed or
 * never-substituted token could otherwise survive; this strips any residual
 * `{{...}}` so a raw merge token can never reach a customer (fail-loud policy:
 * a blank reads better than a leaked `{{kinfolkName}}`). Pure string op.
 */
export function stripUnresolvedTokens(rendered: string): string {
  return rendered.replace(/\{\{[^}]*\}\}/g, '');
}

export interface PushTxtParsed {
  title: string;
  body: string;
}

export function parsePushTxt(raw: string): PushTxtParsed {
  const trimmed = raw.trim();
  const periodIdx = trimmed.indexOf('.');
  if (periodIdx === -1) {
    throw new Error(`parsePushTxt: no period found in input: ${JSON.stringify(trimmed)}`);
  }
  const title = trimmed.slice(0, periodIdx).trim();
  const body = trimmed.slice(periodIdx + 1).trim();
  if (body.length === 0) {
    throw new Error('parsePushTxt: body is empty after first period');
  }
  return { title, body };
}

/**
 * #2093, UNTIL THE TEMPLATES ARE RE-IMPORTED. A quote with no Kin on it names
 * no Kin, and the repo's templates say so with `{{#if kinName}}`. Prod sends
 * the STORED templates, and the ones stored before this change put
 * `{{kinName}}` in a sentence unguarded ("accepted the quote for {{kinName}}'s
 * care"), which an empty name breaks ("for 's care"). So when a quote names no
 * Kin, the enricher also keeps the household's roster under this field, the
 * name those older templates were always given, and `kinForStoredTemplate`
 * hands it only to a template that has no guard. The card never reads it.
 */
export const QUOTE_HOUSEHOLD_KIN_FIELD = 'quoteHouseholdKinNames';

const KIN_TOKEN = /\{\{\{?\s*kinName\s*\}?\}\}/;
const KIN_GUARD = /\{\{\s*#if\s+kinName\s*\}\}/;

/**
 * The context one stored template renders with (see QUOTE_HOUSEHOLD_KIN_FIELD).
 * `texts` are that channel's template strings (subject, body, title...). A
 * template that guards on `{{#if kinName}}` gets the context as it is; one that
 * uses `{{kinName}}` with no guard gets the household's names, as before #2093.
 * PURE.
 */
export function kinForStoredTemplate(
  data: Record<string, unknown>,
  texts: ReadonlyArray<string | null | undefined>,
): Record<string, unknown> {
  const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const roster = text(data[QUOTE_HOUSEHOLD_KIN_FIELD]);
  if (roster === '' || text(data.kinName) !== '') return data;
  const all = texts.filter((t): t is string => typeof t === 'string');
  if (!all.some((t) => KIN_TOKEN.test(t)) || all.some((t) => KIN_GUARD.test(t))) return data;
  return { ...data, kinName: roster };
}

/**
 * #2280, operator ruling 2026-11-14: "sms and push notifications are to be kept
 * short with links to the full message in app/site". A HOUSEHOLD's text message
 * and push are a short line and a way in; the whole message is on their
 * notifications list in MyTribe (and in the email, the one default channel).
 *
 * WHY THIS IS DECIDED AT SEND TIME AND NOT ONLY IN THE TEMPLATE TEXT. How long
 * a message comes out depends on what is merged into it (the office's note runs
 * to 500 characters, a household can have many Kin), and prod sends the STORED
 * templates, which the operator writes and which change only on an import. The
 * senders apply the rule to what was actually rendered, so it holds for every
 * template, stored or new.
 *
 * Staff and business copies are not touched: the ruling is about households.
 */
/** Where a household reads the whole message: the notifications list in MyTribe. */
export const HOUSEHOLD_NOTICE_ROUTE = '/notifications';
/**
 * The longest line a household push or text message carries before it is cut.
 * The length `message.reply` already cuts its preview to (#2061).
 */
export const HOUSEHOLD_SHORT_LINE_MAX = 200;
/**
 * A household push's own line: the whole message when it is short, else its
 * opening and an ellipsis. PURE.
 */
export function householdPushShelfLine(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length <= HOUSEHOLD_SHORT_LINE_MAX
    ? flat
    : `${flat.slice(0, HOUSEHOLD_SHORT_LINE_MAX - 1).trimEnd()}\u2026`;
}
/** What comes before the link a text message did not already carry. */
export const HOUSEHOLD_SMS_LINK_LABEL = 'More in MyTribe:';
/** The longest text message a household is sent, link included. */
export function householdSmsMax(portalUrl: string): number {
  return HOUSEHOLD_SHORT_LINE_MAX + 1 + householdSmsLink(portalUrl).length;
}
function householdSmsLink(portalUrl: string): string {
  return `${HOUSEHOLD_SMS_LINK_LABEL} ${portalUrl}${HOUSEHOLD_NOTICE_ROUTE}`;
}
/**
 * A household's text message, as sent: short, and always with a link into
 * MyTribe. PURE.
 *
 *   - A message that already links to MyTribe and fits is sent as written (the
 *     confirmation's "Every date: {{portalUrl}}").
 *   - Any other message is cut to `HOUSEHOLD_SHORT_LINE_MAX` and the link to the
 *     notifications list is put after it. A link the cut would have broken is
 *     taken out first, so the message never ends in half an address.
 *
 * The cut ends in three plain dots, not the ellipsis character: one character
 * outside the basic text-message alphabet makes the carrier send the whole
 * message in the costlier 70-character encoding.
 */
export function householdSmsText(rendered: string, portalUrl: string): string {
  const flat = rendered.replace(/\s+/g, ' ').trim();
  // Nothing rendered: not this function's to dress up as a message.
  if (flat === '') return flat;
  if (flat.includes(portalUrl) && flat.length <= householdSmsMax(portalUrl)) return flat;
  const words = flat.split(' ').filter((w) => !w.includes(portalUrl)).join(' ');
  const line =
    words.length <= HOUSEHOLD_SHORT_LINE_MAX
      ? words
      : `${words.slice(0, HOUSEHOLD_SHORT_LINE_MAX - 3).trimEnd()}...`;
  return `${line} ${householdSmsLink(portalUrl)}`;
}
