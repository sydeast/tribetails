/**
 * The Inbox's stacked section model, ported from the archive's `InboxScreen.kt`
 * (Compose), which put a Notifications panel, then a Messages panel, then a
 * Channels panel on ONE screen rather than splitting them across tabs.
 *
 * ── The Channels seam, now filled (Task 6.1) ──────────────────────────────
 * The archive's third section rendered the four Twilio streams (voicemails,
 * calls, SMS, email). This module listed two sections while those streams did
 * not exist on the React side, on the reasoning that an empty panel titled
 * Channels is a dark gate in a quieter voice. Task 6.1 landed the streams
 * (`api/inboxChannels.ts`), so the third entry is here and the screen renders
 * the four real listeners behind it.
 *
 * ── CHANNELS CONTRIBUTE NOTHING TO `inboxUnreadTotal`, ON PURPOSE ──────────
 * The badge below counts NOTIFICATIONS and MESSAGE THREADS, the two sections
 * whose rows carry a server-maintained read flag. Channels are excluded, and
 * the full reasoning lives in `lib/inboxChannels.ts`: folding them in here but
 * not into the nav rail (`lib/useUnreadInbox.ts`, one listener, deliberately)
 * would print two different numbers for the same word on two surfaces, and
 * folding them into the rail as well means a second app-wide listener on
 * collections that grow one document per message. A voicemail nobody has
 * answered is instead counted under its own noun, "waiting on a reply", inside
 * the Channels panel where the operator can act on it.
 */

export type InboxSectionKey = 'notifications' | 'messages' | 'channels';

export interface InboxSectionDef {
  readonly key: InboxSectionKey;
  readonly title: string;
  readonly subtitle: string;
}

/** Order here is the top-to-bottom render order on the Inbox screen. */
export const INBOX_SECTIONS: readonly InboxSectionDef[] = [
  {
    key: 'notifications',
    title: 'Notifications',
    subtitle: 'Business alerts waiting on you. Select rows to mark them read in bulk.',
  },
  {
    key: 'messages',
    title: 'Messages',
    subtitle: 'Two-way threads with kinfolk. Open a thread to read and reply.',
  },
  {
    key: 'channels',
    title: 'Channels',
    subtitle: 'Voicemails, calls, texts and email, everywhere kinfolk reach out. Open a row to answer it.',
  },
];

/** The definition for one section. Total, because `InboxSectionKey` is closed. */
export function inboxSection(key: InboxSectionKey): InboxSectionDef {
  // Non-null: every `InboxSectionKey` member has an entry above, and the type
  // admits nothing else (the Sessions.tsx / Inbox.tsx `.find()!` convention).
  return INBOX_SECTIONS.find((s) => s.key === key)!;
}

/**
 * The header badge total across sections.
 *
 * `null` for a section whose load has not resolved, so this can tell "nothing
 * unread" apart from "we do not know yet", the distinction `lib/async.ts`'s
 * `asyncScalar` exists to protect. All-null gives `null` (show no badge at
 * all) rather than a fabricated 0; a partially-resolved inbox reports what it
 * genuinely knows, since a real "2 unread" beside a still-loading section is
 * more useful than silence and is never an overclaim.
 */
export function inboxUnreadTotal(counts: readonly (number | null)[]): number | null {
  const known = counts.filter((c): c is number => c !== null);
  if (known.length === 0) return null;
  return known.reduce((sum, c) => sum + c, 0);
}
