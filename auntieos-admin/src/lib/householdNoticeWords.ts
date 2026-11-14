/**
 * #1816, #1838, #2027, #1841: what an admin action tells the household, said
 * truthfully BEFORE it (the confirm) and AFTER it (the toast).
 *
 * The walk found four actions that said nothing true: a KinTale send promised
 * "Kinfolk will hear from you soon" with household notices off; a cancel, a
 * move and a note sent email and said nothing; New visit sent nothing and said
 * nothing. #1805 and #2108 fixed the same gap for the three clock taps only
 * (`lib/visitNotice.ts`, which this leaves alone).
 *
 * BOTH HALVES COME FROM THE SERVER. The confirm asks `previewVisitNotification`
 * with the action's notification key: the dispatcher's own dry run, so it
 * names the person, the channels, and the reason in the order the send decides
 * it. The toast reads the `notice` the action's own callable returned (or the
 * record the KinTale trigger wrote), never a prediction. A server that predates
 * `notice` returns none, and then the toast says nothing about the household.
 *
 * Mirrored word for word in Android (`domain/HouseholdNoticeWords.kt`) and the
 * desktop console (`screens/HouseholdNoticeWords.kt`).
 */

/** The household notices an admin confirm can ask about. Server: `PREVIEW_NOTICE_KEYS`. */
export type HouseholdNoticeKey =
  | 'kintale.published'
  | 'kincare.booking.cancel'
  | 'kincare.changed'
  | 'kincare.note.auntie'
  | 'kincare.booking.confirm';

/** What happened to the household's copy, as every action's callable returns it. */
export interface HouseholdNotice {
  told: boolean;
  reason: string | null;
  name: string | null;
  channels: string[];
}

/** The confirm's state: still asking, no usable answer, or the server's answer. */
export type HouseholdNoticePreview =
  | { status: 'checking' }
  | { status: 'unknown' }
  | { status: 'ready'; willNotify: boolean; reason: string | null; name: string | null; channels: string[] };

const CHANNEL_WORDS: Readonly<Record<string, string>> = {
  email: 'an email',
  sms: 'a text',
  push: 'a phone notification',
};

/** "an email", "an email and a text", "an email, a text and a phone notification". */
export function channelWords(channels: readonly string[]): string {
  const words = channels.map((c) => CHANNEL_WORDS[c]).filter((w): w is string => w !== undefined);
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]!}`;
}

/** The name to use: the server's, else the one the screen holds, else "the household". */
function who(serverName: string | null | undefined, fallback: string): string {
  const named = (serverName ?? '').trim();
  if (named !== '') return named;
  const held = fallback.trim();
  return held !== '' ? held : 'the household';
}

/** "the household" opens a sentence as "The household". */
function opening(name: string): string {
  return name === '' ? name : name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Why nobody is (or was) told, as the clause after "Nobody will be told:".
 * An Auntie never sees Settings (ruling 2026-11-13, #2185), so her switch line
 * names who can change it.
 */
function whyNot(reason: string | null, name: string, auntie: boolean): string | null {
  switch (reason) {
    case 'household_has_no_portal_account':
      return `${name} has no portal account`;
    case 'household_prefs_suppressed':
      return `this notice is turned off for ${name}`;
    case 'household_notices_off':
      return auntie ? 'the owner has notices to households turned off' : 'notices to households are off in Settings';
    case 'session_has_no_routing_ids':
      return 'this visit is not linked to a booking';
    default:
      return null;
  }
}

/**
 * The confirm's line about the household, future tense, or `null` when it
 * should say nothing (the server could not be asked).
 *
 * @param household the household name the screen already shows, used only
 *        when the server names nobody.
 * @param auntie an Auntie is signed in (`useIsAuntie`).
 */
export function householdNoticeConfirmLine(
  preview: HouseholdNoticePreview,
  household: string,
  auntie = false,
): string | null {
  if (preview.status === 'checking') return 'Checking who will be told.';
  if (preview.status === 'unknown') return null;
  const name = who(preview.name, household);
  if (preview.willNotify) {
    const how = channelWords(preview.channels);
    return how === ''
      ? `${opening(name)} will see it in their notifications list only.`
      : `${opening(name)} will get ${how}.`;
  }
  if (preview.reason === 'not_a_household_notice') return `No notice goes to ${name} for this.`;
  const why = whyNot(preview.reason, name, auntie);
  return why === null ? null : `Nobody will be told: ${why}.`;
}

/**
 * The toast's line about the household, past tense, from what the server did.
 * `''` when the server said nothing (an older server, or no answer at all):
 * the toast then claims nothing about the household either way.
 */
export function householdNoticeResultLine(
  notice: HouseholdNotice | null | undefined,
  household: string,
  auntie = false,
): string {
  if (notice === null || notice === undefined) return '';
  const name = who(notice.name, household);
  if (notice.told) {
    const how = channelWords(notice.channels);
    return how === ''
      ? `${opening(name)} was told in their notifications list only.`
      : `${opening(name)} was sent ${how}.`;
  }
  switch (notice.reason) {
    case 'not_a_household_notice':
      return `No notice went to ${name} for this.`;
    case 'already_notified':
      return `${opening(name)} was already told about this.`;
    case 'not_requested':
      return 'No confirmation was sent.';
    case 'dispatch_failed':
      return `The notice to ${name} could not be sent.`;
    default: {
      const why = whyNot(notice.reason, name, auntie);
      return why === null ? 'Nobody was told.' : `Nobody was told: ${why}.`;
    }
  }
}

/** "Done." + " " + the household line, without a stray space when the line is empty. */
export function withHouseholdLine(sentence: string, line: string): string {
  return line === '' ? sentence : `${sentence} ${line}`;
}

/** PURE. A callable's `notice` field as a {@link HouseholdNotice}, or null when it carries none. */
export function householdNoticeOf(raw: unknown): HouseholdNotice | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['told'] !== 'boolean') return null;
  return {
    told: r['told'],
    reason: typeof r['reason'] === 'string' && r['reason'] !== '' ? r['reason'] : null,
    name: typeof r['name'] === 'string' && r['name'].trim() !== '' ? r['name'] : null,
    channels: Array.isArray(r['channels']) ? r['channels'].filter((c): c is string => typeof c === 'string') : [],
  };
}
