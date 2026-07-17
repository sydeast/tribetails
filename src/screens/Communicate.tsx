import { useCallback, useEffect, useMemo, useState } from 'react';
import { listRecentSends, type RecentSend } from '../api/communicate';
import {
  channelLabel,
  engagementSummary,
  groupSendsByDay,
  sendChannelOf,
  sendClock,
  sendCountsOf,
  sendDayLabel,
  sendMachineTime,
  sendRecipient,
  sendStateInfo,
  sendStateOf,
  sendSubject,
  localDateIso,
  type SendChannel,
} from '../lib/communicateFormat';
import { type Async } from '../lib/async';
import { useRovingTabs } from '../lib/useRovingTabs';
import { DenScreenHeading, DenPanel, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { GhostButton, PrimaryButton } from '../components/Buttons';
import { CommunicateCompose } from './CommunicateCompose';
import { CommunicatePersonalize } from './CommunicatePersonalize';
import './Communicate.css';

/**
 * The Den filter tabs. Every predicate is a POSITIVE membership test against
 * `sendChannelOf`'s enumerated `SendChannel` (the Inbox.tsx / Sessions.tsx /
 * Invoices.tsx / AO-12 convention), never a negation of the other channels.
 * `unknown` rows (a channel neither 'email' nor 'sms') stay visible under
 * All, honestly, rather than being force-fit into one of the two named tabs.
 */
type FilterKey = 'all' | 'email' | 'sms';

interface FilterDef {
  key: FilterKey;
  label: string;
  test: (channel: SendChannel) => boolean;
}

const FILTERS: readonly FilterDef[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'email', label: 'Email', test: (c) => c === 'email' },
  { key: 'sms', label: 'Text', test: (c) => c === 'sms' },
];

/**
 * Communicate "Recent": the sent-message history the wasm Communicate
 * screen's "Recent" panel shows (`RecentPanel` in
 * screens/communicate/CommunicateScreen.kt), ported here as its own
 * full screen since this is a READ-ONLY port (see the module doc below for
 * scope).
 *
 * ── WHAT THE WASM Communicate SCREEN ACTUALLY IS ──────────────────────────
 * Investigated before porting: Communicate is primarily a COMPOSE hub (a
 * "Personalize" 1:1 AI-drafted note flow, and a "Broadcast" segment +
 * multichannel send form, both backed by real write callables). Alongside
 * compose, it has exactly one genuine READ-ONLY list: the "Recent" panel,
 * which loads `listRecentSends` and shows sent external messages (email/sms)
 * with delivery/open/click engagement counts. That is what this file ports.
 * Everything else on the wasm screen (draft compose + generate, the
 * recipient/dossier "411" context panel, the live preview, the broadcast
 * compose form, the template bank) is compose/write surface and is
 * deliberately OUT of scope here, per the port brief.
 *
 * (A `broadcasts` Firestore collection also exists server-side, written by
 * `broadcastMessage` with a genuine admin-read rule in MyTribe/firestore.rules,
 * but the wasm app has never built a UI that reads it; inventing one here
 * would be adding a screen that doesn't exist anywhere today, not porting
 * one, so it is intentionally left alone.)
 *
 * Loads once via the one-shot `listRecentSends` callable (see
 * `api/communicate.ts` for why this is a callable, not a `useCollection`
 * stream: `external_messages` has no client Firestore read rule at all).
 * Classifies every row's channel (`sendChannelOf`) and engagement state
 * (`sendStateOf`) through positive enumerations, never negation, and groups
 * the FILTERED rows by LOCAL calendar day (`groupSendsByDay`, the AO-18 fix
 * applied to this callable's epoch-ms `sentAtMs`), newest day and newest send
 * first, the activity-feed order Inbox.tsx/Notifications.tsx also use.
 *
 * Read-only itself, but no longer the screen's only surface: the "New
 * broadcast" trailing button below opens `CommunicateCompose`, the send
 * surface this file used to defer (see `api/communicateWrite.ts` for the
 * confirmed `broadcastMessage` payload and why it ships audience+channel+
 * subject/body compose without a live pre-send recipient count). The
 * "Personalize a message" trailing button opens `CommunicatePersonalize`,
 * the 1:1 AI-drafted note flow (see `api/communicateGenerate.ts` for the
 * confirmed `generate`/`sendMessage` `onRequest` backend contract). Resending
 * a past send remains not-yet-built.
 */
