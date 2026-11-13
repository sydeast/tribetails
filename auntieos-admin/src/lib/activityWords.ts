/**
 * What an Activity Log entry's description says, in the operator's words
 * (#1747).
 *
 * Four writers used to put a Firestore path in the description: approving a
 * Communicate draft wrote "Approved generated_drafts/<id> (<kinfolkId>)", and
 * the server's KinTale draft callables wrote "Sent draft generated_drafts/<id>
 * as KinTale <reportId> (<kinfolkId>)" and "Deleted draft generated_drafts/<id>
 * (<kinfolkId>)", and deleting an unsent KinTale wrote "Deleted unsent KinTale
 * draft kin_care_reports/<id> (<kinfolkId>)". The Activity Log shows a
 * description as written, so the operator read a collection path and two ids.
 *
 * The writers now write {@link ACTIVITY_WORDS}. The entries already stored are
 * evidence rows and are never rewritten; {@link activityDescriptionWords} reads
 * them as the same words at display time. The ids stay on the entry as its
 * target and payload, which is where the evidence log keeps them.
 *
 * Same sentences as Android (`ui/admin/ActivityLogScreen.kt`), the desktop
 * console (`screens/activity/ActivityLogScreen.kt`) and the server
 * (`mytribe/functions/src/admin/kinTaleDrafts.ts`).
 */
export const ACTIVITY_WORDS = {
  draftApproved: 'Approved an Auntie AI draft',
  kinTaleDraftSent: 'Sent a KinTale draft',
  kinTaleDraftDeleted: 'Deleted a KinTale draft',
  /** #1839: a look at a household stored before the server wrote it in words. */
  householdOpened: 'Opened a household',
} as const;

/** The stored shapes, in full: the path, any ids after it, the household in brackets. */
const STORED_SHAPES: readonly (readonly [RegExp, string])[] = [
  [/^Approved generated_drafts\/\S+(?: \([^)]*\))?$/, ACTIVITY_WORDS.draftApproved],
  [/^Sent draft generated_drafts\/\S+ as KinTale \S+(?: \([^)]*\))?$/, ACTIVITY_WORDS.kinTaleDraftSent],
  [/^Deleted draft generated_drafts\/\S+(?: \([^)]*\))?$/, ACTIVITY_WORDS.kinTaleDraftDeleted],
  [/^Deleted unsent KinTale draft kin_care_reports\/\S+(?: \([^)]*\))?$/, ACTIVITY_WORDS.kinTaleDraftDeleted],
];

/** Any other mention of a draft's path, for a writer this file does not know. */
const DRAFT_PATH = /(?:generated_drafts|kin_care_reports)\/[\w-]+/g;

/**
 * #1752: the other writers that put an id or a catalog key in the sentence.
 * The server now writes these words (`mytribe/functions/src/lib/activityWords.ts`);
 * a row stored before that reads as the same words here. One difference: an
 * old notification row names the notification by its key in words, because
 * the catalog label lives on the server.
 */
function humanizeKey(raw: string): string {
  const words = raw
    .trim()
    .split(/[._\-\s]+/)
    .filter((w) => w !== '')
    .join(' ')
    .toLowerCase();
  return words === '' ? '' : words.charAt(0).toUpperCase() + words.slice(1);
}
const lowerWords = (raw: string): string => humanizeKey(raw).toLowerCase();

