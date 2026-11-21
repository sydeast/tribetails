/**
 * The rules for a template's text-message and push wording (#1935).
 *
 * Until #1935 the only door into `smsTemplates` and `pushTemplates` was the
 * importer, so an operator could neither read nor change what a notification
 * says by text or by push. `admin/templateChannels.ts` is the authoring door;
 * this module is the part of it that touches no database, so every rule can be
 * tested against plain strings.
 *
 * Two questions are answered here:
 *
 *  1. WHICH wording does a template have? Text and push are not looked up by
 *     the template an operator is editing. The senders read
 *     `def.templates.sms` / `def.templates.push` off the notification's catalog
 *     row (`notifications/senders/smsChannel.ts`, `pushChannel.ts`) and never
 *     consult a binding. So a template has text or push wording only when a
 *     catalog row's EMAIL template is that template (or, for a template the
 *     operator made, when one live Template Routing override sends it as that
 *     row's email; `admin/templateChannels.ts` resolves that) and the row
 *     really sends that channel. The catalog opens all three channels on every row when
 *     it loads (`normalizeAllChannels` in notifications/catalog.ts), so in
 *     practice that is every catalog notification except the ones delivered
 *     outside the dispatcher. A template the operator made themselves, an
 *     invite or a recovery email has none, and offering to add one would
 *     store words nothing ever sends.
 *
 *  2. Is this wording SENDABLE? Empty, too long for the provider, a field the
 *     notification does not fill, or markup Handlebars would throw on at send.
 *
 * Every complaint is a sentence for the operator, keyed by the field it
 * belongs to, because the three clients draw it beside that field.
 */
import { scanTemplate } from './templateValidation';
import { NOTIFICATION_CATALOG } from '../notifications/catalog';
import { TEMPLATE_FIELDS } from '../notifications/enrichTemplateData';
import type { NotificationDef } from '../notifications/types';

/**
 * Twilio refuses a message body over 1600 characters (error 21617), and
 * `smsChannel` sends the rendered text as one body with no splitting of its
 * own. The cap is on the wording as typed; a filled-in field can still push a
 * text near the cap over it, which is why the editor shows the count.
 */
export const SMS_TEXT_MAX = 1600;

/**
 * FCM refuses a message whose whole payload is over 4096 bytes, and
 * `pushChannel` sends title, body and a small data map in one message. 100 and
 * 500 characters keep the worst case (four bytes a character, plus the filled
 * fields and the data map) under that.
 */
export const PUSH_TITLE_MAX = 100;
export const PUSH_BODY_MAX = 500;

/** The fields a save can be refused on. The clients key their error text by these. */
export type WordingField = 'smsText' | 'pushTitle' | 'pushBody';

export type WordingErrors = Partial<Record<WordingField, string>>;

/** What a template's notification sends besides email. */
export interface ChannelSupport {
  /** The catalog row whose email template this is, or null when there is none. */
  def: NotificationDef | null;
  /** The `smsTemplates` document id the sender reads, or null when no text is sent. */
  smsId: string | null;
  /** The `pushTemplates` document id the sender reads, or null when no push is sent. */
  pushId: string | null;
  /** The `{{field}}` names the notification fills in, sorted. */
  fields: string[];
}

/**
 * Finds the notification that sends `templateId` as its email, and which other
 * channels that notification really sends.
 *
 * `external` rows are delivered outside the dispatcher (the password reset),
 * which never reaches the text or push senders, so they support neither.
 */
export function channelSupportFor(templateId: string): ChannelSupport {
  return supportForDef(
    Object.values(NOTIFICATION_CATALOG).find((d) => d.templates.email === templateId) ?? null,
  );
}

/**
 * The same answer for the notification [catalogKey], reached through a
 * Template Routing override rather than the catalog's own email. Null when the
 * key is not a catalog notification.
 */
export function channelSupportForKey(catalogKey: string): ChannelSupport | null {
  const def = Object.hasOwn(NOTIFICATION_CATALOG, catalogKey) ? NOTIFICATION_CATALOG[catalogKey]! : null;
  return def ? supportForDef(def) : null;
}

function supportForDef(def: NotificationDef | null): ChannelSupport {
  if (!def || def.external === true) return { def, smsId: null, pushId: null, fields: [] };
  const idFor = (channel: 'sms' | 'push'): string | null =>
    def.allowedChannels.includes(channel) ? (def.templates[channel] ?? null) : null;
  const fields = Object.hasOwn(TEMPLATE_FIELDS, def.key) ? [...TEMPLATE_FIELDS[def.key]!].sort() : [];
  return { def, smsId: idFor('sms'), pushId: idFor('push'), fields };
}

/**
 * Reads the fields out of one piece of wording by parsing it the way the
 * sender will, so "it saved" and "it sends" cannot disagree. The scan itself
 * lives in `templateValidation.ts` (#2251), where the email door and the
 * importer run it too.
 */
export const scanFields = scanTemplate;

/** `{{a}}, {{b}} and {{c}}`, for the sentence that lists what can be used. */
function fieldList(fields: readonly string[]): string {
  return fields.map((f) => `{{${f}}}`).join(', ');
}

export interface WordingCheck {
  /** What the field is called on screen, capitalised: "Text message", "Title", "Message". */
  label: string;
  value: string;
  max: number;
  /** The fields the notification fills in. */
  allowed: readonly string[];
  /**
   * The copy stored today. A field it already uses stays usable even when the
   * notification's list no longer names it: emitters keep sending some retired
   * fields (`bookingDate` on a confirmation) so that wording imported earlier
   * still renders, and refusing them would block a spelling fix on that wording.
   */
  stored?: string | null;
}

/** The complaint about one field of wording, or null when it can be saved. */
export function wordingIssue(check: WordingCheck): string | null {
  const value = check.value.trim();
  if (value.length === 0) return `${check.label} cannot be empty.`;
  if (value.length > check.max) {
    return `${check.label} is ${value.length} characters. The limit is ${check.max}.`;
  }
  const scan = scanFields(value);
  if (scan.problem) return scan.problem;
  const grandfathered = check.stored ? scanFields(check.stored).fields : [];
  const unknown = scan.fields.filter((f) => !check.allowed.includes(f) && !grandfathered.includes(f));
  if (unknown.length > 0) {
    const first = `{{${unknown[0]}}}`;
    return check.allowed.length > 0
      ? `${first} is not a field this notification fills in. You can use ${fieldList(check.allowed)}.`
      : `${first} is not a field this notification fills in. It has no fields to use.`;
  }
  return null;
}

/** Every complaint about a text message, keyed by field. Empty means it can be saved. */
export function smsWordingErrors(
  text: string,
  allowed: readonly string[],
  stored?: string | null,
): WordingErrors {
  const issue = wordingIssue({ label: 'Text message', value: text, max: SMS_TEXT_MAX, allowed, stored });
  return issue ? { smsText: issue } : {};
}

/** Every complaint about a push notification, keyed by field. Empty means it can be saved. */
export function pushWordingErrors(
  wording: { title: string; body: string },
  allowed: readonly string[],
  stored?: { title?: string | null; body?: string | null } | null,
): WordingErrors {
  const errors: WordingErrors = {};
  const title = wordingIssue({
    label: 'Title',
    value: wording.title,
    max: PUSH_TITLE_MAX,
    allowed,
    stored: stored?.title,
  });
  if (title) errors.pushTitle = title;
  const body = wordingIssue({
    label: 'Message',
    value: wording.body,
    max: PUSH_BODY_MAX,
    allowed,
    stored: stored?.body,
  });
  if (body) errors.pushBody = body;
  return errors;
}
