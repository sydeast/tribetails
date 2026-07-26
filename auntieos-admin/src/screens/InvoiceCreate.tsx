import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { KINFOLK_QUERY, kinfolkDisplayName, type Kinfolk } from '../api/directory';
import { createInvoice, createQuote, type NewInvoiceInput } from '../api/invoicesWrite';
import { useCollection } from '../lib/firestore';
import { computeInvoiceTotals } from '../lib/invoiceMath';
import { centsToDollars } from '../lib/invoiceMath';
import { formatCentsUsd } from '../lib/invoiceReconcile';
import { Dialog } from '../components/Dialog';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { Toggle } from '../components/Toggle';
import { Banner } from '../components/Banner';
import {
  InvoiceLineItemsEditor,
  parseDraftLines,
  type DraftLine,
} from '../components/InvoiceLineItems';
import { UninvoicedVisitsPicker } from '../components/UninvoicedVisitsPicker';
import './InvoiceCreate.css';

export type InvoiceCreateMode = 'invoice' | 'quote';

interface InvoiceCreateProps {
  mode: InvoiceCreateMode;
  onClose: () => void;
  /** Called with the new invoice id once the create callable resolves, before onClose. */
  onCreated?: (invoiceId: string) => void;
  /**
   * Pre-selects the household picker. Set when the composer was opened FOR a
   * household rather than from a blank "New quote" button, e.g. the
   * Notifications feed's Create quote action, which routes here as
   * `/invoices?composeQuoteForKinfolkId=<id>`.
   *
   * Only the INITIAL value: the operator can still change the household, and
   * doing so is not undone by a re-render.
   */
  seedKinfolkId?: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Ports NewInvoiceDialog.kt's daysInMonth `when`, February kept at the leap-safe 29. */
const DAYS_IN_MONTH: Readonly<Record<number, number>> = {
  1: 31,
  2: 29,
  3: 31,
  4: 30,
  5: 31,
  6: 30,
  7: 31,
  8: 31,
  9: 30,
  10: 31,
  11: 30,
  12: 31,
};

/**
 * A YYYY-MM-DD that parses to a real calendar date. Ports
 * NewInvoiceDialog.kt's `isValidNewInvoiceIsoDate` verbatim (including the
 * always-permit-Feb-29 simplification the Kotlin source itself makes).
 */
export function isValidInvoiceDate(value: string): boolean {
  const s = value.trim();
  if (!ISO_DATE_RE.test(s)) return false;
  const month = Number(s.slice(5, 7));
  const day = Number(s.slice(8, 10));
  if (month < 1 || month > 12) return false;
  const max = DAYS_IN_MONTH[month] ?? 31;
  return day >= 1 && day <= max;
}

export interface InvoiceCreateFormValues {
  kinfolkId: string;
  invoiceNumber: string;
  totalText: string;
  amountDueText: string;
  date: string;
  dueDate: string;
}

/**
 * Pure, unit-tested validation. Ports NewInvoiceDialog.kt's `validateNewInvoice`:
 * same five checks, same order, same messages.
 */
export function validateInvoiceCreate(v: InvoiceCreateFormValues): string | null {
  const total = Number(v.totalText);
  const amountDue = Number(v.amountDueText);
  if (v.kinfolkId.trim() === '') return 'Pick a household for this invoice';
  if (v.invoiceNumber.trim() === '') return 'Invoice number is required';
  if (v.totalText.trim() === '' || Number.isNaN(total) || total < 0) return 'Total must be zero or greater';
  if (v.amountDueText.trim() === '' || Number.isNaN(amountDue) || amountDue < 0)
    return 'Amount due must be zero or greater';
  if (v.date.trim() !== '' && !isValidInvoiceDate(v.date)) return 'Date must be a real YYYY-MM-DD date';
  if (v.dueDate.trim() !== '' && !isValidInvoiceDate(v.dueDate)) return 'Due date must be a real YYYY-MM-DD date';
  return null;
}

/**
 * New-invoice / new-quote composer. Mirrors the wasm's NewInvoiceDialog.kt:
 * a household picker fed by the live `kinfolk` stream, the same field set,
 * the same client-side validation, then routes to createInvoice or
 * createQuote (never a third code path) depending on `mode`.
 *
 * Fail-loud: a rejected callable renders inline via Banner and leaves the
 * dialog open with the form intact, never a silent close. Every field is
 * disabled while submitting (never a double-submit), and the primary button
 * carries Buttons.tsx's `busy` state.
 */
/**
 * How this invoice's money is being decided.
 *
 *   flat      the operator types a total, as they always have. The legacy path,
 *             and still the right one for a bill that is not itemized.
 *   itemized  the total is DERIVED from line items and there is nowhere to type
 *             one, so the invoice cannot claim a figure the work does not
 *             support.
 *
 * Two paths rather than one because both are legitimate. Forcing itemization
 * would make the composer refuse the quick one-off bill it exists to write, and
 * dropping the flat path would strand every workflow that predates 5.1.
 */
export type InvoiceMoneyMode = 'flat' | 'itemized';

export function InvoiceCreate({ mode, onClose, onCreated, seedKinfolkId }: InvoiceCreateProps) {
  const kinfolkState = useCollection<Kinfolk>(KINFOLK_QUERY);
  const households = kinfolkState.status === 'ready' ? kinfolkState.data : [];
  const isQuote = mode === 'quote';

  const [kinfolkId, setKinfolkId] = useState(seedKinfolkId ?? '');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [client, setClient] = useState('');
  const [address, setAddress] = useState('');
  const [date, setDate] = useState('');
  const [terms, setTerms] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [discount, setDiscount] = useState('');
  const [totalText, setTotalText] = useState('');
  const [amountDueText, setAmountDueText] = useState('');
  const [status, setStatus] = useState<'draft' | ''>('draft');
  const [sendToKinfolk, setSendToKinfolk] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [moneyMode, setMoneyMode] = useState<InvoiceMoneyMode>('flat');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [invoiceDiscountText, setInvoiceDiscountText] = useState('');
  const [sessionIds, setSessionIds] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const selectedHousehold = households.find((h) => h._id === kinfolkId);
  const itemized = moneyMode === 'itemized';

  // The derived total, recomputed as the operator types. This is the figure that
  // gets SENT: the server refuses a total that disagrees with the lines, so both
  // sides must come from this one computation, and they do, because this is the
  // mirrored `invoiceMath` module the server recomputes from.
  const derived = useMemo(() => {
    if (!itemized) return null;
    const parsed = parseDraftLines(lines, invoiceDiscountText);
    if (parsed.lines === null) return { totals: null, error: parsed.error };
    return {
      totals: computeInvoiceTotals(parsed.lines, parsed.invoiceDiscountCents ?? 0, 0),
      parsed,
      error: null,
    };
  }, [itemized, lines, invoiceDiscountText]);

  async function submit() {
    if (submitting) return;

    // ITEMIZED AND FLAT VALIDATE DIFFERENTLY, because in the itemized path there
    // is no total to validate: it is derived. Running the flat validator over a
    // blank total field would reject a perfectly good itemized invoice.
    let moneyFields: Pick<NewInvoiceInput, 'total' | 'amountDue' | 'lineItems' | 'invoiceDiscountCents'>;

    if (itemized) {
      const parsed = parseDraftLines(lines, invoiceDiscountText);
      if (parsed.error !== null) {
        setValidationError(parsed.error);
        return;
      }
      if (parsed.lines!.length === 0) {
        setValidationError('Add at least one line item, or switch back to entering a total directly.');
        return;
      }
      const totals = computeInvoiceTotals(parsed.lines!, parsed.invoiceDiscountCents!, 0);
      if (kinfolkId.trim() === '') {
        setValidationError('Pick a household for this invoice');
        return;
      }
      if (invoiceNumber.trim() === '') {
        setValidationError('Invoice number is required');
        return;
      }
      if (date.trim() !== '' && !isValidInvoiceDate(date)) {
        setValidationError('Date must be a real YYYY-MM-DD date');
        return;
      }
      if (dueDate.trim() !== '' && !isValidInvoiceDate(dueDate)) {
        setValidationError('Due date must be a real YYYY-MM-DD date');
        return;
      }
      // Both dollar scalars are the PROJECTION of the same cents figure the
      // server will recompute. Sending anything else is refused rather than
      // silently overwritten, which is why neither is read off a form field.
      moneyFields = {
        total: centsToDollars(totals.totalCents),
        amountDue: centsToDollars(totals.amountDueCents),
        lineItems: parsed.lines!,
        invoiceDiscountCents: parsed.invoiceDiscountCents!,
      };
    } else {
      const err = validateInvoiceCreate({ kinfolkId, invoiceNumber, totalText, amountDueText, date, dueDate });
      if (err) {
        setValidationError(err);
        return;
      }
      // No `lineItems` key AT ALL on the flat path, not an empty array. The
      // server treats the key's presence as "this invoice is itemized", and an
      // empty array would arm `updateInvoice`'s recompute on an invoice whose
      // total was typed by hand, so a later due-date correction would rewrite it
      // to $0.
      moneyFields = { total: Number(totalText), amountDue: Number(amountDueText) };
    }

    setValidationError(null);
    setSubmitError(null);
    setSubmitting(true);

    const base: NewInvoiceInput = {
      familyId: kinfolkId,
      kinfolkName: selectedHousehold ? kinfolkDisplayName(selectedHousehold) : '',
      invoiceNumber: invoiceNumber.trim(),
      client: client.trim(),
      address: address.trim(),
      date: date.trim(),
      terms: terms.trim(),
      dueDate: dueDate.trim(),
      discount: discount.trim(),
      ...moneyFields,
      // A quote's status is forced QUOTE server-side regardless, mirrors the
      // wasm stamping "quote" locally purely for an honest optimistic value.
      status: isQuote ? '' : status,
      // The visits this invoice was built from, so the portal can show the
      // household which work it covers and nothing double-bills them later.
      sessionIds,
    };

    try {
      const result = isQuote ? await createQuote({ ...base, sendToKinfolk }) : await createInvoice(base);
      setSubmitting(false);
      onCreated?.(result.invoiceId);
      onClose();
    } catch (caught) {
      setSubmitting(false);
      const name = isQuote ? 'createQuote' : 'createInvoice';
      setSubmitError(`${name} failed: ${caught instanceof Error ? caught.message : 'Create failed'}`);
    }
  }

  function onFormSubmit(e: FormEvent) {
    e.preventDefault(); // Enter-in-field path
    void submit();
  }

  // Stable across re-renders (memoized on the one thing that should change its
  // behaviour, `submitting`), NOT a fresh arrow function every render. Dialog's
  // focus-management effect re-runs whenever its `onClose` prop's IDENTITY
  // changes, including re-grabbing focus onto the panel; an inline arrow here
  // would re-fire that on every keystroke's re-render, yanking focus off the
  // field the operator is typing into after the very first character.
  const handleDialogClose = useCallback(() => {
    if (!submitting) onClose();
  }, [submitting, onClose]);

  return (
    <Dialog
      title={isQuote ? 'New quote' : 'New invoice'}
      onClose={handleDialogClose}
      footer={
        <>
          <GhostButton label="Cancel" onClick={onClose} disabled={submitting} />
          <PrimaryButton
            label={submitting ? (isQuote ? 'Creating…' : 'Saving…') : isQuote ? 'Create quote' : 'Save'}
            onClick={() => void submit()}
            disabled={submitting}
            busy={submitting}
          />
        </>
      }
    >
      <form className="invoice-create__form" onSubmit={onFormSubmit}>
        {validationError && (
          <Banner tone="error" title="Can't save">
            {validationError}
          </Banner>
        )}
        {submitError && (
          <Banner tone="error" title="Can't save">
            {submitError}
          </Banner>
        )}
        {kinfolkState.status === 'error' && (
          <Banner tone="error" title="Couldn't load households">
            {kinfolkState.message}
          </Banner>
        )}

        <label className="invoice-create__field">
          <span className="invoice-create__label">Household</span>
          <select
            className="invoice-create__input"
            value={kinfolkId}
            onChange={(e) => setKinfolkId(e.target.value)}
            disabled={submitting}
            aria-label="Household"
          >
            <option value="">{kinfolkState.status === 'loading' ? 'Loading households…' : 'Pick a household…'}</option>
            {households.map((h) => (
              <option key={h._id} value={h._id}>
                {kinfolkDisplayName(h)}
              </option>
            ))}
          </select>
        </label>

        <label className="invoice-create__field">
          <span className="invoice-create__label">Invoice number</span>
          <input
            className="invoice-create__input"
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
            disabled={submitting}
          />
        </label>

        <label className="invoice-create__field">
          <span className="invoice-create__label">Client, optional</span>
          <input
            className="invoice-create__input"
            value={client}
            onChange={(e) => setClient(e.target.value)}
            disabled={submitting}
          />
        </label>

        <label className="invoice-create__field">
          <span className="invoice-create__label">Address, optional</span>
          <input
            className="invoice-create__input"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            disabled={submitting}
          />
        </label>

        <div className="invoice-create__row">
          <label className="invoice-create__field">
            <span className="invoice-create__label">Date</span>
            {/* A REAL date input, replacing the free-text field. The old one let
                "Net 14" into a value the server parses as YYYY-MM-DD and the
                Invoices list both windows and sorts on, so a typo there did not
                just look wrong, it made the invoice unreachable under every
                dated window. */}
            <input
              type="date"
              className="invoice-create__input"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              disabled={submitting}
              aria-label="Invoice date"
            />
          </label>
          <label className="invoice-create__field">
            <span className="invoice-create__label">Due date</span>
            <input
              type="date"
              className="invoice-create__input"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              disabled={submitting}
              aria-label="Invoice due date"
            />
          </label>
        </div>

        <div className="invoice-create__mode" role="group" aria-label="How this invoice is priced">
          <GhostButton
            label="Enter a total"
            onClick={() => setMoneyMode('flat')}
            disabled={submitting || !itemized}
          />
          <GhostButton
            label="Itemize it"
            onClick={() => setMoneyMode('itemized')}
            disabled={submitting || itemized}
          />
          {itemized && (
            <GhostButton
              label="Add from visits"
              onClick={() => setPickerOpen(true)}
              disabled={submitting || kinfolkId === ''}
            />
          )}
        </div>

        {itemized ? (
          <>
            {pickerOpen && (
              <UninvoicedVisitsPicker
                kinfolkId={kinfolkId}
                onClose={() => setPickerOpen(false)}
                onAdd={(added, addedSessionIds) => {
                  setLines((prev) => [...prev, ...added]);
                  // De-duplicated: adding the same visit twice would bill the
                  // household for one piece of work two times.
                  setSessionIds((prev) => [...new Set([...prev, ...addedSessionIds])]);
                  setPickerOpen(false);
                }}
              />
            )}
            <InvoiceLineItemsEditor
              drafts={lines}
              onChange={setLines}
              invoiceDiscountText={invoiceDiscountText}
              onInvoiceDiscountChange={setInvoiceDiscountText}
              disabled={submitting}
            />
            {/* The figure that will actually be sent, shown as such. There is no
                total field to type into on this path, by design. */}
            {/* NO FIGURE IS PROMISED UNTIL THERE IS ONE. With no lines at all
                the arithmetic is a perfectly valid $0.00, and printing it would
                tell the operator this invoice "will be sent for $0.00" when in
                fact it cannot be sent at all. An empty set and a zero total are
                different facts and must not read alike. */}
            <p className="invoice-create__derived">
              {lines.length === 0
                ? 'Add a line, or bring some in from the visits picker. The total is worked out from the lines.'
                : derived?.totals
                  ? `This invoice will be sent for ${formatCentsUsd(derived.totals.totalCents)}, worked out from the lines above.`
                  : 'The total will be worked out from the lines once every line has a quantity and a unit price.'}
            </p>
            {sessionIds.length > 0 && (
              <p className="invoice-create__derived">
                Linked to {sessionIds.length} visit{sessionIds.length === 1 ? '' : 's'}.
              </p>
            )}
          </>
        ) : (
          <div className="invoice-create__row">
            <label className="invoice-create__field">
              <span className="invoice-create__label">Total ($)</span>
              <input
                className="invoice-create__input"
                inputMode="decimal"
                value={totalText}
                onChange={(e) => setTotalText(e.target.value)}
                disabled={submitting}
              />
            </label>
            <label className="invoice-create__field">
              <span className="invoice-create__label">Amount due ($)</span>
              <input
                className="invoice-create__input"
                inputMode="decimal"
                value={amountDueText}
                onChange={(e) => setAmountDueText(e.target.value)}
                disabled={submitting}
              />
            </label>
          </div>
        )}

        <label className="invoice-create__field">
          <span className="invoice-create__label">Terms, optional</span>
          <input
            className="invoice-create__input"
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
            disabled={submitting}
          />
        </label>

        <label className="invoice-create__field">
          <span className="invoice-create__label">Discount, optional</span>
          <input
            className="invoice-create__input"
            value={discount}
            onChange={(e) => setDiscount(e.target.value)}
            disabled={submitting}
          />
        </label>

        {isQuote ? (
          <div className="invoice-create__toggle-row">
            <span>Send to kinfolk now</span>
            <Toggle checked={sendToKinfolk} onChange={setSendToKinfolk} disabled={submitting} label="Send to kinfolk now" />
          </div>
        ) : (
          <label className="invoice-create__field">
            <span className="invoice-create__label">Status</span>
            <select
              className="invoice-create__input"
              value={status}
              onChange={(e) => setStatus(e.target.value === 'draft' ? 'draft' : '')}
              disabled={submitting}
            >
              <option value="draft">draft</option>
              <option value="">sent</option>
            </select>
          </label>
        )}
      </form>
    </Dialog>
  );
}
