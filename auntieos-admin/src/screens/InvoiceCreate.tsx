import { useCallback, useState, type FormEvent } from 'react';
import { KINFOLK_QUERY, kinfolkDisplayName, type Kinfolk } from '../api/directory';
import { createInvoice, createQuote, type NewInvoiceInput } from '../api/invoicesWrite';
import { useCollection } from '../lib/firestore';
import { Dialog } from '../components/Dialog';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { Toggle } from '../components/Toggle';
import { Banner } from '../components/Banner';
import './InvoiceCreate.css';

export type InvoiceCreateMode = 'invoice' | 'quote';

interface InvoiceCreateProps {
  mode: InvoiceCreateMode;
  onClose: () => void;
  /** Called with the new invoice id once the create callable resolves, before onClose. */
  onCreated?: (invoiceId: string) => void;
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
export function InvoiceCreate({ mode, onClose, onCreated }: InvoiceCreateProps) {
  const kinfolkState = useCollection<Kinfolk>(KINFOLK_QUERY);
  const households = kinfolkState.status === 'ready' ? kinfolkState.data : [];
  const isQuote = mode === 'quote';

  const [kinfolkId, setKinfolkId] = useState('');
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

  const selectedHousehold = households.find((h) => h._id === kinfolkId);

  async function submit() {
    if (submitting) return;
    const err = validateInvoiceCreate({ kinfolkId, invoiceNumber, totalText, amountDueText, date, dueDate });
    if (err) {
      setValidationError(err);
      return;
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
      total: Number(totalText),
      amountDue: Number(amountDueText),
      // A quote's status is forced QUOTE server-side regardless, mirrors the
      // wasm stamping "quote" locally purely for an honest optimistic value.
      status: isQuote ? '' : status,
      sessionIds: [],
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
            <span className="invoice-create__label">Date (YYYY-MM-DD)</span>
            <input
              className="invoice-create__input"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              placeholder="YYYY-MM-DD"
              disabled={submitting}
            />
          </label>
          <label className="invoice-create__field">
            <span className="invoice-create__label">Due date (YYYY-MM-DD)</span>
            <input
              className="invoice-create__input"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              placeholder="YYYY-MM-DD"
              disabled={submitting}
            />
          </label>
        </div>

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
