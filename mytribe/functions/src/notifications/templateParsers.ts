/**
 * Pure parsers for on-disk notification template files.
 * No I/O, no Firestore. Tested in isolation under functions vitest config.
 */
import Handlebars from 'handlebars';
import { cutWhole } from '../lib/cutText';

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

/**
 * Renders a stored template for a PLAIN-TEXT channel: a text message, a push
 * title or body, a push route (#2321). PURE.
 *
 * Handlebars escapes every `{{value}}` for a web page unless told otherwise:
 * an apostrophe becomes `&#x27;`, `&` becomes `&amp;`, `=` becomes `&#x3D;`.
 * A phone prints those codes as they are, so a Kin called O'Malley arrived as
 * `O&#x27;Malley`. Nothing here is a web page, so nothing is escaped, the same
 * as the email's subject and text part (`lib/email.ts`).
 *
 * NEVER USE THE RESULT AS HTML. It holds whatever was typed, `<` included. The
 * email's html part is rendered by `lib/email.ts`, which keeps the escaping.
 *
 * NO ENTITY IS DECODED HERE. A merge value reaches a sender as the text typed:
 * a stored message body (kept as entities since #2144) is turned back into
 * text once, where the notice is raised (`messagePreview`). Decoding again
 * here would turn a typed `&lt;` into `<`.
 *
 * It lives in this file, which both senders already load, because a module of
 * its own would be one more on every function's cold start
 * (`test/coldStartImportGraph.test.ts`).
 */
export function renderPlainText(template: string, data: Record<string, unknown>): string {
  return stripUnresolvedTokens(Handlebars.compile(template, { noEscape: true })(data));
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
/** The query key the notifications list reads the entry to show from. */
export const HOUSEHOLD_NOTICE_ENTRY_PARAM = 'entry';
/**
 * The notifications list at one entry, or the plain list when no entry is
 * named. The id is percent-encoded, so it can never add a path part, a second
 * query key or another site to the route. PURE.
 */
export function householdNoticeEntryRoute(notificationId: string): string {
  return notificationId
    ? `${HOUSEHOLD_NOTICE_ROUTE}?${HOUSEHOLD_NOTICE_ENTRY_PARAM}=${encodeURIComponent(notificationId)}`
    : HOUSEHOLD_NOTICE_ROUTE;
}
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
    : `${cutWhole(flat, HOUSEHOLD_SHORT_LINE_MAX - 1).trimEnd()}\u2026`;
}
/**
 * Whether `householdPushShelfLine` cuts this message. The same measure, on the
 * same flattened text: a message that only had its line breaks folded was not
 * cut. A household whose push was cut reads the rest on its notifications
 * list, so the push sender opens the list for it. PURE.
 */
export function householdPushLineIsCut(body: string): boolean {
  return body.replace(/\s+/g, ' ').trim().length > HOUSEHOLD_SHORT_LINE_MAX;
}
/** The longest unfinished word the cut steps back over, so one long run of letters is not all lost. */
const SHORT_LINE_WORD_BACKOFF = 30;
/**
 * `text` cut to at most `max` characters at the end of a word. A word the cut
 * landed inside is dropped, and a web address it landed inside is always
 * dropped, however long: half an address reads as a link and opens nothing. PURE.
 */
function cutAtWord(text: string, max: number): string {
  const head = cutWhole(text, max);
  if (head.length === text.length || text.charAt(head.length) === ' ') return head.trimEnd();
  const lastSpace = head.lastIndexOf(' ');
  if (lastSpace <= 0) return head;
  const unfinished = head.slice(lastSpace + 1);
  const isAddress = /:\/\/|^www\./i.test(unfinished);
  return isAddress || unfinished.length <= SHORT_LINE_WORD_BACKOFF ? head.slice(0, lastSpace).trimEnd() : head;
}
/** What comes before the link a text message did not already carry. */
export const HOUSEHOLD_SMS_LINK_LABEL = 'More in MyTribe:';
/** The longest text message a household is sent, link included. */
export function householdSmsMax(portalUrl: string, route: string = HOUSEHOLD_NOTICE_ROUTE): number {
  return HOUSEHOLD_SHORT_LINE_MAX + 1 + householdSmsLink(portalUrl, route).length;
}
function householdSmsLink(portalUrl: string, route: string): string {
  return `${HOUSEHOLD_SMS_LINK_LABEL} ${portalUrl}${route}`;
}
/** A household's text message as sent, and whether its message was cut to fit. */
export interface HouseholdSms {
  text: string;
  /** The message was longer than the short line, so its rest is only in MyTribe (#2371). */
  cut: boolean;
}
/**
 * A household's text message, as sent: short, and always with a link into
 * MyTribe. PURE.
 *
 *   - A message that already links to MyTribe and fits is sent as written (the
 *     confirmation's "Every date: {{portalUrl}}").
 *   - Any other message is cut to `HOUSEHOLD_SHORT_LINE_MAX` and the link is
 *     put after it. A MyTribe link is taken out first, and the cut steps back
 *     to the end of a word, so the message never ends in half an address (the
 *     household's own, or one typed into a note) or half a character.
 *
 * `route` is where the link opens: the notice's own entry on the notifications
 * list when the sender knows it (#2371), so a cut message is read whole there,
 * else the list.
 *
 * The cut ends in three plain dots, not the ellipsis character: one character
 * outside the basic text-message alphabet makes the carrier send the whole
 * message in the costlier 70-character encoding.
 */
export function householdSms(rendered: string, portalUrl: string, route: string = HOUSEHOLD_NOTICE_ROUTE): HouseholdSms {
  const flat = rendered.replace(/\s+/g, ' ').trim();
  // Nothing rendered: not this function's to dress up as a message.
  if (flat === '') return { text: flat, cut: false };
  if (flat.includes(portalUrl) && flat.length <= householdSmsMax(portalUrl, route)) return { text: flat, cut: false };
  const words = flat.split(' ').filter((w) => !w.includes(portalUrl)).join(' ');
  const cut = words.length > HOUSEHOLD_SHORT_LINE_MAX;
  const line = cut ? `${cutAtWord(words, HOUSEHOLD_SHORT_LINE_MAX - 3)}...` : words;
  return { text: `${line} ${householdSmsLink(portalUrl, route)}`, cut };
}
/** `householdSms`'s text alone. PURE. */
export function householdSmsText(rendered: string, portalUrl: string, route: string = HOUSEHOLD_NOTICE_ROUTE): string {
  return householdSms(rendered, portalUrl, route).text;
}
