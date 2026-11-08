import {
  NOTIFICATION_CHANNELS,
  type NotificationCatalogEntry,
  type NotificationChannel,
  type NotifStream,
} from '../api/myNotifications';
import type { BusinessAdminRoster } from '../api/businessAdmins';
import { alwaysEnabledFor } from './notificationGateEdit';
import { displayTitle } from './myNotificationsFormat';
import { humanizeKey } from './notificationsFeed';

/**
 * Turns a catalog row into the sentences the notification gate shows (#396).
 *
 * The server already sends finished English for who-receives-it and what-fires-
 * it (see mytribe/functions/src/notifications/provenance.ts), on purpose, so
 * this file never maps an enum to prose — the web and Android clients would
 * drift the moment either edited its own copy. What lives here is the WEB-side
 * framing: the risk badges, the "not recorded" fallbacks, and the honest
 * always-on wording below.
 */

/** A short badge on a gate row: something the operator should notice about it. */
export interface RowBadge {
  /** The word on the badge. */
  label: string;
  /** The sentence explaining it, shown as a title and to screen readers. */
  detail: string;
  tone: 'warn' | 'info';
}

/**
 * THE ONE VOCABULARY FOR THE CATALOG'S ADVISORY FLAG (#451).
 *
 * Three surfaces used to have three words for "this one is important": the
 * gate said "Always on", the Android prefs screen showed a "Required" lock
 * pill, and the kinfolk portal said "Always on. Required by Tribe Tails." All
 * three implied a guarantee, and they sat at different layers. These two
 * constants are the admin-side half of the settlement: wherever the catalog's
 * `alwaysEnabled` flag is shown to anyone, it is shown with these words and no
 * lock icon, because the flag is advice and not a lock. The recipient-side half
 * ("Set by your business", "Set by Tribe Tails Pet Care") lives in
 * `myNotificationsFormat.ts` and the portal, and it deliberately names WHO
 * decides rather than promising the notification will keep arriving.
 */
export const MEANT_TO_STAY_ON = 'Meant to stay on';
export const OFF_AND_MEANT_TO_STAY_ON = 'Off, and meant to stay on';
/**
 * WHY THIS EXISTS, AND WHY IT IS NOT THE WORDS "ALWAYS ON".
 *
 * The gate used to caption an `alwaysEnabled` row "Always on". It is not. There
 * is no alwaysEnabled check anywhere in `resolveChannels`, and the save handler
 * dropped its enforcement in ruling #7 (2026-06-08) deliberately —
 * warn-but-allow-off, the operator stays in control of their own business
 * notifications. Fourteen catalog rows carry the flag, including the password
 * reset email, and every one of them can be switched off from this screen and
 * will then genuinely stop sending.
 *
 * So the caption was promising a protection the platform does not provide, on
 * the exact screen whose job is to tell the truth about what gets sent. #396
 * gave two ways out: enforce the flag in `resolveChannels`, or stop implying
 * it. Enforcing it would silently reverse a documented operator ruling and take
 * back control the operator asked for. Telling the truth costs nothing and
 * builds the warning #7 said the UI would show and which was never built.
 *
 * Hence: the flag renders as a RISK MARKER, not a lock. On a row still switched
 * on it reads as "meant to stay on"; on a row the operator has switched off it
 * escalates to a warning, because that is the state worth seeing from across
 * the room.
 */
export function alwaysOnBadge(
  entry: NotificationCatalogEntry,
  stream: NotifStream,
  enabled: boolean,
): RowBadge | null {
  if (!alwaysEnabledFor(entry, stream)) return null;
  if (!enabled) {
    return {
      label: OFF_AND_MEANT_TO_STAY_ON,
      detail:
        'The catalog marks this one too important to silence, and it is switched off anyway. '
        + 'Nothing in the sending code overrides you: while it is off, this notification is not sent to anyone.',
      tone: 'warn',
    };
  }
  return {
    label: MEANT_TO_STAY_ON,
    detail:
      'The catalog marks this one too important to silence. That is advice, not a lock: '
      + 'you can switch it off here, and it will stop sending.',
    tone: 'info',
  };
}

