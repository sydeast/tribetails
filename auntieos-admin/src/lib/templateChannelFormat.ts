/**
 * #1935: the words and the small rules the template editor's Text message and
 * Push notification tabs share. Pure, so the sentences are tested as strings
 * and the Android and desktop editors can be held to the same ones.
 */

/** The three things a template can send, in the order the editor shows them. */
export type TemplateChannel = 'email' | 'sms' | 'push';
export type WordingChannel = Exclude<TemplateChannel, 'email'>;

export const TEMPLATE_CHANNELS: readonly TemplateChannel[] = ['email', 'sms', 'push'];

/** What each channel is called on screen. Never the stored key. */
export const CHANNEL_LABEL: Readonly<Record<TemplateChannel, string>> = {
  email: 'Email',
  sms: 'Text message',
  push: 'Push notification',
};

/** The same names mid-sentence. */
const CHANNEL_NOUN: Readonly<Record<WordingChannel, string>> = {
  sms: 'text message',
  push: 'push notification',
};

export const addChannelLabel = (channel: WordingChannel): string => `Add ${CHANNEL_NOUN[channel]}`;
export const saveChannelLabel = (channel: WordingChannel): string => `Save ${CHANNEL_NOUN[channel]}`;
export const channelSavedNotice = (channel: WordingChannel): string => `${CHANNEL_LABEL[channel]} saved.`;

/**
 * Why a channel has no wording and none can be added. Two different facts: no
 * notification sends this template at all, or one does but not this way.
 */
export function channelUnavailableReason(channel: WordingChannel, notificationLabel: string | null): string {
  if (notificationLabel === null) {
    return `No notification sends this template, so it has no ${CHANNEL_NOUN[channel]}.`;
  }
  return channel === 'sms'
    ? 'This notification is not sent by text message.'
    : 'This notification is not sent as a push notification.';
}

/** A template that has not been saved yet has nothing to look up. */
export const SAVE_TEMPLATE_FIRST = 'Save this template first.';

/** `12 of 1600 characters`, counted the way the server counts: trimmed. */
export function characterCount(value: string, max: number): string {
  return `${value.trim().length} of ${max} characters`;
}

/**
 * The GSM-7 alphabet a phone network carries at 160 characters a text. The
 * extension set is still GSM-7 but each of its characters takes two places.
 * Anything outside both (an emoji, a curly quote, most accented letters) turns
 * the whole message into the 70-character alphabet.
 */
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENDED = '^{}\\[~]|€\f';

export interface SmsSegments {
  /** How many texts the phone network splits this into. 0 when it is empty. */
  segments: number;
  /** True when a character outside the plain alphabet makes each text shorter. */
  unicode: boolean;
}

/**
 * How many texts a message goes out as, counted the way carriers split it:
 * 160 places in one text or 153 each when split, and 70 or 67 once any
 * character outside the plain alphabet is in it. Counted on the wording as
 * typed (trimmed, like the server's limit), so a {{field}} counts as its own
 * letters; what fills it in at send can make the real text longer. The
 * Android and desktop editors carry the same count (`smsSegments` there).
 */
export function smsSegments(text: string): SmsSegments {
  const value = text.trim();
  if (value.length === 0) return { segments: 0, unicode: false };
  let places = 0;
  for (const ch of value) {
    if (GSM7_BASIC.includes(ch)) places += 1;
    else if (GSM7_EXTENDED.includes(ch)) places += 2;
    else {
      // UTF-16 code units, which is what the 70-character alphabet counts.
      const units = value.length;
      return { segments: units <= 70 ? 1 : Math.ceil(units / 67), unicode: true };
    }
  }
  return { segments: places <= 160 ? 1 : Math.ceil(places / 153), unicode: false };
}

/** The line under the text message box: how many texts it sends as, or null when empty. */
export function smsSegmentHint(text: string): string | null {
  const { segments, unicode } = smsSegments(text);
  if (segments === 0) return null;
  const count = segments === 1 ? 'Sends as 1 text.' : `Sends as ${segments} texts.`;
  return unicode ? `${count} An emoji or special character makes each text shorter.` : count;
}

/**
 * The two problems worth catching before a round trip, in the server's own
 * words (`functions/src/lib/templateChannelWording.ts#wordingIssue`). Fields,
 * brackets and the rest are the server's to judge.
 */
export function localWordingError(label: string, value: string, max: number): string | null {
  const length = value.trim().length;
  if (length === 0) return `${label} cannot be empty.`;
  if (length > max) return `${label} is ${length} characters. The limit is ${max}.`;
  return null;
}