export function Communicate() {
  const [sends, setSends] = useState<Async<RecentSend[]>>({ status: 'loading' });
  const [filter, setFilter] = useState<FilterKey>('all');
  // Local view toggle, not a route: the compose/personalize surfaces are
  // sibling views of this same screen (Directory.tsx's tab convention), not a
  // new URL. Kept out of router.tsx/nav.ts on purpose, this is a same-screen
  // mode switch.
  const [view, setView] = useState<'recent' | 'compose' | 'personalize'>('recent');

  // Roving-tabindex keyboard nav for the filter tablist below (Left/Right,
  // Home/End, roving tabIndex); called unconditionally at the top level per
  // the Rules of Hooks, since the tabs themselves render inside AsyncRegion's
  // conditionally-invoked render prop.
  const { getTabProps } = useRovingTabs({
    count: FILTERS.length,
    activeIndex: FILTERS.findIndex((f) => f.key === filter),
  });

  // Computed once per render pass, not per keystroke/tick, same rationale as
  // Inbox.tsx's / Sessions.tsx's todayIso.
  const todayIso = useMemo(() => localDateIso(new Date()), []);

  // Hoisted so a failed load can hand AsyncRegion a real retry, same shape as
  // Inbox.tsx's / FormSchemas.tsx's load().
  const load = useCallback(() => {
    let live = true;
    setSends({ status: 'loading' });
    listRecentSends()
      .then((data) => live && setSends({ status: 'ready', data }))
      .catch(
        (err: unknown) =>
          live &&
          setSends({
            status: 'error',
            message: `listRecentSends failed: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: load,
          }),
      );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  // Only claimed once the load has actually resolved, never a fabricated 0
  // while loading/erroring (the StatCard / AsyncRegion / Inbox.tsx policy
  // this app follows throughout; see lib/async.ts).
  const failedCount =
    sends.status === 'ready'
      ? sends.data.filter((s) => sendStateOf(sendCountsOf(s.counts), s.channel) === 'failed').length
      : 0;

  // Compose/personalize are sibling views of this same screen, not a route:
  // swap the whole tree rather than growing an if/else through the JSX below.
  if (view === 'compose') {
    return <CommunicateCompose onClose={() => setView('recent')} />;
  }
  if (view === 'personalize') {
    return <CommunicatePersonalize onClose={() => setView('recent')} />;
  }

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Communicate"
        title="Recent"
        subtitle="Sent messages to kinfolk, with delivery and open counts as providers report them."
        trailing={
          <>
            {failedCount > 0 ? <span className="communicate__badge">{failedCount} failed</span> : null}
            <GhostButton label="Personalize a message" onClick={() => setView('personalize')} />
            <PrimaryButton label="New broadcast" onClick={() => setView('compose')} />
          </>
        }
      />

      <DenPanel title="Sent messages" subtitle="Every external send on the books, newest first.">
        <AsyncRegion
          state={sends}
          what="recent sends"
          isEmpty={(data) => data.length === 0}
          loading={<p className="communicate__hint">Loading recent sends…</p>}
          empty={
            <EmptyHint>
              No external sends yet. Sends from Communicate show here with delivery and open counts.
            </EmptyHint>
          }
        >
          {(data) => {
            // Non-null: FILTERS lists all three FilterKey members above, and
            // `filter` only ever holds a key set via setFilter(f.key) from
            // that same array (the Inbox.tsx/Sessions.tsx .find()! comment).
            const activeFilter = FILTERS.find((f) => f.key === filter)!;
            const visible = data.filter((row) => activeFilter.test(sendChannelOf(row.channel)));
            const groups = groupSendsByDay(visible);

            return (
              <>
                <div className="communicate__tabs" role="tablist" aria-label="Filter recent sends by channel">
                  {FILTERS.map((f, index) => (
                    <button
                      key={f.key}
                      type="button"
                      role="tab"
                      aria-selected={filter === f.key}
                      className={filter === f.key ? 'communicate__tab communicate__tab--active' : 'communicate__tab'}
                      onClick={() => setFilter(f.key)}
                      {...getTabProps(index)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>

                {groups.length === 0 ? (
                  <EmptyHint>Nothing matches this filter.</EmptyHint>
                ) : (
                  <ul className="communicate__list">
                    {groups.map((g) => (
                      <li key={g.dayKeyValue} className="communicate__day-group">
                        <h3 className="communicate__day-header">{sendDayLabel(g.dayKeyValue, todayIso)}</h3>
                        <ul className="communicate__day-rows">
                          {g.rows.map((row) => (
                            <SendRow key={row.id} row={row} />
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}

                <GhostButton label="Reload" onClick={load} className="communicate__reload" />
              </>
            );
          }}
        </AsyncRegion>
      </DenPanel>
    </div>
  );
}

interface SendRowProps {
  row: RecentSend;
}

function SendRow({ row }: SendRowProps) {
  const counts = sendCountsOf(row.counts);
  const state = sendStateOf(counts, row.channel);
  const info = sendStateInfo(state);
  const subject = sendSubject(row.subject);
  const recipient = sendRecipient(row.recipientRedacted);

  return (
    <li className="communicate__row">
      <span className="communicate__row-who">
        <span className="communicate__row-name">
          {channelLabel(row.channel)} · {recipient}
        </span>
        {subject !== '' ? <span className="communicate__row-subject">{subject}</span> : null}
        <span className="communicate__row-summary">{engagementSummary(row.channel, counts)}</span>
      </span>
      <span className="communicate__row-side">
        <time className="communicate__row-time" dateTime={sendMachineTime(row.sentAtMs)}>
          {sendClock(row.sentAtMs)}
        </time>
        {/* data-tone, not an invented class: resolved by DenScreenKit.css's
            shared [data-tone] table (see sendStateInfo's doc). */}
        <span className="communicate__state" data-tone={info.tone}>
          {info.label}
        </span>
      </span>
    </li>
  );
}
