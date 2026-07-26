import { useCallback, useState } from 'react';
import {
  listUninvoicedSessions,
  type UninvoicedSession,
  type UninvoicedSessionsResult,
} from '../api/invoicesWrite';
import { formatCentsUsd } from '../lib/invoiceReconcile';
import { centsToInputDollars } from '../lib/invoiceMoneyInput';
import { humanizeDate, localDateIso } from '../lib/invoiceFormat';
import { blankDraftLine, type DraftLine } from './InvoiceLineItems';
import { Banner } from './Banner';
import { PrimaryButton, GhostButton } from './Buttons';
import './UninvoicedVisitsPicker.css';

/**
 * Turn completed visits nobody has billed yet into invoice line items.
 *
 * THE ONE RULE THIS COMPONENT EXISTS TO ENFORCE: A VISIT THE RATE CARD COULD NOT
 * PRICE ARRIVES WITH `unitCents: null`, AND NULL IS NOT ZERO.
 *
 * `listUninvoicedSessions` deliberately refuses to guess. A `serviceType` the
 * rate card does not hold, a rate that will not parse, and a rate of zero all
 * come back as null plus an entry in `unpriceable`, because a silent 0 would
 * bill a household nothing for real work and would look entirely deliberate on
 * the finished invoice. This picker honours that: an unpriced visit is selectable
 * but produces a line with an EMPTY unit-price field the operator has to type
 * into, and it says so on the row. It never seeds 0.00, and it never quietly
 * drops the visit either, because not billing for completed work is the same
 * loss by a different route.
 *
 * `rateCardLoaded` separates "this service is not on the card" from "there is no
 * card at all". Those need different sentences: the second is a settings problem
 * the operator should go fix once, not a per-visit annoyance to work around
 * every time.
 */

interface UninvoicedVisitsPickerProps {
  /** Only visits for this household are offered. Blank disables the picker. */
  kinfolkId: string;
  /** Called with the new draft lines and the session ids they came from. */
  onAdd: (lines: DraftLine[], sessionIds: string[]) => void;
  onClose: () => void;
}

/** A visit turned into a draft line. The unit price is BLANK when it could not be priced. */
export function draftFromSession(session: UninvoicedSession): DraftLine {
  const hours = session.durationMinutes > 0 ? session.durationMinutes / 60 : 0;
  const label = session.serviceType.trim() === '' ? 'Visit' : session.serviceType.trim();
  const dateLabel = session.startTime.slice(0, 10);
  return {
    ...blankDraftLine(),
    description: dateLabel === '' ? label : `${label}, ${dateLabel}`,
    // Quantity is ONE VISIT, not a duration. The rate card is keyed by service
    // name and priced per service, so multiplying by hours would silently
    // multiply the bill. Duration is shown on the row as context for the
    // operator, never folded into the arithmetic.
    qtyText: '1',
    // THE POINT OF THE WHOLE COMPONENT. Blank, not "0.00", when the rate card
    // could not price this visit.
    unitText: session.unitCents === null ? '' : centsToInputDollars(session.unitCents),
    discountText: '',
    ...(hours > 0 ? {} : {}),
  };
}

/** Today and 30 days ago as YYYY-MM-DD, the window the picker opens on. */
function defaultWindow(now: Date): { from: string; to: string } {
  const to = localDateIso(now);
  const past = new Date(now.getTime());
  past.setDate(past.getDate() - 30);
  return { from: localDateIso(past), to };
}

