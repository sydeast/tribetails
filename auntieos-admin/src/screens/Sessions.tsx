import { useMemo, useState } from 'react';
import { SESSIONS_QUERY, type SessionEntry } from '../api/sessions';
import {
  sessionState,
  sessionStateInfo,
  sessionHousehold,
  sessionWindow,
  sessionDayKey,
  sessionDayLabel,
  groupSessionsByDay,
  isSessionActive,
  localDateIso,
  type SessionState,
} from '../lib/sessionFormat';
import { useCollection } from '../lib/firestore';
import { asyncScalar } from '../lib/async';
import { str } from '../lib/coerce';
import { useRovingTabs } from '../lib/useRovingTabs';
import { DenScreenHeading, DenPanel, StatCard, ServicePill, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { SessionDetail } from './SessionDetail';
import './Sessions.css';

/**
 * The Den filter tabs. Every predicate is a POSITIVE membership test against
 * the enumerated `SessionState` (the Invoices `FILTERS` / AO-12 convention), 
 * never a negation of another bucket.
 */
type FilterKey = 'all' | 'active' | 'scheduled' | 'completed' | 'cancelled';

interface FilterDef {
  key: FilterKey;
  label: string;
  test: (state: SessionState) => boolean;
}

const FILTERS: readonly FilterDef[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'active', label: 'Active', test: (s) => isSessionActive(s) },
  { key: 'scheduled', label: 'Scheduled', test: (s) => s === 'scheduled' },
  { key: 'completed', label: 'Completed', test: (s) => s === 'completed' },
  { key: 'cancelled', label: 'Cancelled', test: (s) => s === 'cancelled' },
];

interface SessionsProps {
  /**
   * Row-select override. The router mounts this screen propless, and by default
   * a selected row now opens the in-screen `SessionDetail` read-only view, fed
   * from the SAME live SESSIONS_QUERY stream this list already reads (no second
   * fetch, see the `detailEntry` lookup below), the Bookings.tsx onSelectBooking
   * pattern. Passing `onSelect` explicitly overrides that default (a future
   * detail ROUTE, or a test, owns selection instead); when overridden this
   * screen's own detail view never renders (see the `!onSelect` guard).
   */
  onSelect?: (sessionId: string) => void;
}

/**
 * Admin Sessions list ("The Den · Auntie Time", nav slug `sessions`, 
 * `lib/nav.ts` is explicit that the rail label and the slug are not the same
 * word). Streams the flat `kin_care_sessions` collection through the bounded,
 * server-ordered listener (SESSIONS_QUERY, startTime desc, capped 300), then
 * classifies every row through the enumerated `sessionState` (never by
 * negation) and groups the FILTERED rows by LOCAL calendar day
 * (`groupSessionsByDay`, the AO-18 fix) for display.
 *
 * Selecting a row opens `SessionDetail`, a read-only detail view of that one
 * session (status/service, timing, household/kin, notes), resolved from this
 * list's own stream (no second fetch, see SessionsProps.onSelect's doc and the
 * `detailEntry` lookup below). Still NOT built here: the WRITE flows,
 * clock-in/out, GPS tracking, and KinTale compose (`KinCareDetailScreen`/
 * `KinTaleComposeScreen` in the wasm reference), which are a separate surface.
 */