/** Every badge a row should carry, in the order they should read. */
export function rowBadges(
  entry: NotificationCatalogEntry,
  stream: NotifStream,
  enabled: boolean,
): RowBadge[] {
  const badges: RowBadge[] = [];
  const always = alwaysOnBadge(entry, stream, enabled);
  if (always) badges.push(always);

  if (entry.neverFires) {
    badges.push({
      label: 'Never fires',
      detail:
        'No code anywhere dispatches this notification, so nothing on this row changes what anyone receives. '
        + 'It is a catalog entry with templates and toggles and no trigger.',
      tone: 'warn',
    });
  }

  if (entry.external) {
    badges.push({
      label: 'Sent directly',
      detail:
        'Sent outside the notification system, so these switches control nothing. Its template still applies.',
      tone: 'warn',
    });
  }

  if (entry.marketingCategory) {
    badges.push({
      label: 'Marketing',
      detail:
        `Marketing class (${entry.marketingCategory}). It only sends to people who have opted in, `
        + 'and that opt-in is a legal gate you cannot override from here.',
      tone: 'info',
    });
  }

  return badges;
}

/**
 * Who this notification reaches, as sentences.
 *
 * `businessAdmins` rows get the roster size appended, because "every business
 * admin" is a different answer at three people than at fifteen and the operator
 * asking "could this leak" needs the number, not the category. A null count is
 * rendered as unreadable rather than as zero.
 */
export function recipientLines(
  entry: NotificationCatalogEntry,
  businessAdminCount: number | null,
): string[] {
  return entry.whoReceives.map((sentence) => {
    if (!sentence.includes('business admin')) return sentence;
    if (businessAdminCount === null) {
      // #1592: the roster is named, never its database path.
      return `${sentence} The roster could not be read just now, so the number is unknown.`;
    }
    if (businessAdminCount === 0) {
      return `${sentence} Nobody is on that roster right now, so sends fall back to the operator allowlist.`;
    }
    const people = businessAdminCount === 1 ? 'person' : 'people';
    return `${sentence} That is ${businessAdminCount} ${people} today.`;
  });
}

/**
 * True when this row's recipients include the business admin roster, and so
 * when the gate should offer to name them (issue #450).
 *
 * Reads the resolver fields rather than searching `whoReceives` for the words
 * "business admin". The sentences are server-authored prose meant for a human;
 * matching on them would make a reworded sentence silently stop offering the
 * roster, and `recipientResolver` is the field the dispatcher itself branches
 * on.
 */
export function reachesBusinessAdmins(entry: NotificationCatalogEntry): boolean {
  return entry.recipientResolver === 'businessAdmins' || entry.secondaryResolver === 'businessAdmins';
}

/**
 * One line per person on the roster: their name and anything about them the
 * operator would otherwise have to know already.
 *
 * No address per person (#1564). Operator ruling, 2026-11-05 docket: every
 * business email goes to the business contact email in business settings, so a
 * member's own email is not where their mail goes; `businessEmailLine` says
 * where it does.
 *
 * A uid with no `staff/{uid}` record says so and shows the uid. That member is
 * NOT dropped: they receive every business notification, and a list that hides
 * them under-reports the audience, which is the whole failure this panel exists
 * to end.
 */
export function businessAdminLines(roster: BusinessAdminRoster): string[] {
  return roster.members.map((member) => {
    const name = member.displayName ?? member.uid;
    const parts: string[] = [];
    if (!member.hasStaffRecord) parts.push(`no staff record for ${member.uid}`);
    if (member.defaultAssignee) parts.push('unassigned visits default to them');
    return parts.length > 0 ? `${name} (${parts.join('; ')})` : name;
  });
}
/**
 * Where this row's emails go (#1564): the business contact email, or, while
 * that is blank, nowhere.
 */
