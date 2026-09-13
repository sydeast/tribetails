import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { KINFOLK_QUERY, kinfolkDisplayName, type Kinfolk } from '../api/directory';
import { createInvoice, createQuote } from '../api/invoicesWrite';
import {
  mintInvoiceIdempotencyKey,
  mintQuoteIdempotencyKey,
} from '../lib/moneyIdempotency';
import type {
  CreateInvoiceArgs,
  ListUninvoicedSessionsResultSession,
} from '../contracts/invoiceContracts.generated';
import { useCollection } from '../lib/firestore';
import { computeInvoiceTotals, centsToDollars, type InvoiceLineItemInput } from '../lib/invoiceMath';
import { formatCentsUsd } from '../lib/invoiceReconcile';
import { localDateIso } from '../lib/invoiceFormat';
import { parseDollarsToCents, MAX_UNIT_CENTS } from '../lib/invoiceMoneyInput';
import { invoiceTermsDefs, resolveDueDate, type InvoiceTermsCode } from '../lib/invoiceTerms';
import { Dialog } from '../components/Dialog';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { Toggle } from '../components/Toggle';
import { Banner } from '../components/Banner';
import { InvoiceLineItemsEditor, parseDraftLines, type DraftLine } from '../components/InvoiceLineItems';
import { UninvoicedVisitsPicker, visitLineDescription } from '../components/UninvoicedVisitsPicker';
import './InvoiceCreate.css';

/** Invoice or quote. A quote is the same document in QUOTE status, not a second kind of thing. */
export type InvoiceCreateMode = 'invoice' | 'quote';

