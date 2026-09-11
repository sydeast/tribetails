import { useMemo, useState } from 'react';
import { sessionsPageQuery, sessionsWindowPageQuery, type SessionEntry } from '../api/sessions';
import { KIN_QUERY, KINFOLK_QUERY, type Kin, type Kinfolk } from '../api/directory';
import { transitionBookingStatus } from '../api/bookingsWrite';
import {
  sessionState,
  sessionStateInfo,
  sessionHousehold,
  sessionWindow,
  sessionDayKey,
  sessionDayLabel,
  groupSessionsByDay,
  groupSessionsByPhase,
  localDateIso,
  FETCH_DAYS_BACK,
  UPCOMING_WINDOW_DAYS,
  SESSION_STATE_TONE,
  shiftDayIso,
  type SessionDayGroup,
  type SessionPhase,
  type SessionState,
} from '../lib/sessionFormat';
import { cardLifecycleActionsFor, lifecycleNowIso } from '../lib/sessionLifecycle';
import { useVisitLifecycle } from '../lib/useVisitLifecycle';
import { usePagedCollection } from '../lib/usePagedCollection';
import { useCollection } from '../lib/firestore';
import { str, arr } from '../lib/coerce';
import { directionsHref } from '../lib/directions';
import { DenScreenHeading, StatusPill, EmptyHint, ErrorHint } from '../components/DenScreenKit';
import { GhostButton, PrimaryButton } from '../components/Buttons';
import { Avatar } from '../components/Avatar';
import { Dialog } from '../components/Dialog';
import { AsyncRegion } from '../components/AsyncRegion';
import { VisitTrackingIndicator } from '../components/VisitTrackingIndicator';
import './Sessions.css';

/** Which body of data the screen is showing: the day-of board, or older history. */
type ViewMode = 'window' | 'archive';

/**
 * What an EMPTY phase group says, per phase.
 *
 * The count chip beside the heading already reads 0, so repeating "nothing here"
 * would be a line that is true of any empty list on any screen. What the chip
 * CANNOT say is what the group covers, and that is the question an operator
 * looking at four zeroes actually has: is Overdue empty because no visit has
 * slipped, or because the board is not looking that far back? Each line answers
 * that by naming the phase's own rule.
 */
const PHASE_EMPTY: Record<SessionPhase, string> = {
  active: 'No visit is in flight.',
  overdue: 'No scheduled visit has slipped past its slot.',
  upcoming: `Nothing booked in the next ${String(UPCOMING_WINDOW_DAYS)} days.`,
  recent: 'Nothing wrapped today or yesterday.',
};

interface SessionsProps {
  /**
   * Open one visit. REQUIRED, and the only way a card head opens anything since
   * #753: selecting a card navigates to `/sessions/{id}`, which
   * `routes/SessionsView.tsx` supplies. This screen no longer holds a detail of
   * its own, so a mount without this prop would draw 30 card heads that do
   * nothing (the `ControlShell` dead-control rule).
   */
  onSelect: (sessionId: string) => void;
  /**
   * Open the KinTale composer on this visit ("Complete KinTale" on a departed
   * card). Supplied by `routes/SessionsView.tsx`, which owns the navigation.
   * ABSENT means the button is not rendered at all, rather than rendered as a
   * control that does nothing (the `ControlShell` dead-control rule).
   */
  onComposeKinTale?: (sessionId: string) => void;
  /** Open one SENT KinTale ("View KinTale" on a completed card). Same absent-means-hidden rule. */
  onViewKinTale?: (kinTaleId: string) => void;
}

