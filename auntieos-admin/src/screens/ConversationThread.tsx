import { useCallback, useEffect, useMemo, useState } from 'react';
import { getConversationThread, replyToConversation, type ThreadMessage } from '../api/inboxThread';
import {
  threadClock,
  threadMachineTime,
  threadDayKey,
  threadDayLabel,
  localDateIso,
  replyBlocker,
} from '../lib/inboxFormat';
import { type Async } from '../lib/async';
import { DenScreenHeading, DenPanel, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import './ConversationThread.css';

interface ConversationThreadProps {
  kinfolkId: string;
  /** Household display name from the Inbox row (avoids a second lookup for the header). */
  kinfolkName: string;
  onBack: () => void;
}

interface DayGroup {
  dayKeyValue: string;
  rows: ThreadMessage[];
}

/** Groups messages (oldest-first) into LOCAL calendar days (AO-18). */
function groupMessagesByDay(messages: ThreadMessage[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const m of messages) {
    const day = threadDayKey(m.createdAtMs);
    const last = groups[groups.length - 1];
    if (last && last.dayKeyValue === day) last.rows.push(m);
    else groups.push({ dayKeyValue: day, rows: [m] });
  }
  return groups;
}

/**
 * The kinfolk<->auntie conversation thread: the detail view the Inbox list's
 * `onSelectThread` opens (Inbox.tsx ships list-only). Loads one household's
 * messages via `getConversationThread` (which also clears the admin unread flag
 * server-side, so returning to the list shows it read), and appends a reply via
 * `replyToConversation`.
 *
 * A reply reaches a REAL household: the Send button is the explicit intent (a
 * chat compose, not a bulk broadcast), disabled while empty or in flight, and
 * fail-loud on rejection. Times are LOCAL (AO-18, `threadClock`). Messages are
 * grouped by local day, oldest-first, the natural chat order (the inverse of the
 * Inbox list's newest-first activity feed).
 */
export function ConversationThread({ kinfolkId, kinfolkName, onBack }: ConversationThreadProps) {
  const [messages, setMessages] = useState<Async<ThreadMessage[]>>({ status: 'loading' });
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const todayIso = useMemo(() => localDateIso(new Date()), []);

  const load = useCallback(() => {
    let live = true;
    setMessages({ status: 'loading' });
    getConversationThread(kinfolkId)
      .then((data) => live && setMessages({ status: 'ready', data }))
      .catch(
        (err: unknown) =>
          live &&
          setMessages({
            status: 'error',
            message: `getConversationThread failed: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: load,
          }),
      );
    return () => {
      live = false;
    };
  }, [kinfolkId]);

  useEffect(() => load(), [load]);

  // Archive parity (Conversations.kt#replyBlocker): the same rule drives the
  // inline hint AND the disabled Send control, so the button state and the
  // explanation can never disagree.
  const blocker = replyBlocker(draft);

  async function handleSend() {
    const body = draft.trim();
    if (blocker !== null || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await replyToConversation(kinfolkId, body);
      setSending(false);
      setDraft('');
      load(); // reload so the new message (and cleared unread) reflect the server truth
    } catch (err) {
      setSending(false);
      setSendError(`replyToConversation failed: ${err instanceof Error ? err.message : 'Send failed'}`);
    }
  }

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Inbox"
        title={kinfolkName || kinfolkId}
        subtitle="Two-way message thread with this household."
        trailing={<GhostButton label="Back to Inbox" onClick={onBack} />}
      />

      <DenPanel title="Messages" subtitle="Oldest first. Opening this thread marks it read.">
        <AsyncRegion
          state={messages}
          what="messages"
          isEmpty={(data) => data.length === 0}
          loading={<p className="thread__hint">Loading messages…</p>}
          empty={<EmptyHint>No messages in this thread yet. Send the first reply below.</EmptyHint>}
        >
          {(data) => (
            <ul className="thread__list">
              {groupMessagesByDay(data).map((g) => (
                <li key={g.dayKeyValue} className="thread__day-group">
                  <h3 className="thread__day-header">{threadDayLabel(g.dayKeyValue, todayIso)}</h3>
                  <ul className="thread__day-rows">
                    {g.rows.map((m) => {
                      const mine = m.senderRole === 'auntie';
                      return (
                        <li key={m.id} className={mine ? 'thread__msg thread__msg--mine' : 'thread__msg'}>
                          <div className="thread__bubble">
                            <span className="thread__body">{m.body}</span>
                            <time className="thread__time" dateTime={threadMachineTime(m.createdAtMs)}>
                              {threadClock(m.createdAtMs)}
                            </time>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </AsyncRegion>
      </DenPanel>

      <DenPanel title="Reply" subtitle="Sends a real message to this household.">
        {sendError ? (
          <Banner tone="error" title="Reply failed" onDismiss={() => setSendError(null)}>
            {sendError}
          </Banner>
        ) : null}
        <div className="thread__compose">
          <textarea
            className="thread__input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Write a reply…"
            rows={3}
            disabled={sending}
            aria-label="Reply to this household"
          />
          {/* Only shown once there IS a draft: "Write a reply first." on an
              untouched box would scold the operator for not having started. */}
          {draft !== '' && blocker !== null ? (
            <p className="thread__blocker" role="status">
              {blocker}
            </p>
          ) : null}
          <PrimaryButton
            label={sending ? 'Sending…' : 'Send reply'}
            onClick={() => void handleSend()}
            disabled={blocker !== null || sending}
            busy={sending}
          />
        </div>
      </DenPanel>
    </div>
  );
}
