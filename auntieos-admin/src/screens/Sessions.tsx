import { useMemo, useState } from 'react';
import { sessionsArchiveQuery, sessionsWindowQuery, type SessionEntry } from '../api/sessions';
import {
  sessionState,
  sessionStateInfo,
  sessionHousehold,
  sessionWindow,
  sessionDayKey,
  sessionDayLabel,
  groupSessionsByDay,
  groupSessionsByPhase,
  isSessionActive,
  localDateIso,
  shiftDayIso,
  FETCH_DAYS_BACK,
  RECENT_WINDOW_DAYS,
  UPCOMING_WINDOW_DAYS,
  type SessionDayGroup,
  type SessionSort,
  type SessionState,
} from '../lib/sessionFormat';
import { useCollection } from '../lib/firestore';
import { asyncScalar } from '../lib/async';
import { str } from '../lib/coerce';
import { useRovingTabs } from '../lib/useRovingTabs';
import { DenScreenHeading, DenPanel, StatCard, ServicePill, EmptyHint } from '../components/DenScreenKit';
import { GhostButton } from '../components/Buttons';
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

/** Which body of data the screen is showing: the day-of window, or older history. */
type ViewMode = 'window' | 'archive';

const SORTS: readonly { key: SessionSort; label: string }[] = [
  { key: 'soonest', label: 'Soonest first' },
  { key: 'latest', label: 'Latest first' },
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
 * word). Streams the flat `kin_care_sessions` collection through a bounded,
 * server-ordered, DATE-RANGED listener, classifies every row through the
 * enumerated `sessionState` (never by negation), then groups the FILTERED rows
 * into Active / Upcoming / Recent, each still sub-grouped by LOCAL calendar day
 * (the AO-18 fix).
 *
 * OPERATOR ISSUE #17, and what changed. The sub-header has always promised
 * "Every Kin Care today and coming up, plus what wrapped recently", but the
 * screen read `SESSIONS_QUERY`: a flat 300 rows by startTime desc, no date
 * predicate, day-grouped and nothing else. A visit from March sat in the same
 * list as tomorrow's, so the copy and the data disagreed. Now:
 *  - `sessionsWindowQuery` fetches a bounded date range, and
 *    `groupSessionsByPhase` narrows it to the three phases the copy describes
 *    (see `lib/sessionFormat.ts` for each boundary and why it sits where it
 *    does).
 *  - Day headers carry the YEAR when it is not the current one, so a visit
 *    from last January can no longer read as this January.
 *  - A Sort control (soonest / latest first) reverses days and rows WITHIN a
 *    phase; the phases themselves keep the archive's fixed order.
 *  - The filter tabs are unchanged, and now operate inside the window.
 *  - Older history moved behind an Archive toggle, which swaps in
 *    `sessionsArchiveQuery` over an operator-chosen range and drops the phase
 *    rules (escaping them is the point of opening it).
 *
 * Selecting a row opens `SessionDetail`, a read-only detail view of that one
 * session (status/service, timing, household/kin, notes), resolved from this
 * list's own stream (no second fetch, see SessionsProps.onSelect's doc and the
 * `detailEntry` lookup below). Still NOT built here: the WRITE flows,
 * clock-in/out, GPS tracking, and KinTale compose (`KinCareDetailScreen`/
 * `KinTaleComposeScreen` in the wasm reference), which are a separate surface.
 */