interface InvoiceCreateProps {
  /**
   * Which kind the composer opens on. The operator can change it inside: a
   * quote is an invoice in QUOTE status, not a separate entry point (#408), so
   * there is one composer and one button rather than two of each.
   */
  mode: InvoiceCreateMode;
  onClose: () => void;
  /** Called with the new invoice id once the create callable resolves, before onClose. */
  onCreated?: (invoiceId: string) => void;
  /**
   * Pre-selects the household picker. Set when the composer was opened FOR a
   * household rather than from the plain "New invoice" button, e.g. the
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

/**
 * Which path this invoice is being written down.
 *
 *   work    the invoice is a SELECTION over work that already exists. The
 *           default, and the whole point of #408.
 *   blank   nothing has been logged for this household, so a total is typed.
 *           A real need, and the exception rather than the front door.
 */
export type InvoiceCreatePath = 'work' | 'blank';

export interface BlankInvoiceFormValues {
  kinfolkId: string;
  totalText: string;
  date: string;
  dueDate: string;
}

/**
 * Pure, unit-tested validation for the BLANK path, the only one where a total
 * is typed.
 *
 * `invoiceNumber` and `amountDue` are gone from it, and neither was a rule this
 * form should have enforced. The number is assigned by the server when nobody
 * supplies one; the amount due on an invoice nobody has paid is definitionally
 * its total, a computed output that was being asked for as an input.
 */
export function validateBlankInvoice(v: BlankInvoiceFormValues): string | null {
  const total = Number(v.totalText);
  if (v.kinfolkId.trim() === '') return 'Pick a household for this invoice';
  if (v.totalText.trim() === '' || Number.isNaN(total) || total < 0) return 'Total must be zero or greater';
  if (v.date.trim() !== '' && !isValidInvoiceDate(v.date)) return 'Date must be a real YYYY-MM-DD date';
  if (v.dueDate.trim() !== '' && !isValidInvoiceDate(v.dueDate)) return 'Due date must be a real YYYY-MM-DD date';
  return null;
}

export interface BoundLinesOutcome {
  lines: InvoiceLineItemInput[];
  /** The first problem, as operator-facing text, or null when every line is sound. */
  error: string | null;
}

/**
 * The invoice lines for a selection of visits.
 *
 * EVERY LINE CARRIES ITS `sessionId`, which is what makes it a bound line
 * rather than a description that happens to mention a date: the invoice can be
 * routed back to the work it bills for, and the household's copy can show when
 * that work happened.
 *
 * A VISIT THE RATE CARD COULD NOT PRICE NEEDS A TYPED ONE, and until it has one
 * this refuses rather than billing zero. Same rule the picker renders and the
 * same rule `listUninvoicedSessions` applies: null is not zero.
 */
export function buildBoundLines(
  sessions: readonly ListUninvoicedSessionsResultSession[],
  selected: ReadonlySet<string>,
  prices: Readonly<Record<string, string>>,
): BoundLinesOutcome {
  const lines: InvoiceLineItemInput[] = [];
  for (const s of sessions) {
    if (!selected.has(s.sessionId)) continue;
    const description = visitLineDescription(s);
    let unitCents = s.unitCents;
    if (unitCents === null) {
      const typed = (prices[s.sessionId] ?? '').trim();
      if (typed === '') {
        return {
          lines: [],
          error: `${description} has no rate on file. Type what it should cost, or untick it.`,
        };
      }
      const parsed = parseDollarsToCents(typed);
      if (parsed === null) {
        return {
          lines: [],
          error: `The price for ${description} needs a dollar amount, for example 25.00.`,
        };
      }
      if (parsed > MAX_UNIT_CENTS) {
        return {
          lines: [],
          error: `The price for ${description} cannot be more than ${formatCentsUsd(MAX_UNIT_CENTS)}.`,
        };
      }
      unitCents = parsed;
    }
    // Quantity is ONE VISIT, not a duration. The rate card is keyed by service
    // name and priced per service, so multiplying by hours would silently
    // multiply the bill.
    lines.push({ description, qty: 1, unitCents, sessionId: s.sessionId });
  }
  return { lines, error: null };
}

/**
 * The new-invoice composer.
 *
 * CREATING AN INVOICE IS AN ACT OF SELECTION OVER WORK THAT ALREADY EXISTS, NOT
 * AN ACT OF DESCRIPTION. That is the finding behind issue #408, and this
 * composer is arranged around it: pick a household, see its un-invoiced work,
 * tick what this invoice covers, create it. Everything else the old form asked
 * for was either inherited from the household, derived from the terms, computed
 * from the lines, or assigned by the server, and every one of them was being
 * put to the operator as a question.
 *
 * WHAT THE FORM NO LONGER ASKS, and where each answer comes from instead:
 *
 *   Invoice number   assigned by the server (`lib/invoiceNumber.ts`), and
 *                    editable afterwards on the invoice itself.
 *   Client           the household, one field above. Inherited.
 *   Address          NOT ASKED AND NOT INHERITED: the `kinfolk` model carries
 *                    no postal address to inherit one from. The field stays on
 *                    the invoice and settable through `updateInvoice`;
 *                    inventing a household address field to fill it here is a
 *                    different piece of work.
 *   Date             today, which is what a new invoice's date is.
 *   Due date         worked out from the terms.
 *   Terms            a structured choice rather than free text, which is what
 *                    lets the due date be worked out at all.
 *   Amount due       the total, on an invoice nobody has paid yet. A computed
 *                    output presented as an input.
 *   Discount         one field, the typed dollar one. The form used to show
 *                    that AND a free-text "Discount" box at the same time.
 *   Status           a new invoice is a draft. Sending it is a separate action
 *                    (`reviewAndSendDraftInvoice`) and always was; the select
 *                    was a leftover that let an invoice be born "sent" without
 *                    anything having been sent.
 *
 * THE BLANK PATH IS STILL HERE, as the exception it is. A household with no
 * logged work is a real case, and it is the only path where a total is typed.
 *
 * Fail-loud: a rejected callable renders inline via Banner and leaves the
 * dialog open with the form intact, never a silent close. Every field is
 * disabled while submitting (never a double-submit), and the primary button
 * carries Buttons.tsx's `busy` state.
 */
export function InvoiceCreate({ mode, onClose, onCreated, seedKinfolkId }: InvoiceCreateProps) {
  const kinfolkState = useCollection<Kinfolk>(KINFOLK_QUERY);
  const households = kinfolkState.status === 'ready' ? kinfolkState.data : [];

  const [kind, setKind] = useState<InvoiceCreateMode>(mode);
  const [kinfolkId, setKinfolkId] = useState(seedKinfolkId ?? '');
  const [path, setPath] = useState<InvoiceCreatePath>('work');
  const [date, setDate] = useState(() => localDateIso(new Date()));
  const [termsCode, setTermsCode] = useState<InvoiceTermsCode>('due_on_receipt');
  const [customDueDate, setCustomDueDate] = useState('');
  const [totalText, setTotalText] = useState('');
  const [invoiceDiscountText, setInvoiceDiscountText] = useState('');
  const [extraLines, setExtraLines] = useState<DraftLine[]>([]);
  const [sendToKinfolk, setSendToKinfolk] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /**
   * #825: ONE KEY PER SUBMISSION, held across a re-press.
   *
   * A replayed create costs the household a second bill AND spends a second
   * value from the shared `counters/invoiceNumber` sequence — and a consumed
   * number cannot be given back, so even deleting the duplicate leaves the
   * numbering claiming an invoice was issued that nobody can produce. The key
   * becomes the `invoices/{key}` document id, so a second press lands on the
   * document the first press may already have written, and never reaches the
   * counter at all.
   *
   * Minted lazily on the first press and cleared by the effect below whenever
   * anything about the invoice changes, because an edited invoice is a
   * different invoice and a held key would report the first one's id back for
   * money that was never billed. The composer closes on success, so the only
   * press that reuses a key is a press after a visible failure — which is
   * precisely the one that used to duplicate.
   */
  const submissionKey = useRef<string | null>(null);

  // The work half: what the picker loaded, and what is ticked.
  const [sessions, setSessions] = useState<readonly ListUninvoicedSessionsResultSession[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [prices, setPrices] = useState<Record<string, string>>({});
  // #825: an edited invoice is a DIFFERENT invoice, so the held submission key
  // is dropped the moment any of its inputs move. Declared here rather than
  // beside the ref, because it reads state that is declared below it.
  useEffect(() => {
    submissionKey.current = null;
  }, [
    kind,
    kinfolkId,
    path,
    date,
    termsCode,
    customDueDate,
    totalText,
    invoiceDiscountText,
    extraLines,
    sendToKinfolk,
    selected,
    prices,
  ]);

  const isQuote = kind === 'quote';
  const selectedHousehold = households.find((h) => h._id === kinfolkId);
  const householdLabel = selectedHousehold ? kinfolkDisplayName(selectedHousehold) : 'this household';
  const onWork = path === 'work';

  const handleSessionsLoaded = useCallback((loaded: readonly ListUninvoicedSessionsResultSession[]) => {
    setSessions(loaded);
  }, []);
  const handleSelectedChange = useCallback((next: ReadonlySet<string>) => setSelected(next), []);
  const handlePriceChange = useCallback(
    (sessionId: string, text: string) => setPrices((prev) => ({ ...prev, [sessionId]: text })),
    [],
  );

  /**
   * The due date these terms mean, worked out through the SAME resolver the
   * server re-runs before it writes. Shown, never typed, unless the operator
   * picked the terms that hand the date back to them.
   */
  const due = useMemo(() => {
    const serviceDates = onWork
      ? sessions.filter((s) => selected.has(s.sessionId)).map((s) => s.startTime)
      : [];
    return resolveDueDate({ code: termsCode, invoiceDate: date }, serviceDates, localDateIso(new Date()));
  }, [termsCode, date, onWork, sessions, selected]);

  const dueDateForSubmit = termsCode === 'custom' ? customDueDate : (due.dueDate ?? '');

  /** The lines this invoice would carry, and the live total under them. */
  const money = useMemo(() => {
    if (!onWork) return null;
    const bound = buildBoundLines(sessions, selected, prices);
    if (bound.error !== null) return { lines: null, error: bound.error, totals: null, invoiceDiscountCents: 0 };
    const typed = parseDraftLines(extraLines, invoiceDiscountText);
    if (typed.error !== null) return { lines: null, error: typed.error, totals: null, invoiceDiscountCents: 0 };
    const lines = [...bound.lines, ...typed.lines!];
    return {
      lines,
      error: null,
      totals: computeInvoiceTotals(lines, typed.invoiceDiscountCents!, 0),
      invoiceDiscountCents: typed.invoiceDiscountCents!,
    };
  }, [onWork, sessions, selected, prices, extraLines, invoiceDiscountText]);

  /**
   * Why the create button cannot run yet, or null when it can.
   *
   * A SENTENCE rather than a boolean, because the button is shown disabled with
   * its reason stated beside it rather than hidden. A control that vanishes
   * teaches nothing about what it wanted.
   */
  const blocked: string | null = (() => {
    if (kinfolkId.trim() === '') return 'Pick a household first.';
    if (termsCode !== 'custom' && due.dueDate === null) return due.problem;
    if (onWork) {
      if (selected.size === 0 && extraLines.length === 0) {
        return 'Tick the work this invoice covers, or add a line of your own.';
      }
      if (money?.error != null) return money.error;
    }
    return null;
  })();

  async function submit() {
    if (submitting) return;

    let moneyFields: Pick<CreateInvoiceArgs, 'total' | 'amountDue' | 'lineItems' | 'invoiceDiscountCents'>;
    let sessionIds: string[] = [];

    if (onWork) {
      if (money === null || money.error !== null || money.lines === null || money.totals === null) {
        setValidationError(money?.error ?? 'This invoice has no work on it yet.');
        return;
      }
      if (money.lines.length === 0) {
        setValidationError('Tick the work this invoice covers, or add a line of your own.');
        return;
      }
      // Both dollar scalars are the PROJECTION of the same cents figure the
      // server recomputes. Sending anything else is refused rather than
      // silently overwritten, which is why neither is read off a form field.
      moneyFields = {
        total: centsToDollars(money.totals.totalCents),
        amountDue: centsToDollars(money.totals.amountDueCents),
        lineItems: money.lines,
        invoiceDiscountCents: money.invoiceDiscountCents,
      };
      sessionIds = money.lines.flatMap((l) => (l.sessionId ? [l.sessionId] : []));
    } else {
      const err = validateBlankInvoice({ kinfolkId, totalText, date, dueDate: dueDateForSubmit });
      if (err) {
        setValidationError(err);
        return;
      }
      // No `lineItems` key AT ALL on the blank path, not an empty array. The
      // server treats the key's presence as "this invoice is itemized", and an
      // empty array would arm `updateInvoice`'s recompute on an invoice whose
      // total was typed by hand, so a later due-date correction would rewrite
      // it to $0. Amount due IS the total: nothing has been paid on an invoice
      // that does not exist yet.
      moneyFields = { total: Number(totalText), amountDue: Number(totalText) };
    }

    if (termsCode !== 'custom' && due.dueDate === null) {
      setValidationError(due.problem);
      return;
    }

    setValidationError(null);
    setSubmitError(null);
    setSubmitting(true);

    const base: CreateInvoiceArgs = {
      familyId: kinfolkId,
      kinfolkName: selectedHousehold ? kinfolkDisplayName(selectedHousehold) : '',
      // INHERITED from the household, not asked. `address` is deliberately not
      // sent: nothing on the household carries one (see the header).
      client: selectedHousehold ? kinfolkDisplayName(selectedHousehold) : '',
      date: date.trim(),
      // The server writes `terms` as the rule in words and re-resolves the due
      // date from the visits it actually links, refusing a date that disagrees.
      termsCode,
      dueDate: dueDateForSubmit,
      ...moneyFields,
      // A NEW INVOICE IS A DRAFT. Sending is `reviewAndSendDraftInvoice`, a
      // separate and later action. A quote's status is forced QUOTE server-side.
      status: isQuote ? '' : 'draft',
      // The visits this invoice was built from, so the portal can show the
      // household which work it covers and nothing double-bills them later.
      sessionIds,
    };

    try {
      // A quote and an invoice take DIFFERENTLY PREFIXED keys even though both
      // write the `invoices` collection: that is what stops a key minted while
      // the composer was in quote mode from answering at `createInvoice` after
      // the operator flipped the toggle. The effect above clears the key on
      // that flip anyway; the prefixes mean it would be refused rather than
      // silently honoured if it ever did not.
      const result = isQuote
        ? await createQuote({
            ...base,
            sendToKinfolk,
            idempotencyKey: (submissionKey.current ??= mintQuoteIdempotencyKey()),
          })
        : await createInvoice({
            ...base,
            idempotencyKey: (submissionKey.current ??= mintInvoiceIdempotencyKey()),
          });
      submissionKey.current = null;
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

  /** What the due-date field is doing, and why it is not typeable. Said once. */
  const termsNote =
    termsCode === 'custom'
      ? 'These terms leave the due date to you.'
      : due.dueDate === null
        ? due.problem
        : due.isPast
          ? `Worked out from the terms, counting from ${due.basisDay ?? date}. That date has already passed, so this invoice is overdue the moment it goes out.`
          : `Worked out from the terms, counting from ${due.basisDay ?? date}. Choose "A date I pick myself" to set it by hand.`;
  const createLabel = isQuote ? 'Create quote' : 'Create invoice';
  const visitCount = onWork ? selected.size : 0;

  return (
    <Dialog
      title={isQuote ? 'New quote' : 'New invoice'}
      onClose={handleDialogClose}
      footer={
        <>
          <GhostButton label="Cancel" onClick={onClose} disabled={submitting} />
          <PrimaryButton
            label={
              submitting
                ? isQuote
                  ? 'Creating quote…'
                  : 'Creating invoice…'
                : onWork && visitCount > 0
                  ? `${createLabel} for ${String(visitCount)} visit${visitCount === 1 ? '' : 's'}`
                  : createLabel
            }
            onClick={() => void submit()}
            disabled={submitting || blocked !== null}
            busy={submitting}
          />
        </>
      }
    >
      <form className="invoice-create__form" onSubmit={onFormSubmit}>
        {validationError && (
          <Banner tone="error" title="Can't create this yet">
            {validationError}
          </Banner>
        )}
        {submitError && (
          <Banner tone="error" title="Can't create this yet">
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
            onChange={(e) => {
              setKinfolkId(e.target.value);
              // A new household means new work, and none of the old selection
              // belongs to it. Cleared here rather than inside the picker, so
              // "what is on this invoice" stays answerable in one place.
              setSelected(new Set());
              setSessions([]);
              setPrices({});
              setPath('work');
            }}
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

        {/* A quote is this same document in QUOTE status, not a separate entry
            point (#408), so the kind is a field here rather than a second
            button on the Invoices screen. */}
        <label className="invoice-create__field">
          <span className="invoice-create__label">What is this</span>
          <select
            className="invoice-create__input"
            value={kind}
            onChange={(e) => setKind(e.target.value === 'quote' ? 'quote' : 'invoice')}
            disabled={submitting}
            aria-label="What is this"
          >
            <option value="invoice">An invoice, for work already done</option>
            <option value="quote">A quote, for work not agreed yet</option>
          </select>
        </label>

        {kinfolkId === '' ? (
          <p className="invoice-create__derived">
            Pick a household and its un-invoiced work appears here, ready to tick.
          </p>
        ) : onWork ? (
          <UninvoicedVisitsPicker
            kinfolkId={kinfolkId}
            householdLabel={householdLabel}
            selected={selected}
            onSelectedChange={handleSelectedChange}
            prices={prices}
            onPriceChange={handlePriceChange}
            onSessionsLoaded={handleSessionsLoaded}
            disabled={submitting}
            onWriteBlankInvoice={() => setPath('blank')}
          />
        ) : (
          <div className="invoice-create__blank">
            <p className="invoice-create__derived">
              A blank invoice, with a total you type. Nothing on it is linked to logged work, so
              nothing here can tell whether this household has already been billed for it.
            </p>
            <label className="invoice-create__field">
              <span className="invoice-create__label">Total ($)</span>
              <input
                className="invoice-create__input"
                inputMode="decimal"
                value={totalText}
                onChange={(e) => setTotalText(e.target.value)}
                disabled={submitting}
                aria-label="Total"
              />
            </label>
            <GhostButton
              label="Bill this household's logged work instead"
              onClick={() => setPath('work')}
              disabled={submitting}
            />
          </div>
        )}

        {onWork && kinfolkId !== '' && (
          <>
            {/* An extra charge is an ordinary line, not a special field: a
                mileage charge and a dog walk are both things this bills for. */}
            <InvoiceLineItemsEditor
              drafts={extraLines}
              onChange={setExtraLines}
              invoiceDiscountText={invoiceDiscountText}
              onInvoiceDiscountChange={setInvoiceDiscountText}
              disabled={submitting}
              emptyHint="No extra charges. Anything the visits above do not cover goes here."
            />
            {/* NO FIGURE IS PROMISED UNTIL THERE IS ONE. With nothing on the
                invoice the arithmetic is a perfectly valid $0.00, and printing
                it would say this invoice "will be created for $0.00" when in
                fact it cannot be created at all. An empty set and a zero total
                are different facts and must not read alike. */}
            <p className="invoice-create__derived">
              {money?.totals && money.lines !== null && money.lines.length > 0
                ? `This invoice will be created for ${formatCentsUsd(money.totals.totalCents)}, worked out from the work it covers. There is nowhere to type a total, so it can never say a different number from the work it lists.`
                : 'Totals are worked out from the work this invoice covers. Tick a visit above, or add a line of your own.'}
            </p>
          </>
        )}

        <div className="invoice-create__row">
          <label className="invoice-create__field">
            <span className="invoice-create__label">Date</span>
            {/* A REAL date input, and it opens on today. The old one started
                blank, and free text in it reached a field the Invoices list
                both windows and sorts on. */}
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
            <span className="invoice-create__label">Terms</span>
            <select
              className="invoice-create__input"
              value={termsCode}
              onChange={(e) => setTermsCode(e.target.value as InvoiceTermsCode)}
              disabled={submitting}
              aria-label="Terms"
            >
              {invoiceTermsDefs().map((def) => (
                <option key={def.code} value={def.code}>
                  {def.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="invoice-create__row">
          <label className="invoice-create__field">
            <span className="invoice-create__label">Due date</span>
            <input
              type="date"
              className="invoice-create__input"
              value={termsCode === 'custom' ? customDueDate : (due.dueDate ?? '')}
              onChange={(e) => setCustomDueDate(e.target.value)}
              // DISABLED WITH THE REASON STATED BELOW, never hidden. The terms
              // decide this date, and the way to change it is to change them.
              disabled={submitting || termsCode !== 'custom'}
              aria-label="Invoice due date"
            />
          </label>
        </div>

        <p className="invoice-create__derived" role="status">
          {termsNote}
        </p>

        {isQuote && (
          <div className="invoice-create__toggle-row">
            <span>Send to kinfolk now</span>
            <Toggle
              checked={sendToKinfolk}
              onChange={setSendToKinfolk}
              disabled={submitting}
              label="Send to kinfolk now"
            />
          </div>
        )}

        {/* The disabled button's reason, stated where the button is rather than
            left for the operator to work out by clicking it. Not repeated when
            the terms line above is already saying the same sentence: a reason
            printed twice reads as two problems. */}
        {blocked !== null && blocked !== termsNote && !submitting && (
          <p className="invoice-create__derived invoice-create__blocked" role="status">
            {blocked}
          </p>
        )}

        {!isQuote && (
          <p className="invoice-create__derived">
            This lands as a draft. Nothing reaches {householdLabel} until you send it from the
            invoice itself.
          </p>
        )}
      </form>
    </Dialog>
  );
}