export function Sessions({ onSelect }: SessionsProps) {
  const rows = useCollection<SessionEntry>(SESSIONS_QUERY);
  const [filter, setFilter] = useState<FilterKey>('all');
  // The detail view's own selection state, used only when no external onSelect
  // is supplied (see SessionsProps's doc above).
  const [detailId, setDetailId] = useState<string | null>(null);
  const handleSelect = onSelect ?? setDetailId;

  // Roving-tabindex keyboard nav for the filter tablist below (Left/Right,
  // Home/End, roving tabIndex); called unconditionally at the top level per
  // the Rules of Hooks, since the tabs themselves render inside AsyncRegion's
  // conditionally-invoked render prop.
  const { getTabProps } = useRovingTabs({
    count: FILTERS.length,
    activeIndex: FILTERS.findIndex((f) => f.key === filter),
  });

  // Computed once per render pass, not per keystroke/tick, same rationale as
  // Invoices.tsx's todayIso: "today" doesn't change mid-session.
  const todayIso = useMemo(() => localDateIso(new Date()), []);

  // Every field below is read through `str()`: `SessionEntry` is a cast over raw
  // Firestore data, not a validation of it (see api/sessions.ts), so a doc can
  // genuinely lack `status`/`startTime`/`completedAt`. An absent field degrades
  // to '' and lands in the honest bucket the helpers already have for blank text
  // ('unknown' state, 'Undated' day), so it just doesn't count toward a stat
  // instead of throwing and blanking the screen.
  const activeCount = asyncScalar(rows, (data) =>
    data.filter((e) => isSessionActive(sessionState(str(e.status)))).length,
  );
  const todayCount = asyncScalar(
    rows,
    (data) => data.filter((e) => sessionDayKey(str(e.startTime)) === todayIso).length,
  );
  const wrappedTodayCount = asyncScalar(
    rows,
    (data) =>
      data.filter(
        (e) => sessionState(str(e.status)) === 'completed' && sessionDayKey(str(e.completedAt)) === todayIso,
      ).length,
  );

  // The row SessionDetail shows, resolved from the SAME live stream `rows`
  // already holds (never a second fetch): the Bookings.tsx `detailEntry`
  // pattern. `null` (stream not ready, or the id no longer resolves to a row)
  // gets its own honest "unavailable" state inside SessionDetail, never a blank.
  const detailEntry =
    detailId !== null && rows.status === 'ready'
      ? (rows.data.find((r) => r._id === detailId) ?? null)
      : null;

  // Only this screen's OWN selection takes over with its own detail view; an
  // external onSelect (see the prop's doc) means the caller owns the detail UI
  // instead. A sibling VIEW of the list, the Directory/KinfolkProfile pattern.
  if (!onSelect && detailId !== null) {
    return <SessionDetail entry={detailEntry} onBack={() => setDetailId(null)} />;
  }

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Auntie Time"
        title="Auntie"
        accentTail="Time."
        subtitle="Every Kin Care today and coming up, plus what wrapped recently."
      />

      <div className="sessions__summary">
        <StatCard
          label="In flight"
          value={activeCount}
          trend="on the way, arrived, or departed"
          tone="teal"
          feature={activeCount.kind === 'value' && activeCount.value > 0}
        />
        <StatCard label="Today" value={todayCount} trend="on today's calendar" tone="orange" />
        <StatCard label="Wrapped today" value={wrappedTodayCount} trend="completed Kin Cares" tone="success" />
      </div>

      <DenPanel title="Kin Care sessions" subtitle="Grouped by day, earliest first (today, then coming up), from the latest 300 on the books.">
        <AsyncRegion
          state={rows}
          what="Kin Care sessions"
          isEmpty={(data) => data.length === 0}
          loading={<p className="sessions__hint">Loading Kin Care sessions…</p>}
          empty={<EmptyHint>Nothing on the books yet.</EmptyHint>}
        >
          {(data) => {
            // Non-null: FILTERS lists all five FilterKey members above, and
            // `filter` only ever holds a key set via setFilter(f.key) from
            // that same array (Invoices.tsx's identical .find()! comment).
            const activeFilter = FILTERS.find((f) => f.key === filter)!;
            const visible = data.filter((e) => activeFilter.test(sessionState(str(e.status))));
            const groups = groupSessionsByDay(visible);

            return (
              <>
                <div className="sessions__tabs" role="tablist" aria-label="Filter Kin Care sessions">
                  {FILTERS.map((f, index) => (
                    <button
                      key={f.key}
                      type="button"
                      role="tab"
                      aria-selected={filter === f.key}
                      className={filter === f.key ? 'sessions__tab sessions__tab--active' : 'sessions__tab'}
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
                  <ul className="sessions__list">
                    {groups.map((g) => (
                      <li key={g.dayKeyValue} className="sessions__day-group">
                        <h3 className="sessions__day-header">{sessionDayLabel(g.dayKeyValue, todayIso)}</h3>
                        <ul className="sessions__day-rows">
                          {g.rows.map((entry) => (
                            <SessionRow key={entry._id} entry={entry} onSelect={handleSelect} />
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            );
          }}
        </AsyncRegion>
      </DenPanel>
    </div>
  );
}

interface SessionRowProps {
  entry: SessionEntry;
  onSelect?: ((sessionId: string) => void) | undefined;
}

function SessionRow({ entry, onSelect }: SessionRowProps) {
  const state = sessionState(str(entry.status));
  const info = sessionStateInfo(state);
  const household = sessionHousehold(str(entry.kinfolkName));

  const body = (
    <>
      <span className="sessions__row-who">
        <span className="sessions__row-name">{household}</span>
        <ServicePill serviceType={str(entry.serviceType)} />
      </span>

      <span className="sessions__row-when">{sessionWindow(str(entry.startTime), str(entry.endTime))}</span>

      <span className={`sessions__chip sessions__chip--${info.cssClass}`}>{info.chipLabel}</span>
    </>
  );

  // Static, non-interactive row unless a detail handler is wired: a live no-op
  // button is the dead-control anti-pattern (see ControlShell in Buttons.tsx).
  return (
    <li className="sessions__row">
      {onSelect ? (
        <button type="button" className="sessions__row-main" onClick={() => onSelect(entry._id)}>
          {body}
        </button>
      ) : (
        <div className="sessions__row-main sessions__row-main--static">{body}</div>
      )}
    </li>
  );
}