const CHANNEL_WORDS: Record<string, string> = { email: 'email', sms: 'text message', push: 'push notification' };
const channelWords = (c: string): string => CHANNEL_WORDS[c.trim().toLowerCase()] ?? lowerWords(c);
function channelList(raw: string): string {
  const words = raw
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c !== '')
    .map(channelWords);
  if (words.length === 0) return '';
  if (words.length === 1) return ` by ${words[0]}`;
  return ` by ${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}
/** A stored notification key, or the id that stood in when the key was missing. */
function notificationQuoted(keyOrId: string): string {
  const k = keyOrId.trim();
  return k.includes('.') ? `"${humanizeKey(k)}"` : 'a notification';
}

const STATUS_WORDS: Record<string, string> = {
  DRAFT: 'draft',
  PENDING: 'requested',
  SCHEDULED: 'scheduled',
  ON_MY_WAY: 'on the way',
  ARRIVED: 'arrived',
  DEPARTED: 'departed',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};
const statusWords = (s: string): string => STATUS_WORDS[s.trim().toUpperCase()] ?? lowerWords(s);

const ACTION_WORDS: Record<string, { done: string; attempt: string }> = {
  APPROVE: { done: 'Approved the visit', attempt: 'approve the visit' },
  REJECT: { done: 'Declined the visit', attempt: 'decline the visit' },
  CANCEL: { done: 'Cancelled the visit', attempt: 'cancel the visit' },
  COMPLETE: { done: 'Completed the visit', attempt: 'complete the visit' },
  ON_MY_WAY: { done: 'Marked the visit on the way', attempt: 'mark the visit on the way' },
  ARRIVED: { done: 'Marked the arrival', attempt: 'mark the arrival' },
  DEPARTED: { done: 'Marked the departure', attempt: 'mark the departure' },
  UNDO_ARRIVAL: { done: 'Undid the arrival', attempt: 'undo the arrival' },
};
const done = (a: string): string => ACTION_WORDS[a]?.done ?? humanizeKey(a);
const attempt = (a: string): string => ACTION_WORDS[a]?.attempt ?? lowerWords(a);

const ARRIVAL_CHECK_WORDS: Record<string, string> = {
  within: 'within the household radius',
  outside: 'outside the household radius',
  unverified: 'location not verified',
  household_location_unknown: "the household's location is not set",
};
const PATTERN_WORDS: Record<string, string> = { individual: 'individual dates', weekly: 'weekly' };
const SESSION_FIELD_WORDS: Record<string, string> = {
  serviceType: 'service',
  notes: 'notes',
  serviceDurationMinutes: 'length',
  kinIds: 'kin',
  kinNames: 'kin',
};
function editedFields(raw: string): string {
  const words = [
    ...new Set(
      raw
        .split(',')
        .map((f) => f.trim())
        .filter((f) => f !== '')
        .map((f) => SESSION_FIELD_WORDS[f] ?? lowerWords(f.replace(/([a-z])([A-Z])/g, '$1 $2'))),
    ),
  ];
  return words.length === 0 ? 'Edited a visit' : `Edited a visit: ${words.join(', ')}`;
}

/**
 * The sentence for one visit step the web clock tap just took (#1797). Same
 * words as the server's `visitTransitionWords`
 * (`mytribe/functions/src/lib/activityWords.ts`); `activityWords.test.ts` pins
 * the two together. No session id: that stays in the entry's target.
 */
export function visitTransitionWords(action: string, from: string, to: string): string {
  return `${done(action.trim().toUpperCase())}: ${statusWords(from)} to ${statusWords(to)}`;
}
const ACTION = '(APPROVE|REJECT|CANCEL|COMPLETE|ON_MY_WAY|ARRIVED|DEPARTED|UNDO_ARRIVAL)';
const ACTION_ON_SESSION = `^${ACTION} on session \\S+: `;

/** Stored shape -> the words the server writes now. First match wins, so the specific shapes lead. */
const ID_SHAPES: readonly (readonly [RegExp, (m: RegExpExecArray) => string])[] = [
  [/^Notification (\S+) delivered via (\S+)$/, (m) => `Delivered ${notificationQuoted(m[1]!)} by ${channelWords(m[2]!)}`],
  [/^Notification (.+?) dispatched to (.*)$/, (m) => `Sent ${notificationQuoted(m[1]!)}${channelList(m[2]!)}`],
  [/^Notification (\S+) archived$/, (m) => `Archived ${notificationQuoted(m[1]!)}`],
  [
    /^Notification (\S+) restored to the active inbox$/,
    (m) => `Restored ${notificationQuoted(m[1]!)} to the notifications list`,
  ],
  [/^Notification (\S+) viewed$/, (m) => `Viewed ${notificationQuoted(m[1]!)}`],
  [/^Notification (\S+) marked unread$/, (m) => `Marked ${notificationQuoted(m[1]!)} unread`],
  [
    new RegExp(`${ACTION_ON_SESSION}(\\w+) -> (\\w+)$`),
    (m) => `${done(m[1]!)}: ${statusWords(m[2]!)} to ${statusWords(m[3]!)}`,
  ],
  [
    new RegExp(`${ACTION_ON_SESSION}already (\\w+), no write$`),
    (m) => `Did not ${attempt(m[1]!)}: the visit was already ${statusWords(m[2]!)}`,
  ],
  [new RegExp(`^${ACTION} refused: session '[^']*' not found$`), (m) => `Could not ${attempt(m[1]!)}: the visit was not found`],
  [
    new RegExp(`^${ACTION} refused: unreadable status on session '[^']*'$`),
    (m) => `Could not ${attempt(m[1]!)}: the visit's status could not be read`,
  ],
  [
    new RegExp(`^${ACTION} refused: illegal from (\\w+)$`),
    (m) => `Could not ${attempt(m[1]!)}: the visit is ${statusWords(m[2]!)}`,
  ],
  [/^COMPLETE refused: session '[^']*' has no (.+) recorded$/, (m) => `Could not complete the visit: no ${m[1]} recorded`],
  [
    /^COMPLETE refused: session '[^']*' arrival was recorded (\d+)m from the household \(radius (\d+)m\)$/,
    (m) => `Could not complete the visit: arrival was recorded ${m[1]}m from the household (radius ${m[2]}m)`,
  ],
  [new RegExp(`^${ACTION} refused: (.+)$`), (m) => `Could not ${attempt(m[1]!)}: ${m[2]}`],
  [
    /^Arrival location check on session \S+: (\S+)$/,
    (m) => `Arrival location check: ${ARRIVAL_CHECK_WORDS[m[1]!] ?? lowerWords(m[1]!)}`,
  ],
  [/^Account credit of (\d+) cents given to household \S+$/, (m) => `Gave $${(Number(m[1]) / 100).toFixed(2)} account credit`],
  [
    /^Admin created (\d+) visit\(s\) \(([^)]*)\) for \S+$/,
    (m) => {
      const n = Number(m[1]);
      const p = PATTERN_WORDS[m[2]!.trim()] ?? lowerWords(m[2]!);
      return `Created ${n} ${n === 1 ? 'visit' : 'visits'}${p === '' ? '' : ` (${p})`}`;
    },
  ],
  [
    /^Assigned orphan KinTale \S+ to kinfolk (.*) \([^)]*\)$/,
    (m) =>
      m[1]!.trim() === ''
        ? 'Assigned a KinTale from Needs triage'
        : `Assigned a KinTale from Needs triage to ${m[1]!.trim()}`,
  ],
  [/^Marked orphan KinTale \S+ as duplicate of \S+$/, () => 'Marked a KinTale in Needs triage as a duplicate'],
  [/^Archived orphan KinTale \S+ as bad data: (.*)$/, (m) => `Archived a KinTale from Needs triage as bad data: ${m[1]}`],
  [/^Invoice PDF generated for \S+$/, () => 'Made the PDF for an invoice'],
  [/^Kinfolk downloaded invoice PDF for \S+$/, () => 'Household downloaded the PDF for an invoice'],
  [/^Vet clinic (update|archive) refused: '[^']*' not found$/, (m) => `Vet clinic ${m[1]} refused: the clinic was not found`],
  [/^Edited session \S+: (.*)$/, (m) => editedFields(m[1]!)],
  [/^Synced visit \S+ to Google Calendar \((\w+)\)$/, (m) => `Synced a visit to Google Calendar (${m[1]})`],
  [
    /^AI tale titles applied from batch \S+ \((\d+) applied, (\d+) skipped, (\d+) errored\)$/,
    (m) => `Applied AI KinTale titles (${m[1]} applied, ${m[2]} skipped, ${m[3]} errored)`,
  ],
  [
    /^Invite \S+ was sent, but the Auntie notice was not: (.*)$/,
    (m) => `An invite was sent, but the Auntie notice was not: ${m[1]}`,
  ],
  [
    /^Payment notification for invoice \S+ was not delivered after (\d+) retries$/,
    (m) => `A payment notification was not delivered after ${m[1]} retries`,
  ],
  // #1839: a look at a household stored before the server wrote it in words
  // ("OPERATOR_CROSSTENANT_ACCESS uid=<id> target=<id>"). Same words as
  // Android and the desktop console.
  [/^OPERATOR_CROSSTENANT_ACCESS(?: uid=\S+)?(?: target=\S+)?$/, () => ACTIVITY_WORDS.householdOpened],
];

/** A stored description as the operator reads it. Text with no id or path passes through. */
export function activityDescriptionWords(description: string): string {
  const text = description.trim();
  for (const [shape, words] of STORED_SHAPES) {
    if (shape.test(text)) return words;
  }
  for (const [shape, words] of ID_SHAPES) {
    const m = shape.exec(text);
    if (m) return words(m);
  }
  return text.replace(DRAFT_PATH, 'a draft');
}