export function businessEmailLine(roster: Pick<BusinessAdminRoster, 'businessEmail'>): string {
  return roster.businessEmail !== ''
    ? `Emails go to the business email, ${roster.businessEmail}.`
    : 'Business emails have nowhere to go: the business email in Settings > Business is blank, so each one is skipped until it is filled.';
}
/**
 * The caveat above the list, when there is one.
 *
 * `operatorAllowlist` is the state where the stored roster is empty and sends
 * fall back to `AUNTIE_OPERATOR_UIDS`. The people below are still the ones who
 * would receive the next business notification, so the list is real, but the
 * operator should know the roster itself is empty.
 */
export function businessAdminSourceNote(roster: BusinessAdminRoster): string | null {
  if (roster.source !== 'operatorAllowlist') return null;
  // #1592: no database path and no function name in what the operator reads.
  return 'The business admin roster is empty, so these are the operator allowlist accounts '
    + 'the next business notification would fall back to.';
}

/** One "channel → template" line per channel the row can use. */
export interface TemplateLine {
  channel: NotificationChannel;
  /**
   * The template that renders this channel's body, in words (#1592: it was the
   * database path `emailTemplates/<id>`). The row's own template carries the
   * row's own name; any other template id reads as words.
   */
  name: string;
  /** True when the row does not offer this channel at all. */
  missing: boolean;
  /**
   * The catalog default this channel was moved off, when an operator has
   * retargeted it. Email only: it is the one channel `sendFromTemplate`
   * resolves through `notificationTemplateBindings`, which is also the only
   * retargeting this screen can do without a deploy. Saying "retargeted from X"
   * rather than silently showing the new id is what stops the row reading as
   * though the catalog default were still in play.
   */
  retargetedFrom?: string;
}

/** A template id as the operator reads it: the row's own name, or the id as words. */
export function templateName(id: string, entry: NotificationCatalogEntry): string {
  return id === entry.key ? displayTitle(entry) : humanizeKey(id) || 'a template';
}

export function templateLines(entry: NotificationCatalogEntry): TemplateLine[] {
  return NOTIFICATION_CHANNELS.filter((c) => entry.allowedChannels.includes(c)).map((channel) => {
    const id = entry.templates[channel];
    const retargetedFrom = channel === 'email' ? entry.emailTemplateRetargetedFrom : undefined;
    return {
      channel,
      name: id ? templateName(id, entry) : 'no template recorded',
      missing: !id,
      ...(retargetedFrom ? { retargetedFrom: templateName(retargetedFrom, entry) } : {}),
    };
  });
}

/**
 * A merge field key as words, for a key the server sent no label for (#1592):
 * `startTimeMs` reads "Start time", `nextVisit.date` "Next visit date",
 * `kinfolkId` "Kinfolk reference". The server's `mergeFieldLabels` win
 * whenever they are there; this is what an older server's rows read as.
 */
export function fieldWords(key: string): string {
  const words = key
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[._\-\s]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w !== '' && w !== 'ms' && w !== 'iso' && w !== 'list')
    .map((w) => (w === 'id' || w === 'uid' ? 'reference' : w === 'url' ? 'link' : w));
  const joined = words.join(' ');
  return joined === '' ? key : joined.charAt(0).toUpperCase() + joined.slice(1);
}
/**
 * Everything the body can carry, in words, deduped and sorted.
 *
 * Two lists become one on purpose. `mergeFields` is what the server hydrates and
 * a template author can already see; the emitters' `dataKeys` are the half that
 * lived only in source, and they are the half that matters for "are we leaking
 * info to the wrong ppl" — a template that prints one of these prints it to
 * whoever the recipient rule above resolved.
 *
 * #1592: the list printed the keys (`kinfolkId`, `startTimeMsList`). It now
 * says what each one is, in the server's words, or `fieldWords` when the
 * server sent none. Two keys that mean one thing ("Business", "business") are
 * one line.
 */
