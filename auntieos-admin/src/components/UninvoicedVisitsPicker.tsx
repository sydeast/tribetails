import { useCallback, useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { listUninvoicedSessions, setSessionDoNotInvoice } from '../api/invoicesWrite';
import type {
  ListUninvoicedSessionsResult,
  ListUninvoicedSessionsResultSession,
} from '../contracts/invoiceContracts.generated';
import { formatCentsUsd } from '../lib/invoiceReconcile';
import { humanizeDate, localDateIso } from '../lib/invoiceFormat';
import { Banner } from './Banner';
import { PrimaryButton, GhostButton } from './Buttons';
import './UninvoicedVisitsPicker.css';

/**
 * A household's un-invoiced work, and the two things that can be done with it.
 *
 * CREATING AN INVOICE IS AN ACT OF SELECTION OVER WORK THAT ALREADY EXISTS, NOT
 * AN ACT OF DESCRIPTION (issue #408). This panel is that selection. It opens as
 * soon as a household is chosen, with no date range to guess at and no separate
 * "find" step: the work is simply there, all of it, and the interaction is
 * unticking whatever this invoice should not cover.
 *
 * IT USED TO ASK FOR A DATE RANGE, defaulted to the last thirty days, and so
 * made the operator already know when the work happened in order to bill it. A
 * visit from five weeks ago produced a perfectly worded "no un-invoiced visits
 * in this window" and no hint that a wider one would find it. The range now
 * appears only when the server says its page cap was actually reached, which is
 * the one situation where narrowing helps.
 *
 * THE ONE RULE THIS COMPONENT HAS ALWAYS EXISTED TO ENFORCE: A VISIT THE RATE
 * CARD COULD NOT PRICE ARRIVES WITH `unitCents: null`, AND NULL IS NOT ZERO.
 * `listUninvoicedSessions` refuses to guess. A `serviceType` the rate card does
 * not hold, a rate that will not parse, and a rate of zero all come back as null
 * plus an entry in `unpriceable`, because a silent 0 would bill a household
 * nothing for real work and would look entirely deliberate on the finished
 * invoice. So an unpriced visit is selectable and shows an EMPTY price field the
 * operator has to fill in, and it says so on the row. It never seeds 0.00, and
 * it never quietly drops the visit either, because not billing for completed
 * work is the same loss by a different route.
 *
 * A PRICED VISIT'S MONEY IS NOT TYPEABLE HERE, and that is the #408 ruling on
 * bound lines: the price comes from the rate card by way of the visit, so the
 * way to change it is to change one of those, not to type over the invoice. The
 * row routes to the visit instead. A price field appears only where there is no
 * price for it to disagree with.
 *
 * `rateCardLoaded` separates "this service is not on the card" from "there is no
 * card at all". Those need different sentences: the second is a settings problem
 * the operator should go fix once, not a per-visit annoyance to work around
 * every time.
 */

interface UninvoicedVisitsPickerProps {
  /** Whose work to show. Blank renders nothing; the composer asks first. */
  kinfolkId: string;
  /** How this household is named, for copy that says who rather than "this household". */
  householdLabel: string;
  /** The visits currently on the invoice. */
  selected: ReadonlySet<string>;
  onSelectedChange: (next: ReadonlySet<string>) => void;
  /** Typed prices for visits the rate card could not price, keyed by session id. */
  prices: Readonly<Record<string, string>>;
  onPriceChange: (sessionId: string, text: string) => void;
  /** Every billable visit currently loaded, so the composer can build its lines. */
  onSessionsLoaded: (sessions: readonly ListUninvoicedSessionsResultSession[]) => void;
  /** Locks the panel while the invoice is being created. */
  disabled?: boolean;
  /** Offered when this household has nothing to bill from. */
  onWriteBlankInvoice: () => void;
}

/** Today and 30 days ago as YYYY-MM-DD: the narrowing window's opening values. */
function defaultWindow(now: Date): { from: string; to: string } {
  const to = localDateIso(now);
  const past = new Date(now.getTime());
  past.setDate(past.getDate() - 30);
  return { from: localDateIso(past), to };
}

/** How a visit reads on an invoice line: the service, and the day it happened. */
export function visitLineDescription(session: ListUninvoicedSessionsResultSession): string {
  const label = session.serviceType.trim() === '' ? 'Visit' : session.serviceType.trim();
  const day = session.startTime.slice(0, 10);
  return day === '' ? label : `${label}, ${day}`;
}

export function UninvoicedVisitsPicker({
  kinfolkId,
  householdLabel,
  selected,
  onSelectedChange,
  prices,
  onPriceChange,
  onSessionsLoaded,
  disabled = false,
  onWriteBlankInvoice,
}: UninvoicedVisitsPickerProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ListUninvoicedSessionsResult | null>(null);
  const [narrowed, setNarrowed] = useState<{ from: string; to: string } | null>(null);
  const [window, setWindow] = useState(() => defaultWindow(new Date()));
  // The do-not-invoice confirm step, and the note that goes with it. Armed
  // rather than immediate: it is a decision not to charge for real work, and it
  // is worth the half-second the reason field takes to read.
  const [excluding, setExcluding] = useState(false);
  const [excludeReason, setExcludeReason] = useState('');
  const [excludeError, setExcludeError] = useState<string | null>(null);
  const [excludeBusy, setExcludeBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (win: { from: string; to: string } | null) => {
      if (kinfolkId === '') return;
      setLoading(true);
      setError(null);
      try {
        const res = await listUninvoicedSessions(kinfolkId, win ?? undefined);
        setResult(res);
        // EVERY BILLABLE VISIT STARTS SELECTED. The ordinary invoice covers all
        // of a household's outstanding work; unticking two is less work than
        // ticking eleven, and the count is stated on the button either way.
        onSelectedChange(new Set(res.sessions.map((s) => s.sessionId)));
        onSessionsLoaded(res.sessions);
        setLoading(false);
      } catch (caught) {
        setLoading(false);
        setResult(null);
        onSessionsLoaded([]);
        setError(
          `listUninvoicedSessions failed: ${caught instanceof Error ? caught.message : 'Could not load this work'}`,
        );
      }
    },
    [kinfolkId, onSelectedChange, onSessionsLoaded],
  );

  // THE HOUSEHOLD IS THE QUERY. Changing it reloads; there is no Find button,
  // because there is no second question to answer.
  useEffect(() => {
    setNarrowed(null);
    setNotice(null);
    setExcluding(false);
    void load(null);
    // Deliberately keyed on the household alone. Reloading a narrowed window is
    // the narrowing control's job, and listing `load` here would re-fire this
    // whole reset on every render that changes the composer's selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kinfolkId]);

  const sessions = result?.sessions ?? [];
  const excluded = result?.excluded ?? [];
  const unpriceableIds = new Set((result?.unpriceable ?? []).map((u) => u.sessionId));
  const unplaceable = result?.unplaceable ?? [];
  const selectedSessions = sessions.filter((s) => selected.has(s.sessionId));

  function toggle(sessionId: string) {
    const next = new Set(selected);
    if (next.has(sessionId)) next.delete(sessionId);
    else next.add(sessionId);
    onSelectedChange(next);
  }

  async function applyExclusion(sessionIds: readonly string[], doNotInvoice: boolean, reason: string) {
    if (excludeBusy) return;
    setExcludeBusy(true);
    setExcludeError(null);
    try {
      const res = await setSessionDoNotInvoice(sessionIds, doNotInvoice, reason);
      setExcludeBusy(false);
      setExcluding(false);
      setExcludeReason('');
      const count = res.changed.length;
      setNotice(
        doNotInvoice
          ? `${count === 1 ? '1 visit is' : `${String(count)} visits are`} marked do not invoice, and off this list until you put ${count === 1 ? 'it' : 'them'} back.`
          : `${count === 1 ? '1 visit is' : `${String(count)} visits are`} back in this household's un-invoiced work.`,
      );
      await load(narrowed);
    } catch (caught) {
      setExcludeBusy(false);
      setExcludeError(
        `setSessionDoNotInvoice failed: ${caught instanceof Error ? caught.message : 'Nothing was changed'}`,
      );
    }
  }

  if (kinfolkId === '') return null;

  return (
    <div className="visit-picker">
      {loading && (
        <p className="visit-picker__scope" role="status">
          Looking for un-invoiced work for {householdLabel}…
        </p>
      )}

      {error && (
        <Banner tone="error" title="Couldn't load this work">
          {error}{' '}
          <GhostButton label="Try again" onClick={() => void load(narrowed)} disabled={loading} />
        </Banner>
      )}

      {notice && (
        <Banner tone="info" title="Done">
          {notice}
        </Banner>
      )}

      {excludeError && (
        <Banner tone="error" title="Couldn't change those visits">
          {excludeError}
        </Banner>
      )}

      {result !== null && !loading && (
        <>
          {/* "There is no rate card" is a settings problem to fix once, not a
              per-visit annoyance. It gets its own sentence for that reason. */}
          {!result.rateCardLoaded && (
            <Banner tone="warning" title="No rate card">
              Business settings has no service rates, so nothing below could be priced automatically.
              Every visit you bill will need a price typed in. Setting the rates up once will prefill
              this in future.
            </Banner>
          )}

          {result.truncated && (
            <Banner tone="warning" title="More visits than fit">
              This household has more un-invoiced visits than one page holds, so the list below may
              not be all of them. Narrow the dates to be sure you are seeing everything.
            </Banner>
          )}

          {/* Changing the dates cannot surface these, so the banner says what to
              do instead of implying a different window would help. */}
          {unplaceable.length > 0 && (
            <Banner tone="warning" title="Visits with no start time">
              {unplaceable.length === 1
                ? '1 completed visit for this household has no start time'
                : `${String(unplaceable.length)} completed visits for this household have no start time`}
              , so nothing can place {unplaceable.length === 1 ? 'it' : 'them'} in time and{' '}
              {unplaceable.length === 1 ? 'it' : 'they'} cannot be billed from this screen. Fix the
              start time on the visit itself, then reopen this. Visit{' '}
              {unplaceable.length === 1 ? 'id' : 'ids'}: {unplaceable.map((u) => u.sessionId).join(', ')}
            </Banner>
          )}

          {(result.truncated || narrowed !== null) && (
            <div className="visit-picker__window">
              <label className="visit-picker__field">
                <span className="visit-picker__label">Visits from</span>
                <input
                  type="date"
                  className="visit-picker__input"
                  value={window.from}
                  onChange={(e) => setWindow((w) => ({ ...w, from: e.target.value }))}
                  disabled={loading || disabled}
                  aria-label="Window start date"
                />
              </label>
              <label className="visit-picker__field">
                <span className="visit-picker__label">to</span>
                <input
                  type="date"
                  className="visit-picker__input"
                  value={window.to}
                  onChange={(e) => setWindow((w) => ({ ...w, to: e.target.value }))}
                  disabled={loading || disabled}
                  aria-label="Window end date"
                />
              </label>
              <PrimaryButton
                label="Narrow the dates"
                onClick={() => {
                  if (window.from > window.to) {
                    setError('The start of the window must not be after its end.');
                    return;
                  }
                  setNarrowed(window);
                  void load(window);
                }}
                disabled={loading || disabled}
                busy={loading}
              />
              {narrowed !== null && (
                <GhostButton
                  label="Show everything again"
                  onClick={() => {
                    setNarrowed(null);
                    void load(null);
                  }}
                  disabled={loading || disabled}
                />
              )}
            </div>
          )}

          <p className="visit-picker__scope" role="status">
            {sessions.length === 0
              ? `No un-invoiced completed visits for ${householdLabel}${narrowed ? ` between ${narrowed.from} and ${narrowed.to}` : ''}. ${String(result.scanned)} visits were checked.`
              : `${String(selectedSessions.length)} of ${String(sessions.length)} un-invoiced visit${sessions.length === 1 ? '' : 's'} selected for ${householdLabel}${narrowed ? ` between ${narrowed.from} and ${narrowed.to}` : ''}.`}
          </p>

          {sessions.length === 0 ? (
            <div className="visit-picker__actions">
              <GhostButton
                label="Write a blank invoice instead"
                onClick={onWriteBlankInvoice}
                disabled={disabled}
              />
            </div>
          ) : (
            <>
              <div className="visit-picker__actions visit-picker__actions--start">
                <GhostButton
                  label="Select all"
                  onClick={() => onSelectedChange(new Set(sessions.map((s) => s.sessionId)))}
                  disabled={disabled || selectedSessions.length === sessions.length}
                />
                <GhostButton
                  label="Select none"
                  onClick={() => onSelectedChange(new Set())}
                  disabled={disabled || selectedSessions.length === 0}
                />
              </div>

              <ul className="visit-picker__list">
                {sessions.map((s) => {
                  const unpriced = s.unitCents === null;
                  const isSelected = selected.has(s.sessionId);
                  return (
                    <li key={s.sessionId} className="visit-picker__row">
                      <label className="visit-picker__row-label">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggle(s.sessionId)}
                          disabled={disabled}
                          aria-label={`Bill ${s.serviceType || 'visit'} on ${s.startTime.slice(0, 10)}`}
                        />
                        <span className="visit-picker__row-main">
                          <span className="visit-picker__row-service">{s.serviceType || 'Visit'}</span>
                          <span className="visit-picker__row-meta">
                            {humanizeDate(s.startTime.slice(0, 10), localDateIso(new Date()))}
                            {s.durationMinutes > 0 ? ` · ${String(s.durationMinutes)} min` : ''}
                          </span>
                        </span>
                        {/* NEVER "$0.00" for an unpriced visit. A zero here is
                            indistinguishable from a service genuinely given
                            away, and it would ride onto the invoice looking
                            deliberate. */}
                        {unpriced ? (
                          <span className="visit-picker__price visit-picker__price--none">
                            {unpriceableIds.has(s.sessionId) && result.rateCardLoaded
                              ? 'not on the rate card'
                              : 'needs a price'}
                          </span>
                        ) : (
                          <span className="visit-picker__price">{formatCentsUsd(s.unitCents!)}</span>
                        )}
                      </label>
                      <div className="visit-picker__row-tail">
                        {unpriced && isSelected && (
                          <label className="visit-picker__field">
                            <span className="visit-picker__label">Price for this visit ($)</span>
                            <input
                              className="visit-picker__input"
                              inputMode="decimal"
                              value={prices[s.sessionId] ?? ''}
                              onChange={(e) => onPriceChange(s.sessionId, e.target.value)}
                              disabled={disabled}
                              aria-label={`Price for ${s.serviceType || 'visit'} on ${s.startTime.slice(0, 10)}`}
                            />
                          </label>
                        )}
                        {/* The affordance the #408 ruling asks for: the money on
                            a priced visit is not typed over here. It is
                            corrected on the visit, and the invoice follows. */}
                        <Link
                          className="visit-picker__visit-link"
                          to="/sessions"
                          search={{ sessionId: s.sessionId }}
                        >
                          Open this visit
                        </Link>
                      </div>
                    </li>
                  );
                })}
              </ul>

              {excluding ? (
                <div className="visit-picker__exclude">
                  <p className="visit-picker__scope">
                    {selectedSessions.length === 1
                      ? 'This visit leaves the un-invoiced list without being billed. You can put it back.'
                      : `These ${String(selectedSessions.length)} visits leave the un-invoiced list without being billed. You can put them back.`}
                  </p>
                  <label className="visit-picker__field">
                    <span className="visit-picker__label">Why, optional</span>
                    <input
                      className="visit-picker__input"
                      value={excludeReason}
                      onChange={(e) => setExcludeReason(e.target.value)}
                      disabled={excludeBusy}
                      aria-label="Why this work is not being invoiced"
                    />
                  </label>
                  <div className="visit-picker__actions">
                    <GhostButton
                      label="Keep them billable"
                      onClick={() => {
                        setExcluding(false);
                        setExcludeReason('');
                      }}
                      disabled={excludeBusy}
                    />
                    <PrimaryButton
                      label={
                        excludeBusy ? 'Marking…' : `Mark ${String(selectedSessions.length)} do not invoice`
                      }
                      onClick={() =>
                        void applyExclusion(selectedSessions.map((s) => s.sessionId), true, excludeReason)
                      }
                      disabled={excludeBusy}
                      busy={excludeBusy}
                    />
                  </div>
                </div>
              ) : (
                <div className="visit-picker__actions visit-picker__actions--start">
                  <GhostButton
                    label={
                      selectedSessions.length === 0
                        ? 'Select visits to mark do not invoice'
                        : `Do not invoice ${String(selectedSessions.length)} selected`
                    }
                    onClick={() => setExcluding(true)}
                    disabled={disabled || selectedSessions.length === 0}
                  />
                </div>
              )}
            </>
          )}

          {excluded.length > 0 && (
            <div className="visit-picker__excluded">
              <p className="visit-picker__scope">
                {excluded.length === 1
                  ? '1 completed visit is marked do not invoice, so it is not on the list above.'
                  : `${String(excluded.length)} completed visits are marked do not invoice, so they are not on the list above.`}
              </p>
              <ul className="visit-picker__list">
                {excluded.map((e) => (
                  <li key={e.sessionId} className="visit-picker__row">
                    <div className="visit-picker__row-label">
                      <span className="visit-picker__row-main">
                        <span className="visit-picker__row-service">{e.serviceType || 'Visit'}</span>
                        <span className="visit-picker__row-meta">
                          {e.startTime.slice(0, 10) === ''
                            ? 'no start time'
                            : humanizeDate(e.startTime.slice(0, 10), localDateIso(new Date()))}
                          {e.reason === '' ? '' : ` · ${e.reason}`}
                        </span>
                      </span>
                      <GhostButton
                        label="Put it back"
                        onClick={() => void applyExclusion([e.sessionId], false, '')}
                        disabled={disabled || excludeBusy}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
