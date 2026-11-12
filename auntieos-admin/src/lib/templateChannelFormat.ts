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
