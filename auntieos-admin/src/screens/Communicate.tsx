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
import { GhostButton } from '../components/Buttons';
import { CommunicateCompose } from './CommunicateCompose';
import { CommunicatePersonalize } from './CommunicatePersonalize';
import './Communicate.css';

/**
 * Communicate.
 *
 * ── WHAT THE DEFAULT VIEW IS, AND WHY ───────────────────────────────────────
 * Personalize, the Auntie voice generator. That is what the archived Compose
 * app opened on (`ComposeMode.Personalize`, the initial value of its `mode`
 * state), and it is what the screen is FOR: writing to kinfolk in Auntie's
 * voice. The React port had made Recent, a read-only sent-history list, the
 * landing view, with the two compose surfaces behind heading buttons. Opening a
 * writing tool on a list of things already written is backwards.
 *
 * ── THREE MODES, WHERE THE ARCHIVE HAD TWO ──────────────────────────────────
 * The archive's picker was Personalize / Broadcast, and its "Recent" was a
 * collapsible panel down the right-hand column beside a live preview. This port
 * had already built Recent as a full screen with its own channel filter and day
 * grouping, which is more than the archive's panel ever did, so it becomes the
 * third mode rather than being demoted back into a sidebar. That is a
 * deliberate divergence, not a restoration.
 *
 * Recent's own channel filter stays exactly as it was: a tablist over
 * `sendChannelOf`'s enumerated `SendChannel`, every predicate a POSITIVE
 * membership test rather than a negation of the others, so an `unknown` row
 * stays visible under All instead of being force-fit into a named tab.
 */

type Mode = 'personalize' | 'broadcast' | 'recent';

interface ModeDef {
  key: Mode;
  label: string;
  title: string;
  accentTail?: string;
  subtitle: string;
}

const MODES: readonly ModeDef[] = [
  {
    key: 'personalize',
    label: 'Personalize',
    title: 'Talk to your',
    accentTail: 'kinfolk.',
    subtitle:
      'Give Auntie the notes, pick a tone and a length, then read the draft and approve it before it goes home.',
  },
  {
    key: 'broadcast',
    label: 'Broadcast',
    title: 'One message,',
    accentTail: 'many homes.',
    subtitle: 'Send to a saved audience or one you build here, across in-app, email, text, and push.',
  },
  {
    key: 'recent',
    label: 'Recent',
    title: 'Recent',
    subtitle: 'Sent messages to kinfolk, with delivery and open counts as providers report them.',
  },
];

type FilterKey = 'all' | 'email' | 'sms' | 'push';

interface FilterDef {
  key: FilterKey;
  label: string;
  test: (channel: SendChannel) => boolean;
}

const FILTERS: readonly FilterDef[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'email', label: 'Email', test: (c) => c === 'email' },
  { key: 'sms', label: 'Text', test: (c) => c === 'sms' },
  { key: 'push', label: 'Push', test: (c) => c === 'push' },
];

export function Communicate() {
  const [mode, setMode] = useState<Mode>('personalize');

  const { getTabProps } = useRovingTabs({
    count: MODES.length,
    activeIndex: MODES.findIndex((m) => m.key === mode),
  });

  // Non-null: MODES lists every Mode member and `mode` only ever holds a key
  // set from that same array.
  const active = MODES.find((m) => m.key === mode)!;

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Communicate"
        title={active.title}
        {...(active.accentTail !== undefined ? { accentTail: active.accentTail } : {})}
        subtitle={active.subtitle}
        trailing={
          <div className="communicate__modes" role="tablist" aria-label="Communicate mode">
            {MODES.map((m, index) => (
              <button
                key={m.key}
                type="button"
                role="tab"
                aria-selected={mode === m.key}
                className={mode === m.key ? 'communicate__mode communicate__mode--active' : 'communicate__mode'}
                onClick={() => setMode(m.key)}
                {...getTabProps(index)}
              >
                {m.label}
              </button>
            ))}
          </div>
        }
      />

      {/* Mounted per mode rather than hidden with CSS: Recent's `listRecentSends`
          call belongs to Recent, and a hidden-but-mounted Recent would fetch on
          every visit to a compose surface that never shows it. */}
      {mode === 'personalize' && <CommunicatePersonalize />}
      {mode === 'broadcast' && <CommunicateCompose />}
      {mode === 'recent' && <RecentSends />}
    </div>
  );
}

/**
 * The sent-message history. Loads once via the one-shot `listRecentSends`
 * callable (see `api/communicate.ts` for why this is a callable and not a
 * `useCollection` stream: `external_messages` has no client Firestore read rule
 * at all). Groups the FILTERED rows by LOCAL calendar day, newest day and
 * newest send first.
 */
function RecentSends() {
  const [sends, setSends] = useState<Async<RecentSend[]>>({ status: 'loading' });
  const [filter, setFilter] = useState<FilterKey>('all');

  // Roving-tabindex keyboard nav for the filter tablist below. Called
  // unconditionally at the top level per the Rules of Hooks, since the tabs
  // themselves render inside AsyncRegion's conditionally-invoked render prop.
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
  // while loading/erroring (the StatCard / AsyncRegion / Inbox.tsx policy this
  // app follows throughout; see lib/async.ts).
  const failedCount =
    sends.status === 'ready'
      ? sends.data.filter((s) => sendStateOf(sendCountsOf(s.counts), s.channel) === 'failed').length
      : 0;

  return (
    <DenPanel title="Sent messages" subtitle="Every external send on the books, newest first.">
      {failedCount > 0 ? <span className="communicate__badge">{failedCount} failed</span> : null}

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
          // Non-null: FILTERS lists all four FilterKey members above, and
          // `filter` only ever holds a key set via setFilter(f.key) from that
          // same array (the Inbox.tsx/Sessions.tsx .find()! comment).
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