export function mergeFieldNames(entry: NotificationCatalogEntry): string[] {
  const keys = new Set<string>(entry.mergeFields);
  for (const emitter of entry.emitters) {
    for (const key of emitter.dataKeys) keys.add(key);
  }
  const labels = new Set<string>();
  for (const key of keys) labels.add(entry.mergeFieldLabels?.[key] ?? fieldWords(key));
  return [...labels].sort((a, b) => a.localeCompare(b));
}
/** True when any emitter admits its listed keys are not the whole bag. */
export function hasPartialDataNote(entry: NotificationCatalogEntry): boolean {
  return entry.emitters.some((e) => typeof e.dataNote === 'string' && e.dataNote !== '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery evidence
// ─────────────────────────────────────────────────────────────────────────────

/** How one channel attempt should read to a human. */
export interface DeliveryPhrase {
  label: string;
  detail: string;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
}

/**
 * The honest phrasing for a channel attempt.
 *
 * "Sent" is the strongest thing this data supports and it is deliberately not
 * called "Delivered". `notificationDispatch/{id}/channels/{channel}.status` goes
 * to 'sent' the moment a provider ACCEPTS the message — smtp2go queues the
 * email, Twilio queues the SMS, FCM enqueues the push. The engagement webhooks
 * that carry real delivered/bounced events match `external_messages` only and
 * never touch these subdocs, so a receipt for a catalog notification does not
 * exist anywhere in this system. A green "Delivered" here would be a guess
 * printed as a fact.
 */
/**
 * The channel senders' skip codes in words (#1592: the log printed
 * `recipient_no_phone`). The codes are the ones `senders/emailChannel.ts` and
 * `senders/smsChannel.ts` write, and `unknown` is what the trigger stamps when
 * a sender gave none. A code this does not know is split into words rather
 * than printed as a key.
 */
const SKIP_REASON_WORDS: Readonly<Record<string, string>> = {
  recipient_no_email: 'the recipient has no email address on file',
  recipient_no_phone: 'the recipient has no phone number on file',
  recipient_hard_bounced: 'an earlier email to this address bounced, so it is not mailed again',
  template_missing: 'there is no text message template for it',
  template_text_empty: 'its text message template is empty',
  unknown: 'the sender gave no reason',
};
export function skipReasonWords(code: string): string {
  return SKIP_REASON_WORDS[code] ?? fieldWords(code).toLowerCase();
}
/**
 * Who a delivery went to, as the log names them (#1592: it printed the uid).
 * The server's name, else the uid as it is: a recipient nobody answers to is
 * itself what the operator needs to see, and is never shown blank.
 */
export function deliveryRecipient(row: { recipientName: string | null; recipientUid: string }): string {
  return row.recipientName ?? (row.recipientUid || 'an unknown recipient');
}
/** The email channel's skip reason when `businessEmail` is blank (#1564). */
export const BUSINESS_EMAIL_UNSET = 'business_email_unset';
export function deliveryPhrase(status: string, skipReason: string | null, errorMessage: string | null): DeliveryPhrase {
  switch (status) {
    case 'sent':
      return {
        label: 'Handed to the provider',
        detail: 'The provider accepted it. No delivery receipt is recorded, so this is not proof it arrived.',
        tone: 'good',
      };
    case 'skipped':
      return {
        label: 'Skipped',
        detail: skipReason === BUSINESS_EMAIL_UNSET
          ? 'The business email in Settings > Business was blank, so this email had nowhere to go.'
          : skipReason
            ? `Not sent on this channel: ${skipReasonWords(skipReason)}.`
            : 'Not sendable on this channel; no reason was recorded.',
        tone: 'warn',
      };
    case 'failed':
      return {
        label: 'Failed',
        detail: errorMessage ? `The send failed: ${errorMessage}` : 'The send failed, with no message recorded.',
        tone: 'bad',
      };
    case 'pending':
      return {
        label: 'Waiting',
        detail: 'Queued for the channel sender, which has not run yet.',
        tone: 'neutral',
      };
    default:
      return {
        label: 'Unknown',
        detail: 'This channel record carries no status at all, which means its sender never ran.',
        tone: 'warn',
      };
  }
}
