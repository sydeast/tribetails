import { threadHouseholdName, threadPreviewText } from './inboxFormat';
import type { ConversationSummary } from '../api/inbox';

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