/**
 * Admin Auntie Time (nav slug `sessions`; `lib/nav.ts` is explicit that the rail
 * label and the slug are not the same word).
 *
 * WHAT THIS SCREEN IS, per `ui-ideas/auntieos-auntie-time-2026-05-27.html` and
 * the operator's ruling on it in #703 ("we are not following the correct ui for
 * this screen period"). It is a DAY-OF BOARD: four always-present phase groups
 * (Active / Overdue / Upcoming / Recent), each wearing a count chip, holding
 * ACTION CARDS the operator can run a visit from without leaving the page.
 *
 * WHAT IT IS NO LONGER, and why each piece went. It had grown into a filtered,
 * sortable, paged list, and every one of those controls is absent from the mock:
 *   stat strip        three cards plus a "these counts cover N visits" line. A
 *                     board whose four groups are counted has already said this,
 *                     and said it about the rows on screen rather than about the
 *                     size of the fetch.
 *   filter tabs       All / Active / Scheduled / Completed / Cancelled. The
 *                     phase groups ARE the split, and a tab that hides three of
 *                     them hides the board.
 *   Sort select       soonest / latest. A run sheet reads forwards.
 *   DenPanel wrapper  a "Kin Care sessions" panel around everything. The screen
 *                     heading already names the screen.
 * The Archive survives as a single ghost link in the heading, because older
 * history has to stay reachable and it is not day-of work.
 *
 * EMPTY PHASES NOW RENDER. `groupSessionsByPhase` used to drop them, which is
 * how the walk reached a frame reading "9 visits fetched" above one empty hint
 * and nothing else. Four headings with count chips, some of them 0, is an
 * answer; a blank page is not.
 *
 * THE CARDS HOST WRITES, which is the part that makes this more than a layout
 * change. The clock buttons go through `lib/useVisitLifecycle.ts`, the same hook
 * `SessionDetail` drives, so there is one implementation of the four in-visit
 * writes rather than two that can disagree. "Complete" goes through
 * `transitionBookingStatus` instead, because completing a visit is terminal and
 * billable and the server owns that state machine (the split
 * `api/sessionsWrite.ts` documents). Both refresh the page after a write that
 * changed something: `usePagedCollection` is a one-shot `getDocs`, so without
 * that a card would keep painting the status it was fetched with while offering
 * the transitions of that old state.
 *
 * SessionDetail is still one click away, from the card's own header, and it
 * remains the home of the details editor, the note to office, the full route map
 * and the Timing panel. The board is the run sheet; the sheet is the record.
 *
 * THE DETAIL IS A ROUTE NOW, NOT A VIEW OF THIS SCREEN (#753). "KinCares should
 * have their own id numbers in the params. I don't want to refresh the KinCare."
 * It used to open in local state here, so the URL never changed and a refresh, a
 * shared link or the browser Back button lost the open visit. A card head
 * navigates to `/sessions/{id}` instead, and `routes/SessionDetailView.tsx`
 * mounts SessionDetail over the same by-id subscription this screen used to run.
 * That is why nothing below reads `kin_care_sessions` by id any more.
 */
