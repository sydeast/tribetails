import { threadHouseholdName, threadPreviewText } from './inboxFormat';
import { sessionState } from './sessionFormat';
import type { ConversationSummary } from '../api/inbox';
import type { SessionEntry } from '../api/sessions';
import type { KinfolkProfile } from '../api/kinfolkProfile';

/**
 * Pure logic behind the Home dashboard insight widgets (the React port of the
 * Compose `screens/home/DashboardInsights.kt`). Every rule lives here, free of
 * React and Firebase, so it is unit-testable in isolation (see
 * `dashboardInsights.test.ts`); the widget components in `screens/widgets/` only
 * render what these functions return.
 *
 * The Compose dashboard already ships W8..W13 (weekly capacity, overdue,
 * species, frequent flyers, holiday runway); this module is where the React
 * rebuild's own widgets land, widget by widget, starting with the ones that read
 * an existing data source with no new backend.
 */

// ── AO-38 / W6 Unread Client Messages ─────────────────────────────────────────

/** One unread household thread, ready to render as a dashboard row. */
export interface UnreadMessage {
  kinfolkId: string;
  household: string;
  preview: string;
  atMs: number;
}

/**
 * The most recent unread client threads for the "Unread Client Messages" widget
 * (AO-38 / punch-list W6). Reads the SAME `listConversations` summaries the
 * Inbox screen loads (`api/inbox.ts`) and keeps only rows the admin has not read
 * (`unreadForAdmin`, the positive `threadReadState === 'unread'` signal, never a
 * negation), most recent first, capped at [limit]. A blank household name falls
 * back to the id and a blank preview to '' via the shared inbox helpers, so a
 * partial thread never renders `undefined`. Does not mutate [rows].
 */
export function unreadClientMessages(
  rows: readonly ConversationSummary[],
  limit = 5,
): UnreadMessage[] {
  return rows
    .filter((r) => r.unreadForAdmin)
    .slice()
    .sort((a, b) => b.lastMessageAtMs - a.lastMessageAtMs)
    .slice(0, Math.max(0, limit))
    .map((r) => ({
      kinfolkId: r.kinfolkId,
      household: threadHouseholdName(r.kinfolkName, r.kinfolkId),
      preview: threadPreviewText(r.lastMessagePreview),
      atMs: r.lastMessageAtMs,
    }));
}

/**
 * Total unread threads (the widget's headline count), independent of the
 * [unreadClientMessages] display cap so "3 shown" can still say "12 waiting".
 */
export function unreadClientMessageCount(rows: readonly ConversationSummary[]): number {
  return rows.reduce((n, r) => (r.unreadForAdmin ? n + 1 : n), 0);
}

// ── AO-36 / W3 Key & Code Safebox ──────────────────────────────────────────────

/**
 * The single NEXT upcoming visit for the "Key & Code Safebox" widget (AO-36 /
 * W3), which surfaces the access notes for that visit's household only. Keeps a
 * session whose start is now or later ([nowIso] is a full ISO instant, and start
 * times compare lexicographically for the `...Z` writes, the same string-compare
 * the sessions list already relies on) and whose state is neither cancelled nor
 * completed (the positive `sessionState` enum, never a status-string negation),
 * then returns the earliest such start. `null` when nothing is coming up.
 */
export function nextUpcomingSession(
  sessions: readonly SessionEntry[],
  nowIso: string,
): SessionEntry | null {
  let best: SessionEntry | null = null;
  for (const s of sessions) {
    const state = sessionState(s.status);
    if (state === 'cancelled' || state === 'completed') continue;
    if (s.startTime === '' || s.startTime < nowIso) continue;
    if (best === null || s.startTime < best.startTime) best = s;
  }
  return best;
}

/** One labelled access fact (gate code, entry notes, ...). */
export interface AccessLine {
  label: string;
  value: string;
  /** Render monospaced (a code / password), not prose. */
  mono?: boolean;
}

/**
 * The household's access notes as display lines, blank fields dropped so a
 * partial household never renders an empty "Gate code:" row. Codes/passwords are
 * flagged [mono] so the widget renders them monospaced. Order is arrival order:
 * where you're going, how you get in, then the wifi once inside.
 */
export function safeboxAccessLines(p: KinfolkProfile): AccessLine[] {
  const lines: AccessLine[] = [];
  const add = (label: string, value: string, mono = false): void => {
    if (value.trim() !== '') lines.push(mono ? { label, value, mono: true } : { label, value });
  };
  add('Address', p.serviceAddress);
  add('Gate / door code', p.gateCode, true);
  add('Entry notes', p.entryNotes);
  add('Parking', p.parkingInstructions);
  add('WiFi network', p.wifiName);
  add('WiFi password', p.wifiPassword, true);
  return lines;
}
