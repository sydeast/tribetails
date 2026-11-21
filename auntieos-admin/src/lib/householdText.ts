import { cutWhole } from './cutText';
import { type VisitNoticeReach } from './visitNotice';

/**
 * #2408, operator ruling 2026-11-14: a household's text message stays short and
 * links to the full message in MyTribe. An approved Text draft is texted as a
 * short line followed by "More in MyTribe:" and a link to the message's own
 * entry on the household's notifications list, where it reads whole.
 *
 * This is what the confirm shows before the send, so the operator approves the
 * text the household will get and not the draft it was cut from. The same rule
 * as the server's `householdSms` (`notifications/templateParsers.ts`), which is
 * the one that decides what is sent.
 *
 * #2316: that is for a household with a MyTribe account. One with none is
 * texted the whole message (`householdWholeTextParts`, below).
 */

/** Where MyTribe lives. The server's `PORTAL_URL`. */
export const MYTRIBE_URL = 'https://kinfolk.tribetails.com';
/** The longest message a household text carries before it is cut. */
export const HOUSEHOLD_TEXT_LINE_MAX = 200;
/** What comes before the link. */
export const HOUSEHOLD_TEXT_LINK_LABEL = 'More in MyTribe:';
/** The longest unfinished word the cut steps back over. */
const WORD_BACKOFF = 30;

export interface HouseholdTextPreview {
  /** The message as texted, before the link. */
  line: string;
  /** The message was longer than the short line, so the rest is only in MyTribe. */
  cut: boolean;
  /** "More in MyTribe:" and a link follow the line. False when the message carries its own MyTribe link and fits. */
  linkAdded: boolean;
}

/** `text` cut to at most `max` at the end of a word. A web address the cut landed inside is dropped whole. */
function cutAtWord(text: string, max: number): string {
  const head = cutWhole(text, max);
  if (head.length === text.length || text.charAt(head.length) === ' ') return head.trimEnd();
  const lastSpace = head.lastIndexOf(' ');
  if (lastSpace <= 0) return head;
  const unfinished = head.slice(lastSpace + 1);
  const isAddress = /:\/\/|^www\./i.test(unfinished);
  return isAddress || unfinished.length <= WORD_BACKOFF ? head.slice(0, lastSpace).trimEnd() : head;
}

/** The text a household is sent for these words. PURE. */
export function householdTextPreview(body: string): HouseholdTextPreview {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat === '') return { line: '', cut: false, linkAdded: false };
  const longest = HOUSEHOLD_TEXT_LINE_MAX + 1 + `${HOUSEHOLD_TEXT_LINK_LABEL} ${MYTRIBE_URL}/notifications`.length;
  if (flat.includes(MYTRIBE_URL) && flat.length <= longest) return { line: flat, cut: false, linkAdded: false };
  const words = flat
    .split(' ')
    .filter((w) => !w.includes(MYTRIBE_URL))
    .join(' ');
  const cut = words.length > HOUSEHOLD_TEXT_LINE_MAX;
  return { line: cut ? `${cutAtWord(words, HOUSEHOLD_TEXT_LINE_MAX - 3)}...` : words, cut, linkAdded: true };
}

/** The preview as one line for a confirm: the text, then where its link goes. PURE. */
export function householdTextPreviewLine(body: string): string {
  const p = householdTextPreview(body);
  return p.linkAdded ? `${p.line} ${HOUSEHOLD_TEXT_LINK_LABEL} (link)` : p.line;
}
/**
 * #2316, operator ruling 2026-11-20: a household with no MyTribe account has
 * no notifications list for a link to open, so it is texted the WHOLE message
 * instead, as several texts when one cannot carry it. The server decides who
 * that is with `resolveKinfolkUid` (`sendGeneratedDraft`), which also reads the
 * household's member records and can say "nobody" for a household whose
 * `kinfolk.uid` is filled in. The roster cannot see that, so the confirm asks
 * the server the same question (`previewVisitNotification` without a key,
 * whose `household_has_no_portal_account` is exactly a null
 * `resolveKinfolkUid`, checked before anything else).
 */
export type HouseholdTextAccount = 'checking' | 'account' | 'no_account' | 'unknown';
/** The longest body one text carries. The server's `SMS_BODY_MAX` (Twilio refuses more). */
export const SMS_BODY_MAX = 1600;
/** The server's answer as an account state. PURE. */
export function householdTextAccountOf(reach: VisitNoticeReach): HouseholdTextAccount {
  if (reach.status !== 'ready') return reach.status;
  return reach.reason === 'household_has_no_portal_account' ? 'no_account' : 'account';
}
/**
 * The whole message as the texts it goes as, for a household with no MyTribe
 * account. PURE. The same split as the server's `householdWholeSmsParts`:
 * trimmed, line breaks kept, no link, and a message over [max] split at the
 * last space or line break when one is in the last fifth, else where it fits.
 */
export function householdWholeTextParts(body: string, max: number = SMS_BODY_MAX): string[] {
  const parts: string[] = [];
  let rest = body.trim();
  while (rest.length > max) {
    const head = cutWhole(rest, max);
    const breakAt = Math.max(head.lastIndexOf(' '), head.lastIndexOf('\n'));
    const part = breakAt > max * 0.8 ? head.slice(0, breakAt) : head;
    parts.push(part.trimEnd());
    rest = rest.slice(part.length).trimStart();
  }
  if (rest !== '') parts.push(rest);
  return parts;
}
/** What one household is texted, once its account is known. */
export type HouseholdTextAsSent =
  | { kind: 'checking' }
  | { kind: 'unknown' }
  /** The short line and "More in MyTribe: (link)". */
  | { kind: 'short'; line: string }
  /** The whole message, one entry per text. */
  | { kind: 'whole'; parts: string[] };
/** What this household is texted for these words. PURE. */
export function householdTextAsSent(body: string, account: HouseholdTextAccount): HouseholdTextAsSent {
  if (account === 'checking' || account === 'unknown') return { kind: account };
  if (account === 'no_account') return { kind: 'whole', parts: householdWholeTextParts(body) };
  return { kind: 'short', line: householdTextPreviewLine(body) };
}
/** The confirm's Channel line for a Text. Says short or whole only once the server has answered. PURE. */
export function householdTextChannelLine(account: HouseholdTextAccount): string {
  if (account === 'account') return 'Text, kept short, with a link to MyTribe';
  if (account === 'no_account') return 'Text, the whole message, because they have no MyTribe account';
  return 'Text';
}