export function UninvoicedVisitsPicker({ kinfolkId, onAdd, onClose }: UninvoicedVisitsPickerProps) {
  const initial = defaultWindow(new Date());
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UninvoicedSessionsResult | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  // Only this household's visits. The callable is not scoped by household (it
  // windows by date across the collection), so the narrowing happens here, and
  // the panel says that the count it shows is after that narrowing.
  const forHousehold = (result?.sessions ?? []).filter((s) => s.kinfolkId === kinfolkId);
  const unpriceableIds = new Set((result?.unpriceable ?? []).map((u) => u.sessionId));
  const selectedUnpriced = forHousehold.filter((s) => selected.has(s.sessionId) && s.unitCents === null);

  const load = useCallback(async () => {
    if (loading) return;
    if (from > to) {
      setError('The start of the window must not be after its end.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await listUninvoicedSessions(from, to);
      setResult(res);
      setSelected(new Set());
      setLoading(false);
    } catch (caught) {
      setLoading(false);
      setResult(null);
      setError(
        `listUninvoicedSessions failed: ${caught instanceof Error ? caught.message : 'Could not load visits'}`,
      );
    }
  }, [from, to, loading]);

  function toggle(sessionId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  function addSelected() {
    const chosen = forHousehold.filter((s) => selected.has(s.sessionId));
    onAdd(chosen.map(draftFromSession), chosen.map((s) => s.sessionId));
  }

  return (
    <div className="visit-picker">
      <div className="visit-picker__window">
        <label className="visit-picker__field">
          <span className="visit-picker__label">Visits from</span>
          <input
            type="date"
            className="visit-picker__input"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            disabled={loading}
            aria-label="Window start date"
          />
        </label>
        <label className="visit-picker__field">
          <span className="visit-picker__label">to</span>
          <input
            type="date"
            className="visit-picker__input"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            disabled={loading}
            aria-label="Window end date"
          />
        </label>
        <PrimaryButton
          label={loading ? 'Looking…' : 'Find visits'}
          onClick={() => void load()}
          disabled={loading || kinfolkId === ''}
          busy={loading}
        />
      </div>

      {kinfolkId === '' && (
        <p className="visit-picker__hint">Pick a household first, then search for its un-invoiced visits.</p>
      )}

      {error && (
        <Banner tone="error" title="Couldn't load visits">
          {error}
        </Banner>
      )}

      {result !== null && (
        <>
          {/* "There is no rate card" is a settings problem to fix once, not a
              per-visit annoyance. It gets its own sentence for that reason. */}
          {!result.rateCardLoaded && (
            <Banner tone="warning" title="No rate card">
              Business settings has no service rates, so nothing below could be priced automatically.
              Every visit you add will need a price typed in. Setting the rates up once will prefill
              this in future.
            </Banner>
          )}

          {result.truncated && (
            <Banner tone="warning" title="More visits than fit">
              This window hit the server's page limit, so there may be visits it did not return.
              Narrow the dates to be sure you are seeing everything.
            </Banner>
          )}

          <p className="visit-picker__scope" role="status">
            {forHousehold.length === 0
              ? `No un-invoiced completed visits for this household between ${from} and ${to}. ${String(result.scanned)} visits were checked.`
              : `${String(forHousehold.length)} un-invoiced completed visit${forHousehold.length === 1 ? '' : 's'} for this household, out of ${String(result.scanned)} checked in the window.`}
          </p>

          {forHousehold.length > 0 && (
            <ul className="visit-picker__list">
              {forHousehold.map((s) => {
                const unpriced = s.unitCents === null;
                return (
                  <li key={s.sessionId} className="visit-picker__row">
                    <label className="visit-picker__row-label">
                      <input
                        type="checkbox"
                        checked={selected.has(s.sessionId)}
                        onChange={() => toggle(s.sessionId)}
                        aria-label={`Select ${s.serviceType || 'visit'} on ${s.startTime.slice(0, 10)}`}
                      />
                      <span className="visit-picker__row-main">
                        <span className="visit-picker__row-service">{s.serviceType || 'Visit'}</span>
                        <span className="visit-picker__row-meta">
                          {humanizeDate(s.startTime.slice(0, 10), localDateIso(new Date()))}
                          {s.durationMinutes > 0 ? ` · ${String(s.durationMinutes)} min` : ''}
                        </span>
                      </span>
                      {/* NEVER "$0.00" for an unpriced visit. A zero here is
                          indistinguishable from a service genuinely given away,
                          and it would ride onto the invoice looking deliberate. */}
                      <span className={unpriced ? 'visit-picker__price visit-picker__price--none' : 'visit-picker__price'}>
                        {unpriced
                          ? unpriceableIds.has(s.sessionId) && result.rateCardLoaded
                            ? 'not on the rate card'
                            : 'needs a price'
                          : formatCentsUsd(s.unitCents!)}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          {selectedUnpriced.length > 0 && (
            <Banner tone="warning" title="Some of these need a price">
              {selectedUnpriced.length === 1
                ? 'One of the visits you picked has no rate on file. It will be added with an empty unit price for you to fill in, and the invoice cannot be saved until you do.'
                : `${String(selectedUnpriced.length)} of the visits you picked have no rate on file. They will be added with empty unit prices for you to fill in, and the invoice cannot be saved until you do.`}
            </Banner>
          )}

          <div className="visit-picker__actions">
            <GhostButton label="Cancel" onClick={onClose} />
            <PrimaryButton
              label={
                selected.size === 0
                  ? 'Add visits'
                  : `Add ${String(selected.size)} visit${selected.size === 1 ? '' : 's'}`
              }
              onClick={addSelected}
              disabled={selected.size === 0}
            />
          </div>
        </>
      )}
    </div>
  );
}