export function Sessions({ onSelect, onComposeKinTale, onViewKinTale }: SessionsProps) {
  const [mode, setMode] = useState<ViewMode>('window');

  // Computed once per render pass, not per keystroke/tick, same rationale as
  // Invoices.tsx's todayIso: "today" doesn't change mid-session.
  const todayIso = useMemo(() => localDateIso(new Date()), []);

  // The Archive's default range is the month immediately BEFORE the day-of
  // window's own fetch reaches, so opening it never re-shows what the board was
  // already showing.
  const [archiveFrom, setArchiveFrom] = useState(() =>
    shiftDayIso(todayIso, -(FETCH_DAYS_BACK + 30)),
  );
  const [archiveTo, setArchiveTo] = useState(() => shiftDayIso(todayIso, -(FETCH_DAYS_BACK + 1)));

  // One bounded, PAGED read either way. The spec is memoized on its inputs so a
  // re-render cannot churn the read (see CollectionSpec's own note, which the
  // paged hook inherits). Switching mode, or moving either archive bound, resets
  // the cursor and the page error, which is the hook's own contract: page two of
  // the day-of window must never append itself under the Archive's rows.
  const spec = useMemo(
    () =>
      mode === 'archive'
        ? sessionsPageQuery(archiveFrom, archiveTo)
        : sessionsWindowPageQuery(todayIso),
    [mode, archiveFrom, archiveTo, todayIso],
  );
  const { state: rows, hasMore, more, loadMore, reload } = usePagedCollection<SessionEntry>(spec);

  /**
   * THE TWO JOINS THE CARD NEEDS, both of them household-directory streams this
   * app already runs elsewhere (Directory, Gallery and Invoices read the same
   * two specs), not new queries invented here.
   *
   * `kinfolk` carries the SERVICE ADDRESS: the session document does not, and a
   * card whose whole job is getting an Auntie to a door has to show the door.
   * `kin` carries the PROFILE PHOTOS the mock stacks on a card.
   *
   * A read that has not landed, or a household with nothing on file, degrades to
   * the honest thing: no address line at all, and the status glyph in place of
   * the photo circles. Never a placeholder address and never a stock face, which
   * is the same rule `Avatar` already applies to a broken photo url.
   */
  const kinfolkState = useCollection<Kinfolk>(KINFOLK_QUERY);
  const kinState = useCollection<Kin>(KIN_QUERY);
  const addressById = useMemo(() => {
    const map = new Map<string, string>();
    if (kinfolkState.status !== 'ready') return map;
    for (const kf of kinfolkState.data) map.set(kf._id, str(kf.serviceAddress).trim());
    return map;
  }, [kinfolkState]);
  const kinById = useMemo(() => {
    const map = new Map<string, Kin>();
    if (kinState.status !== 'ready') return map;
    for (const k of kinState.data) map.set(k._id, k);
    return map;
  }, [kinState]);

  const cardContext: CardContext = {
    todayIso,
    addressById,
    kinById,
    onSelect,
    onWritten: reload,
    ...(onComposeKinTale ? { onComposeKinTale } : {}),
    ...(onViewKinTale ? { onViewKinTale } : {}),
  };

  return (
    <div className="screen">
      {/* The mock's own heading, paw and all, and with no italic accent tail:
          the Directory mock marks its last word up as `<b>`, this one does not,
          so the kit's optional accent stays off here. */}
      <DenScreenHeading
        kicker="The Den · Auntie Time"
        title="🐾 Auntie Time"
        subtitle={
          mode === 'archive'
            ? 'Older history, by day. Pick a range; the year shows on any day outside this one.'
            : 'Day-of view. Clock in, clock out, every Kin Care in flight.'
        }
        trailing={
          <GhostButton
            label={mode === 'archive' ? 'Back to Auntie Time' : 'Archive'}
            onClick={() => setMode(mode === 'archive' ? 'window' : 'archive')}
          />
        }
      />

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
        // The BOARD is never empty: four phase groups render whatever the data
        // says, so `isEmpty` is false there by construction and the "nothing on
        // the books" line rides UNDER the groups instead of replacing them. The
        // Archive is a plain list and keeps the ordinary empty state.
        isEmpty={(data) => mode === 'archive' && data.length === 0}
        loading={<p className="sessions__hint">Loading Kin Care sessions…</p>}
        empty={<EmptyHint>No Kin Cares in this range.</EmptyHint>}
      >
        {(data) => (
          <>
            {mode === 'archive' ? (
              <DayList days={groupSessionsByDay(data)} ctx={cardContext} />
            ) : (
              <>
                {/* NO `d1`..`d4` entrance on the groups, though the mock staggers
                    them: base.css fills those with `both`, which pins a transform on
                    the group forever, and a transformed ancestor becomes the
                    containing block of every `position: fixed` descendant. The
                    lifecycle confirms are `Dialog`s rendered inside the card, so the
                    stagger would clamp them inside the group instead of centring
                    them on the viewport. */}
                <ul className="sessions__phases">
                  {groupSessionsByPhase(data, todayIso).map((p) => (
                    <li key={p.phase} className={`sessions__phase sessions__phase--${p.phase}`}>
                      <h3 className="sessions__phase-header">
                        {p.label}
                        <span className="sessions__phase-count">{p.count}</span>
                      </h3>
                      {p.count === 0 ? (
                        <p className="sessions__phase-empty">{PHASE_EMPTY[p.phase]}</p>
                      ) : (
                        <ul className="sessions__cards">
                          {p.days.flatMap((d) =>
                            d.rows.map((entry) => (
                              <SessionCard key={entry._id} entry={entry} ctx={cardContext} />
                            )),
                          )}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>

                {/* Says where the rest of the book is, under a board that is
                    genuinely holding nothing. The four groups above have already
                    said each phase is empty; this says that is not a fault. */}
                {data.length === 0 && (
                  <p className="sessions__hint">
                    Nothing on the books in this window. Older visits are in the Archive.
                  </p>
                )}
              </>
            )}

            {/* A FAILED PAGE IS NOT A FAILED LIST. The visits above are still
                true, the cursor has not advanced, and the failure is reported
                beside them rather than replacing them. That is why this is an
                inline alert and not the AsyncRegion banner. */}
            {hasMore && (
              <div className="sessions__more">
                <GhostButton
                  label={more.status === 'loading' ? 'Loading more…' : 'Load more'}
                  onClick={loadMore}
                  disabled={more.status === 'loading'}
                />
                {more.status === 'error' && (
                  <p className="sessions__more-error" role="alert">
                    Couldn&rsquo;t load more Kin Care sessions. {more.message} The{' '}
                    {String(data.length)} already loaded are unaffected.
                    {more.retry && (
                      <button type="button" className="async-retry" onClick={more.retry}>
                        Retry
                      </button>
                    )}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </AsyncRegion>
    </div>
  );
}

/** Everything a card needs beyond its own row, passed down whole rather than one prop at a time. */
interface CardContext {
  todayIso: string;
  addressById: Map<string, string>;
  kinById: Map<string, Kin>;
  onSelect: (sessionId: string) => void;
  /** Re-runs the paged read after a write that changed the document. */
  onWritten: () => void;
  onComposeKinTale?: (sessionId: string) => void;
  onViewKinTale?: (kinTaleId: string) => void;
}

/** The Archive's day-grouped list, the one place a day header still earns its line. */
function DayList({ days, ctx }: { days: SessionDayGroup<SessionEntry>[]; ctx: CardContext }) {
  return (
    <ul className="sessions__list">
      {days.map((g) => (
        <li key={g.dayKeyValue} className="sessions__day-group">
          <h4 className="sessions__day-header">{sessionDayLabel(g.dayKeyValue, ctx.todayIso)}</h4>
          <ul className="sessions__cards">
            {g.rows.map((entry) => (
              <SessionCard key={entry._id} entry={entry} ctx={ctx} />
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/**
 * The glyph standing in for a visit with no kin photos to show, transcribed from
 * the mock's own `.sicon` tiles: an arrow for a visit under way, a clock face
 * for one still ahead, a tick for a wrap, a cross for a cancellation. The tile
 * takes the state's tone as well (`data-tone`, resolved by the kit's CSS), which
 * is how the mock tints an on-my-way tile orange and a completed one teal.
 *
 * Decorative: every card names its state in the status chip beside this, so the
 * tile is `aria-hidden` at the render site rather than given a second accessible
 * name that a screen reader would read out twice.
 */
const STATE_GLYPH: Record<SessionState, string> = {
  scheduled: '◷',
  onMyWay: '↗',
  arrived: '◉',
  departed: '↘',
  completed: '✓',
  cancelled: '✕',
  unknown: '?',
};

/** `err.message` when there is one, else a plain sentence. Never an empty string. */
function messageOf(err: unknown): string {
  return err instanceof Error && err.message !== '' ? err.message : 'Unknown error.';
}

/**
 * One visit as the mock's action card.
 *
 * THE HEADER IS ONE BUTTON AND THE ACTION ROW SITS OUTSIDE IT, deliberately: a
 * button inside a button is invalid HTML and browsers resolve it by dropping one
 * of them, which would make the inline lifecycle controls unclickable on exactly
 * the cards that need them most. The header opens the detail; the action row
 * acts.
 */
function SessionCard({ entry, ctx }: { entry: SessionEntry; ctx: CardContext }) {
  const { todayIso, addressById, kinById, onSelect, onWritten, onComposeKinTale, onViewKinTale } =
    ctx;
  const state = sessionState(str(entry.status));
  const info = sessionStateInfo(state);
  const household = sessionHousehold(str(entry.kinfolkName));
  const clock = useVisitLifecycle(entry._id, household, onWritten);

  // "Complete" is NOT a `setVisitLifecycle` action and so does not go through
  // the hook: completing a visit is terminal and billable, so it goes through
  // `transitionBookingStatus` like every other booking-status change, and the
  // server's refusal is what the operator reads.
  const [completing, setCompleting] = useState(false);
  const [completeAsked, setCompleteAsked] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);

  async function runComplete() {
    setCompleteAsked(false);
    setCompleting(true);
    setCompleteError(null);
    try {
      await transitionBookingStatus({
        sessionId: entry._id,
        action: 'COMPLETE',
        completedAt: lifecycleNowIso(),
      });
      onWritten();
    } catch (err) {
      setCompleteError(messageOf(err));
    } finally {
      setCompleting(false);
    }
  }

  // The mock's identity line: the service, the kin this visit covers, then when
  // it happens, as ONE line of dim text ("30 min · Biscuit & Gravy · 9:00 to
  // 9:30a"). It used to open with the kit's service pill; the mock draws no
  // pill on this line, so the service is a word in the sentence here. Blank
  // parts drop out rather than leaving a stranded separator, so a session with
  // no kin names reads "Dog Walk · Today · 09:00 to 10:00" instead of
  // "Dog Walk ·  · Today · ...".
  const kinNames = arr<string>(entry.kinNames)
    .map((n) => n.trim())
    .filter((n) => n !== '');
  const service = str(entry.serviceType).trim();
  const dayKeyValue = sessionDayKey(str(entry.startTime));
  const when = sessionWindow(str(entry.startTime), str(entry.endTime));
  const day = dayKeyValue === 'Undated' ? '' : sessionDayLabel(dayKeyValue, todayIso);
  // The board carries no day headers (the mock has none), so the day rides on
  // the card's own line. That is also what keeps the AO-18 local-day fix visible
  // here: the same `sessionDayKey` / `sessionDayLabel` pair the day headers used,
  // rendered per card instead.
  const whenLine = day === '' ? when : `${day} · ${when}`;
  const metaLine = [service, kinNames.join(' & '), whenLine].filter((p) => p !== '').join(' · ');

  const address = addressById.get(str(entry.kinfolkId)) ?? '';
  // What the FAMILY wrote about their own house first, the office's internal
  // note second. Truncated the way Android's card truncates it: a run sheet
  // shows enough to recognize the instruction, and the detail sheet has the rest.
  const rawNote = str(entry.kinfolkNotes).trim() || str(entry.notes).trim();
  const note = rawNote.length > 120 ? `${rawNote.slice(0, 120)}…` : rawNote;

  const kin = arr<string>(entry.kinIds)
    .map((id) => kinById.get(id))
    .filter((k): k is Kin => k !== undefined);
  const reportIds = arr<string>(entry.reportIds).filter((id) => id.trim() !== '');
  const firstReportId = reportIds[0];

  const clockActions = cardLifecycleActionsFor(state);
  // Transcribed from the mock card by card: Complete sits on the two states
  // BEFORE the Auntie has clocked in (its scheduled and on-my-way cards carry
  // it) and the write-up buttons take over from there. The server accepts
  // COMPLETE from all four pre-terminal states (`bookingTransitions.ts`), so
  // this is the mock narrowing an allowed set, never a guess at what will work.
  const offersComplete = state === 'scheduled' || state === 'onMyWay';
  const offersCompose = state === 'departed' && onComposeKinTale !== undefined;
  const offersView =
    state === 'completed' && firstReportId !== undefined && onViewKinTale !== undefined;
  const hasActions = clockActions.length > 0 || offersComplete || offersCompose || offersView;

  return (
    <li className={`sessions__card sessions__card--${info.cssClass}`}>
      <button type="button" className="sessions__card-head lift" onClick={() => onSelect(entry._id)}>
        {kin.length > 0 ? (
          <span className="sessions__photos">
            {kin.slice(0, 3).map((k) => (
              <Avatar
                key={k._id}
                className="sessions__photo"
                label={str(k.name) === '' ? 'Kin' : str(k.name)}
                imageUrl={k.profilePictureUrl}
                initials={str(k.name).slice(0, 2)}
                size={34}
              />
            ))}
          </span>
        ) : (
          <span className="sessions__glyph" data-tone={SESSION_STATE_TONE[state]} aria-hidden="true">
            {STATE_GLYPH[state]}
          </span>
        )}

        <span className="sessions__card-id">
          <span className="sessions__card-name">{household}</span>
          {metaLine !== '' && <span className="sessions__card-svc">{metaLine}</span>}
        </span>

        {/* The kit's capsule, in the state's tone, at the compact size the
            mock's `.pill` draws on a card row (9.5px, #780). Not struck through
            when cancelled: this mock draws its cancelled pill as the plain dim
            capsule, the same one the scheduled card wears. The wrapper span is
            the phone-width layout hook (Sessions.css moves it above the name). */}
        <span className="sessions__chip">
          <StatusPill label={info.chipLabel} tone={SESSION_STATE_TONE[state]} size="compact" />
        </span>
      </button>

      {/* Live only while the Auntie is inside the house. A DEPARTED visit has a
          finished route on the detail sheet, and claiming a live one here would
          be a claim about a phone that has stopped pinging. When THIS browser
          clocked the visit in (#772) the line says so, and says when it could
          not track; the mock's own line stands in when the phone is the tracker. */}
      {state === 'arrived' && (
        <VisitTrackingIndicator sessionId={entry._id} idleText="GPS tracking · live route" />
      )}

      {/* The mock's address chip is a control (pointer cursor, orange rim on
          hover), and on Android the same chip opens the maps app. Here it is
          the directions link the kinfolk profile already uses. */}
      {address !== '' && (
        <a className="sessions__addr" href={directionsHref(address)} target="_blank" rel="noopener">
          📍 {address}
        </a>
      )}
      {note !== '' && <p className="sessions__note">{note}</p>}
      {str(entry.invoiceId).trim() !== '' && <p className="sessions__invoice">Invoice linked</p>}

      {hasActions && (
        <div className="sessions__acts">
          {clockActions.map((a) =>
            a.tone === 'primary' ? (
              <PrimaryButton
                key={a.action}
                label={a.cardLabel}
                onClick={() => clock.ask(a)}
                disabled={clock.saving || completing}
              />
            ) : (
              <GhostButton
                key={a.action}
                label={a.cardLabel}
                // The mock's "↶ Undo arrived". Decorative: the button's
                // `leading` slot is aria-hidden, so the name stays the label.
                leading={a.action === 'UNDO_ARRIVAL' ? <span>↶</span> : undefined}
                onClick={() => clock.ask(a)}
                disabled={clock.saving || completing}
              />
            ),
          )}
          {offersComplete && (
            <GhostButton
              label="Complete"
              onClick={() => setCompleteAsked(true)}
              disabled={clock.saving || completing}
            />
          )}
          {/* The mock's one teal button (`.btn.teal`): the write-up is a different
              kind of step from the clock, and it wears the KinTale hue rather
              than brand orange. `sessions__btn--teal` recolours the kit button;
              Buttons has no tone prop and this is its only caller. */}
          {offersCompose && onComposeKinTale !== undefined && (
            <PrimaryButton
              label="Complete KinTale"
              leading={<span>✈</span>}
              className="sessions__btn--teal"
              onClick={() => onComposeKinTale(entry._id)}
            />
          )}
          {offersView && onViewKinTale !== undefined && firstReportId !== undefined && (
            <GhostButton label="View KinTale" onClick={() => onViewKinTale(firstReportId)} />
          )}
        </div>
      )}

      {clock.write.status === 'error' && (
        <ErrorHint>Couldn&rsquo;t update the visit clock. {clock.write.message}</ErrorHint>
      )}
      {clock.write.status === 'done' && (
        <p className="sessions__ok" role="status">
          {clock.write.message}
        </p>
      )}
      {completeError !== null && (
        <ErrorHint>Couldn&rsquo;t complete this visit. {completeError}</ErrorHint>
      )}

      {clock.pending !== null && (
        <Dialog
          title={clock.pending.label}
          onClose={clock.dismiss}
          footer={
            <>
              <GhostButton label="Not yet" onClick={clock.dismiss} />
              <PrimaryButton label={clock.pending.confirmLabel} onClick={clock.confirm} />
            </>
          }
        >
          {/* Future tense, and a confirm label the operator has not already
              pressed once: the BookingActions confirm-copy rule. The gate is
              here and not only on the detail sheet because these writes notify a
              household, and a mis-tap on a dense board is easier than one on a
              sheet with a single action row. */}
          <p>{clock.pending.confirmBody(household)}</p>
        </Dialog>
      )}

      {completeAsked && (
        <Dialog
          title="Mark this visit completed?"
          onClose={() => setCompleteAsked(false)}
          footer={
            <>
              <GhostButton label="Not yet" onClick={() => setCompleteAsked(false)} />
              <PrimaryButton label="Yes, mark it completed" onClick={() => void runComplete()} />
            </>
          }
        >
          {/* Where the card GOES is stated, because it moves: a visit completed
              today is a wrap from today, so it lands in Recent rather than
              leaving the board. */}
          <p>
            {household}&rsquo;s visit will be marked Completed and move to Recent. It is billable
            from that point.
          </p>
        </Dialog>
      )}
    </li>
  );
}