export function Sessions({ onSelect }: SessionsProps) {
  const [filter, setFilter] = useState<FilterKey>('all');
  const [sort, setSort] = useState<SessionSort>('soonest');
  const [mode, setMode] = useState<ViewMode>('window');
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

  // The Archive's default range is the month immediately BEFORE the day-of
  // window's own fetch reaches, so opening it never re-shows what the list was
  // already showing.
  const [archiveFrom, setArchiveFrom] = useState(() =>
    shiftDayIso(todayIso, -(FETCH_DAYS_BACK + 30)),
  );
  const [archiveTo, setArchiveTo] = useState(() => shiftDayIso(todayIso, -(FETCH_DAYS_BACK + 1)));

  // One bounded listener either way. The spec is memoized on its inputs so a
  // re-render cannot churn the subscription (see CollectionSpec's own note).
  const spec = useMemo(
    () =>
      mode === 'archive'
        ? sessionsArchiveQuery(archiveFrom, archiveTo)
        : sessionsWindowQuery(todayIso),
    [mode, archiveFrom, archiveTo, todayIso],
  );
  const rows = useCollection<SessionEntry>(spec);

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

      {mode === 'window' && (
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
      )}

      <DenPanel
        title={mode === 'archive' ? 'Archive' : 'Kin Care sessions'}
        subtitle={
          mode === 'archive'
            ? 'Older history, by day. Pick a range; the year shows on any day outside this one.'
            : `In flight now, the next ${UPCOMING_WINDOW_DAYS} days, and what wrapped in the last ${RECENT_WINDOW_DAYS}.`
        }
        trailing={
          <GhostButton
            label={mode === 'archive' ? 'Back to Auntie Time' : 'Archive'}
            onClick={() => setMode(mode === 'archive' ? 'window' : 'archive')}
          />
        }
      >
        {mode === 'archive' && (
          <div className="sessions__range">
            <label className="sessions__range-field">
              <span className="sessions__control-label">From</span>
              <input
                type="date"
                className="sessions__range-input"
                value={archiveFrom}
                max={archiveTo}
                onChange={(e) => setArchiveFrom(e.target.value)}
              />
            </label>
            <label className="sessions__range-field">
              <span className="sessions__control-label">To</span>
              <input
                type="date"
                className="sessions__range-input"
                value={archiveTo}
                min={archiveFrom}
                onChange={(e) => setArchiveTo(e.target.value)}
              />
            </label>
          </div>
        )}

        <AsyncRegion
          state={rows}
          what="Kin Care sessions"
          isEmpty={(data) => data.length === 0}
          loading={<p className="sessions__hint">Loading Kin Care sessions…</p>}
          empty={
            <EmptyHint>
              {mode === 'archive'
                ? 'No Kin Cares in this range.'
                : 'Nothing on the books in this window. Older visits are in the Archive.'}
            </EmptyHint>
          }
        >
          {(data) => {
            // Non-null: FILTERS lists all five FilterKey members above, and
            // `filter` only ever holds a key set via setFilter(f.key) from
            // that same array (Invoices.tsx's identical .find()! comment).
            const activeFilter = FILTERS.find((f) => f.key === filter)!;
            const visible = data.filter((e) => activeFilter.test(sessionState(str(e.status))));

            // The window view groups by PHASE (each phase still sub-grouped by
            // day); the Archive is plain history, so it groups by day alone,
            // deliberately WITHOUT the window rules, since escaping them is the
            // whole point of opening it.
            const phases =
              mode === 'archive' ? [] : groupSessionsByPhase(visible, todayIso, sort);
            const archiveDays = mode === 'archive' ? orderDays(groupSessionsByDay(visible), sort) : [];
            const shown = mode === 'archive' ? archiveDays.length : phases.length;

            // Two different empties, told apart rather than merged: a filter
            // that matches nothing, versus a window that holds nothing.
            const unfilteredShown =
              mode === 'archive'
                ? data.length
                : groupSessionsByPhase(data, todayIso, sort).length;

            return (
              <>
                <div className="sessions__controls">
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

                  <label className="sessions__sort">
                    <span className="sessions__control-label">Sort</span>
                    <select
                      className="sessions__sort-select"
                      value={sort}
                      onChange={(e) => setSort(e.target.value as SessionSort)}
                    >
                      {SORTS.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {shown === 0 ? (
                  <EmptyHint>
                    {unfilteredShown === 0
                      ? mode === 'archive'
                        ? 'No Kin Cares in this range.'
                        : 'Nothing on the books in this window. Older visits are in the Archive.'
                      : 'Nothing matches this filter.'}
                  </EmptyHint>
                ) : mode === 'archive' ? (
                  <DayList days={archiveDays} todayIso={todayIso} onSelect={handleSelect} />
                ) : (
                  <ul className="sessions__phases">
                    {phases.map((p) => (
                      <li key={p.phase} className={`sessions__phase sessions__phase--${p.phase}`}>
                        <h3 className="sessions__phase-header">
                          {p.label}
                          <span className="sessions__phase-count">{p.count}</span>
                        </h3>
                        <DayList days={p.days} todayIso={todayIso} onSelect={handleSelect} />
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

/**
 * Day groups read in the operator's chosen direction. `groupSessionsByDay`
 * always returns days ascending with rows ascending inside each, so "latest
 * first" is that same ordering reversed on both axes (the identical rule
 * `groupSessionsByPhase` applies within a phase).
 */
function orderDays<T>(days: SessionDayGroup<T>[], sort: SessionSort): SessionDayGroup<T>[] {
  if (sort === 'soonest') return days;
  return [...days].reverse().map((d) => ({ ...d, rows: [...d.rows].reverse() }));
}

interface DayListProps {
  days: SessionDayGroup<SessionEntry>[];
  todayIso: string;
  onSelect: (sessionId: string) => void;
}

/** The day-header + rows list, shared by the phase groups and the Archive. */
function DayList({ days, todayIso, onSelect }: DayListProps) {
  return (
    <ul className="sessions__list">
      {days.map((g) => (
        <li key={g.dayKeyValue} className="sessions__day-group">
          <h4 className="sessions__day-header">{sessionDayLabel(g.dayKeyValue, todayIso)}</h4>
          <ul className="sessions__day-rows">
            {g.rows.map((entry) => (
              <SessionRow key={entry._id} entry={entry} onSelect={onSelect} />
            ))}
          </ul>
        </li>
      ))}
    </ul>
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
        <button type="button" className="sessions__row-main lift" onClick={() => onSelect(entry._id)}>
          {body}
        </button>
      ) : (
        <div className="sessions__row-main sessions__row-main--static">{body}</div>
      )}
    </li>
  );
}
