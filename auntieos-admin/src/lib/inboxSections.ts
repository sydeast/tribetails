/**
 * The Inbox's stacked section model, ported from the archive's `InboxScreen.kt`
 * (Compose), which put a Notifications panel, then a Messages panel, then a
 * Channels panel on ONE screen rather than splitting them across tabs.
 *
 * ── The Channels seam (Task 6.1) ──────────────────────────────────────────
 * The archive's third section rendered the four Twilio streams (voicemails,
 * calls, SMS, email). Those streams do not exist on the React side yet; they
 * are Task 6.1. This module therefore lists TWO sections, not three, and the
 * screen renders exactly what is listed here.
 *
 * That is a deliberate choice over shipping an empty "Channels" panel: the
 * plan's Definition of DONE forbids a dark gate or a "coming soon" banner for
 * our own code, and an empty panel titled Channels is the same lie in a
 * quieter voice. When 6.1 lands its streams it appends one entry below and
 * renders its panel; `inboxUnreadTotal` already takes N counts, so the header
 * badge needs no change at that point.
 */

export type InboxSectionKey = 'notifications' | 'messages';

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
