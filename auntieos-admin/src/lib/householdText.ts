import { cutWhole } from './cutText';

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
