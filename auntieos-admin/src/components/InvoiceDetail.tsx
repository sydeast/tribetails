import { useCallback, useEffect, useState } from 'react';
import { invoiceLineItems, invoiceStamp, isArchivedInvoice, type InvoiceEntry } from '../api/invoices';
import {
  formatUsd,
  invoiceActionsFor,
  invoicePartialPayment,
  invoiceStateInfo,
  isInvoiceOverdue,
  localDateIso,
  unstampedStateInfo,
  type InvoiceAction,
} from '../lib/invoiceFormat';
import { checkInvoiceTotal, formatCentsUsd, storedTotalSourceLabel } from '../lib/invoiceReconcile';
import {
  markInvoicePaid,
  sendInvoiceReminder,
  generateReceipt,
  getInvoiceLedger,
  recordPayment,
  reviewAndSendDraftInvoice,
  updateInvoice,
  archiveInvoice,
  unarchiveInvoice,
} from '../api/invoicesWrite';
import type {
  GetInvoiceLedgerResult,
  UpdateInvoiceArgsPatch,
} from '../contracts/invoiceContracts.generated';
import { InvoiceLedgerPanels } from './InvoiceLedger';
import {
  InvoiceLineItemsTable,
  InvoiceLineItemsEditor,
  draftFromLineItem,
  parseDraftLines,
  type DraftLine,
} from './InvoiceLineItems';
import { centsToInputDollars } from '../lib/invoiceMoneyInput';
import { Dialog } from './Dialog';
import { PrimaryButton, GhostButton } from './Buttons';
import { Banner } from './Banner';
import './InvoiceDetail.css';

/**
 * A money box that may be left empty. Dollars.
 *
 * THREE ANSWERS, and the third is the one that matters: a number, `0` for a
 * blank box, and `null` for something typed that is not money. A blank box is
 * genuinely zero (no tip was entered), but "abc" in the tip box is a keystroke
 * the operator meant, and reading it as zero would silently drop a tip she
 * believes she recorded. `null` is what makes the panel able to say so.
 *
 * Negative is refused for the same reason: a negative fee is not a fee.
 */
export function parseOptionalMoney(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return 0;
  const parsed = Number(trimmed.replace(/^\$/, ''));
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}
/**
 * The UNAPPLIED BALANCE, live, as she types. Dollars.
 *
 * `payment - applied - tipGross`. It is shown BEFORE Save because that is what
 * it is for: it is how a mis-keyed amount is caught while it is still a typo
 * rather than a payment. The fee is deliberately absent from it: the fee is a
 * deduction from what the business receives, not from what the client paid, so
 * it does not move this number.
 *
 * `null` means one of the boxes cannot be read yet, and the panel shows nothing
 * rather than a figure derived from a half-typed number.
 */
export function unappliedPreview(input: {
  paymentTotal: string;
  applied: string;
  tip: string;
  /** Used when the applied box is blank, which means "settle the rest". */
  fallbackApplied: number;
}): number | null {
  const tip = parseOptionalMoney(input.tip);
  const total = parseOptionalMoney(input.paymentTotal);
  if (tip === null || total === null) return null;
  const typedApplied = input.applied.trim();
  const applied =
    typedApplied === '' ? input.fallbackApplied : parseOptionalMoney(typedApplied);
  if (applied === null) return null;
  // A blank payment box means "exactly what was applied, plus the tip", which
  // leaves nothing over. That is the ordinary case and it reads as $0.00.
  const payment = total > 0 ? total : applied + tip;
  return Math.round((payment - applied - tip) * 100) / 100;
}
type PendingAction = InvoiceAction;

interface ActionMeta {
  key: PendingAction;
  label: string;
  /** What the confirm step tells the operator this action does to a REAL client. */
  confirmCopy: string;
  confirmLabel: string;
  busyLabel: string;
  successMessage: string;
  /** The callable name surfaced in a fail-loud error, per this action. */
  callableName: string;
}

const ACTIONS: readonly ActionMeta[] = [
  {
    key: 'reminder',
    label: 'Send reminder',
    confirmCopy: 'This sends a real payment-reminder notification to the household on file. Send it now?',
    confirmLabel: 'Send reminder',
    busyLabel: 'Sending…',
    successMessage: 'Reminder sent.',
    callableName: 'sendInvoiceReminder',
  },
  {
    key: 'markPaid',
    label: 'Record payment',
    confirmCopy:
      'Enter the amount actually collected. A payment smaller than the balance leaves the invoice open for the rest, and the household is only notified once it is paid off. Method and reference are optional.',
    confirmLabel: 'Record payment',
    busyLabel: 'Recording…',
    // Replaced at confirm time by what the server says actually happened, so the
    // panel never claims an invoice was paid off when it was not.
    successMessage: 'Payment recorded.',
    callableName: 'markInvoicePaid',
  },
  {
    key: 'receipt',
    label: 'Generate receipt',
    confirmCopy: 'This issues a receipt and notifies the household that it is available. Continue?',
    confirmLabel: 'Generate receipt',
    busyLabel: 'Issuing…',
    successMessage: 'Receipt issued.',
    callableName: 'generateReceipt',
  },
  {
    key: 'reviewSend',
    label: 'Review and send',
    confirmCopy:
      'This sends the draft to the household on file and marks the invoice open. A draft missing its total, household, or invoice number is rejected rather than sent. Continue?',
    confirmLabel: 'Review and send',
    busyLabel: 'Sending…',
    successMessage: 'Draft sent.',
    callableName: 'reviewAndSendDraftInvoice',
  },
];

interface InvoiceDetailProps {
  invoice: InvoiceEntry;
  /**
   * Open ALREADY ON this action's confirm step, set by the Invoices list's
   * per-row quick action (Send reminder / Review and send / Receipt).
   *
   * It arms the confirm panel; it does not perform anything. The step, the copy
   * describing what the action does to a real household, and the callable are
   * all the ones this panel already had, so a row button and the detail button
   * cannot come to mean different things.
   *
   * VALIDATED AGAINST THE STORED STATE below rather than trusted. The list
   * derives it from the same `invoiceActionsFor(state)` this panel uses, but the
   * live listener can deliver a newer doc between the click and this render, and
   * arming an action the invoice no longer permits would present a confirm step
   * for something the server is about to refuse. A stale one falls back to the
   * plain action list.
   */
  initialAction?: InvoiceAction;
  onClose: () => void;
}

/** The metadata and money fields, mid-edit. Text, because a half-typed field is not a number. */
interface EditDraft {
  invoiceNumber: string;
  date: string;
  dueDate: string;
  terms: string;
  lines: DraftLine[];
  invoiceDiscountText: string;
  /**
   * Whether this invoice HAD line items when editing began.
   *
   * Load-bearing, not bookkeeping. `updateInvoice` refuses to recompute an
   * un-itemized invoice, and every invoice in the collection today is
   * un-itemized. If a metadata-only edit sent `lineItems: []` it would tip the
   * server into recomputing, and a real $40 invoice would become $0 because
   * somebody fixed its due date. So the patch below only carries `lineItems`
   * when the operator actually touched the money.
   */
  wasItemized: boolean;
  /** Whether the money fields are editable at all, per the stored editScope. */
  moneyEditable: boolean;
}

/** Which way the archive confirm is pointing, and whether money is at stake. */
interface ArchivePrompt {
  direction: 'archive' | 'restore';
  /** Set after the server refuses an archive because money is still owed. */
  forceOffered: boolean;
}

/**
 * The invoice detail overlay: the row's ACTIONS the list only linked to via a
 * placeholder (`onSelect`). Every action here reaches a real household, so
 * each one is gated behind an inline confirm step before the callable fires,
 * per the fail-loud / confirm-before-consequential convention (mirrors the
 * FormSchemas delete-confirm flow, but as an inline panel swap rather than a
 * second nested Dialog, two Dialog instances would both attach a
 * document-level Escape/focus-trap listener and fight over which one an
 * Escape or Tab press resolves against).
 *
 * `invoice` is passed in BY VALUE from the live `INVOICES_QUERY` stream the
 * Invoices screen already holds (see Invoices.tsx's wiring), so a successful
 * action's Firestore write flows back through that same listener and this
 * component re-renders with the fresh doc automatically. No manual reload,
 * unlike FormSchemas' one-shot load(): the invoices collection is already a
 * live subscription, not a one-shot fetch.
 */
export function InvoiceDetail({ invoice, initialAction, onClose }: InvoiceDetailProps) {
  // Seeded ONCE, from the mount. A row's quick action opens this panel, so the
  // arming happens at open; re-deriving it from the prop on every render would
  // re-open the confirm step the moment the operator cancelled out of it.
  const [pending, setPending] = useState<PendingAction | null>(initialAction ?? null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [paidMethod, setPaidMethod] = useState('');
  const [paidReference, setPaidReference] = useState('');
  // Free text, not a number input, so a half-typed "2" is never read as $2.
  // Parsed and validated at submit, where the operator can be told what is wrong.
  const [paidAmount, setPaidAmount] = useState('');
  // ── THE FEE TRANCHE, 2026-08-04 ──────────────────────────────────────────
  // Her legacy Add New Transaction screen carried all of these beside the
  // amount, and none of them existed here. Free text for the same reason
  // `paidAmount` is: a half-typed "2" must not be read as $2.
  //
  // `paidTip` is the GROSS tip, what the client actually tipped. `paidFee` is
  // the processor's cut, which she takes out of that tip. Both are stored, and
  // the gross is what is displayed. Operator ruling: "store both, and display
  // the latter. itll help with taxes."
  const [paidTip, setPaidTip] = useState('');
  const [paidFee, setPaidFee] = useState('');
  // THE WHOLE SUM THE CLIENT HANDED OVER, which is not always what this invoice
  // takes. Blank means "exactly the applied amount plus the tip", the ordinary
  // case, so the common flow is still one field. Filling it in is how a $300
  // transfer against a $180 bill gets recorded as what it was.
  const [paidTotal, setPaidTotal] = useState('');
  // "Notes (staff only)" on her screen, and staff-only here: nothing
  // kinfolk-facing reads the root `payments` collection.
  const [paidNotes, setPaidNotes] = useState('');
  // "Will automatically apply any Unapplied amount to future invoices."
  const [paidAutoApply, setPaidAutoApply] = useState(false);
  const [paidSendConfirmation, setPaidSendConfirmation] = useState(false);

  // Edit mode. Seeded from the invoice the moment Edit is pressed rather than
  // held in sync with it: the live listener would otherwise overwrite what the
  // operator is typing every time the doc changed underneath them.
  const [editing, setEditing] = useState<EditDraft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  // Archive/restore confirm. Separate from `pending` because the ACTIONS array
  // is the state-driven action matrix and archiving is orthogonal to state: an
  // invoice in any state can be archived.
  const [archivePrompt, setArchivePrompt] = useState<ArchivePrompt | null>(null);

  // THE LEDGER: what was paid against this invoice, and which visits it bills.
  //
  // FETCHED, not streamed, unlike the invoice doc itself. The invoice arrives by
  // value from the Invoices screen's live `INVOICES_QUERY` listener, but neither
  // of these two can be listened to from a client at all:
  // `invoices/{id}/payments` has no rule in `firestore.rules` and is therefore
  // denied to every client, and the visits are a fan-out read over ids this doc
  // names. `getInvoiceLedger` is the only path to both, so this is a one-shot
  // load with an explicit reload after any action that could change either.
  const [ledger, setLedger] = useState<GetInvoiceLedgerResult | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(true);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  // Bumped to re-run the load. A counter rather than a boolean so two reloads in
  // a row (record a payment, then record another) both actually fire.
  const [ledgerNonce, setLedgerNonce] = useState(0);
  const reloadLedger = useCallback(() => setLedgerNonce((n) => n + 1), []);

  const todayIso = localDateIso(new Date());
  // The STORED stamp (ADR-0002): the server classified this doc in the same
  // write that last touched its money, so this panel reads the verdict and
  // never re-derives it. `state` is null only for a doc with no recognizable
  // stamp, which ADR-0002 makes impossible; the branches below keep that
  // fail-soft visible — neutral chip, no actions, no editing — rather than
  // silently re-classifying from the money fields.
  const { state, editScope } = invoiceStamp(invoice);
  const overdue = isInvoiceOverdue(state, invoice.dueDate, todayIso);
  // Part-paid is a display refinement of `open`, like overdue, never its own
  // state: it changes the chip and the copy and leaves the action set alone,
  // which is what keeps collecting the rest possible. See invoiceFormat.ts.
  const partial = invoicePartialPayment(state, invoice);
  const info = overdue
    ? { label: 'Overdue', chipLabel: 'OVERDUE', cssClass: 'overdue' }
    : partial
      ? { label: 'Part paid', chipLabel: 'PART PAID', cssClass: 'partpaid' }
      : state === null
        ? unstampedStateInfo(invoice.status)
        : invoiceStateInfo(state);
  const household = invoice.kinfolkName || invoice.client || 'Unknown';

  // AO-19: the actions offered are decided by the SAME stored state the
  // Invoices list chips and filters off, so the list and this panel can never
  // disagree about what an invoice is. A PAID invoice no longer offers "Mark
  // paid" (which the server rejects) or "Send reminder" (which would nag a
  // household that already paid). `overdue` is deliberately NOT passed: it is
  // a display refinement of `open`, never its own state, so an overdue invoice
  // already resolves to the outstanding set. An unstamped doc is offered
  // nothing: no state, no claim about what acting on it would do.
  const allowed = state === null ? [] : invoiceActionsFor(state);
  const available = ACTIONS.filter((a) => allowed.includes(a.key));

  // `allowed.includes` is the guard on an ARMED action (see `initialAction`).
  // The list derives its row button from this same function, but the live
  // listener can deliver a newer doc between the click and this render: someone
  // else marks the invoice paid, and a "Send reminder" confirm would then be
  // offered for an invoice the server will refuse to remind about. A stale arm
  // silently falls back to the plain action list, which is what the operator
  // would have seen had they clicked the row instead.
  const meta =
    pending && allowed.includes(pending) ? ACTIONS.find((a) => a.key === pending) : undefined;

  // The stored itemization. NULL means never itemized, which is not the same as
  // an empty list and must not be rendered as an empty items table: a heading
  // over no rows reads as "nothing was billed".
  const storedLines = invoiceLineItems(invoice);
  const archived = isArchivedInvoice(invoice);

  // THE DISAGREEMENT CHECK. See lib/invoiceReconcile.ts for why this is a real
  // reachable state and not defensive theatre: firestore.rules grants
  // `allow update: if isAuntie()` over the whole collection and postInvoiceEvent
  // merges an arbitrary payload, so both bypass every callable that would have
  // kept the total and the lines in step.
  const totalCheck = checkInvoiceTotal(invoice);
  // Recomputed every render from the boxes themselves, so it can never lag the
  // number she is looking at. Null while something is half-typed.
  const unapplied = unappliedPreview({
    paymentTotal: paidTotal,
    applied: paidAmount,
    tip: paidTip,
    fallbackApplied: invoice.amountDue,
  });

  // The STORED editScope decides only whether to OFFER the control; the server
  // still enforces on the write, and a refusal comes back with a code and is
  // surfaced verbatim. This used to be a 191-line mirrored policy computing the
  // scope from `paidCents`; the server now persists its own answer next to the
  // state (ADR-0002), so offering is reading. `invoiceStamp` answered 'none'
  // for an unstamped doc — the safe affordance — so no extra null-check here.
  const canEdit = editScope !== 'none';
  const moneyEditable = editScope === 'all';

  const invoiceId = invoice._id;
  useEffect(() => {
    // `stale` guards the resolve, not the request: the panel can be closed, or
    // reloaded again, while a call is in flight, and a late answer must not
    // overwrite a newer one or set state on an unmounted component.
    let stale = false;
    setLedgerLoading(true);
    setLedgerError(null);
    getInvoiceLedger(invoiceId)
      .then((res) => {
        if (stale) return;
        setLedger(res);
        setLedgerLoading(false);
      })
      .catch((caught: unknown) => {
        if (stale) return;
        // Verbatim, same rule as every other refusal on this panel. The server's
        // messages name the invoice and the reason, and rewording one here would
        // lose the part that says what to do next.
        setLedgerError(
          `getInvoiceLedger failed: ${caught instanceof Error ? caught.message : 'Load failed'}`,
        );
        setLedgerLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [invoiceId, ledgerNonce]);

  function startAction(key: PendingAction) {
    setActionError(null);
    setNotice(null);
    setPaidMethod('');
    setPaidReference('');
    // Blank, not zero. An empty tip box is "no tip entered"; a prefilled $0.00
    // is a claim that there was none, and she would have to clear it to type one.
    setPaidTip('');
    setPaidFee('');
    setPaidTotal('');
    setPaidNotes('');
    setPaidAutoApply(false);
    // OFF by default. A confirmation is a message to a real household, so it
    // goes out because she ticked the box, never because the panel assumed.
    setPaidSendConfirmation(false);
    // Prefilled with the outstanding balance so the common case is one click,
    // and editable so a partial is one field away rather than impossible.
    setPaidAmount(key === 'markPaid' && invoice.amountDue > 0 ? String(invoice.amountDue) : '');
    setPending(key);
  }

  function cancelPending() {
    if (busy) return;
    setPending(null);
  }

  function startEditing() {
    setActionError(null);
    setNotice(null);
    setEditError(null);
    setEditing({
      invoiceNumber: invoice.invoiceNumber,
      date: invoice.date,
      dueDate: invoice.dueDate,
      terms: (invoice as { terms?: string }).terms ?? '',
      lines: (storedLines ?? []).map(draftFromLineItem),
      invoiceDiscountText:
        typeof invoice.invoiceDiscountCents === 'number' && invoice.invoiceDiscountCents > 0
          ? centsToInputDollars(invoice.invoiceDiscountCents)
          : '',
      wasItemized: storedLines !== null,
      moneyEditable,
    });
  }

  async function saveEdit() {
    if (!editing || busy) return;

    // The patch type is the contract's (ADR-0001), which accepts FOUR fields
    // this panel does not offer: `kinfolkName`, `client`, `address` and
    // `discount`. That is not an oversight to fix in passing here, it is a
    // capability the edit form never grew; surfacing it is a UI change and its
    // own concern.
    const patch: UpdateInvoiceArgsPatch = {};
    // Only CHANGED fields go in the patch. Echoing an unchanged value back would
    // still stamp `updatedAt` and write an audit entry describing an edit that
    // did not happen.
    if (editing.invoiceNumber !== invoice.invoiceNumber) patch.invoiceNumber = editing.invoiceNumber.trim();
    if (editing.date !== invoice.date) patch.date = editing.date.trim();
    if (editing.dueDate !== invoice.dueDate) patch.dueDate = editing.dueDate.trim();
    if (editing.terms !== ((invoice as { terms?: string }).terms ?? '')) patch.terms = editing.terms;

    if (editing.moneyEditable) {
      const parsed = parseDraftLines(editing.lines, editing.invoiceDiscountText);
      if (parsed.error !== null) {
        setEditError(parsed.error);
        return;
      }
      // THE UN-ITEMIZED GUARD, mirrored on the client so a metadata-only edit
      // never becomes a money edit by accident. An invoice that was never
      // itemized and still has no lines sends NO `lineItems` key at all: sending
      // an empty array would tip `updateInvoice` into recomputing, and a real
      // $40 invoice would be rewritten to $0 because its due date was corrected.
      const touchedMoney = editing.wasItemized || parsed.lines!.length > 0;
      if (touchedMoney) {
        patch.lineItems = parsed.lines!;
        patch.invoiceDiscountCents = parsed.invoiceDiscountCents!;
      }
    }

    if (Object.keys(patch).length === 0) {
      setEditError('Nothing has changed yet.');
      return;
    }

    setBusy(true);
    setEditError(null);
    try {
      await updateInvoice(invoice._id, patch);
      setBusy(false);
      setEditing(null);
      setNotice('Invoice updated.');
      // A line-item edit recomputes the balance server-side, so the "Still owed"
      // figure in the payments panel is now describing the invoice as it was.
      reloadLedger();
    } catch (caught) {
      setBusy(false);
      // Surfaced verbatim. The server's refusals carry a `details.code` and a
      // sentence written for the operator (money locked by a recorded payment,
      // a discount larger than its line), and rewording them here would lose
      // exactly the part that says what to do next.
      setEditError(`updateInvoice failed: ${caught instanceof Error ? caught.message : 'Save failed'}`);
    }
  }

  async function confirmArchive(force: boolean) {
    if (!archivePrompt || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      if (archivePrompt.direction === 'restore') {
        await unarchiveInvoice(invoice._id);
        setNotice('Invoice restored to the working list.');
      } else {
        await archiveInvoice(invoice._id, force);
        setNotice(
          force
            ? 'Invoice archived, and the balance written off the outstanding total.'
            : 'Invoice archived.',
        );
      }
      setBusy(false);
      setArchivePrompt(null);
    } catch (caught) {
      setBusy(false);
      const message = caught instanceof Error ? caught.message : 'Action failed';
      // The server refuses an archive that would drop real money out of the
      // outstanding total. That is not an error to bounce off; it is a decision
      // to put back to the operator, so the prompt re-renders offering the
      // write-off explicitly rather than just reporting a failure.
      const stillOwing = /still has \$/.test(message) || /owing/i.test(message);
      if (stillOwing && archivePrompt.direction === 'archive') {
        setArchivePrompt({ direction: 'archive', forceOffered: true });
        setActionError(message);
      } else {
        setArchivePrompt(null);
        setActionError(
          `${archivePrompt.direction === 'archive' ? 'archiveInvoice' : 'unarchiveInvoice'} failed: ${message}`,
        );
      }
    }
  }

  async function confirmPending() {
    if (!meta || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      let outcome = meta.successMessage;

      if (meta.key === 'reminder') await sendInvoiceReminder(invoice._id);
      else if (meta.key === 'reviewSend') await reviewAndSendDraftInvoice(invoice._id);
      else if (meta.key === 'markPaid') {
        const method = paidMethod.trim();
        const reference = paidReference.trim();
        const typed = paidAmount.trim();

        // Validated here rather than by the input's type, so the operator gets a
        // sentence instead of a silently-ignored keystroke. An unparseable
        // amount is refused outright: guessing at it would record real money
        // against a household.
        let amount: number | undefined;
        if (typed !== '') {
          const parsed = Number(typed.replace(/^\$/, ''));
          if (!Number.isFinite(parsed) || parsed <= 0) {
            setBusy(false);
            setActionError(`"${typed}" is not an amount. Enter dollars, for example 20 or 20.50.`);
            return;
          }
          amount = parsed;
        }
        // The tip and the fee, same rule and same reason. A blank box is zero;
        // a box with something unparseable in it is a refusal, because that is
        // a keystroke she meant and the panel would otherwise drop it silently.
        const tip = parseOptionalMoney(paidTip);
        if (tip === null) {
          setBusy(false);
          setActionError(`"${paidTip.trim()}" is not a tip. Enter dollars, for example 10 or 10.50.`);
          return;
        }
        const fee = parseOptionalMoney(paidFee);
        if (fee === null) {
          setBusy(false);
          setActionError(`"${paidFee.trim()}" is not a fee. Enter dollars, for example 2.71.`);
          return;
        }
        const typedTotal = parseOptionalMoney(paidTotal);
        if (typedTotal === null) {
          setBusy(false);
          setActionError(
            `"${paidTotal.trim()}" is not a payment amount. Enter dollars, for example 300 or 300.50.`,
          );
          return;
        }
        // THE UNAPPLIED BALANCE, checked before anything is written. It is the
        // figure the operator watches to catch a mis-keyed amount, so the panel
        // must refuse the impossible version of it rather than let the server
        // do it after `markInvoicePaid` has already collected.
        const appliedForCheck = amount ?? invoice.amountDue;
        if (typedTotal > 0 && typedTotal < appliedForCheck + tip) {
          setBusy(false);
          setActionError(
            `A payment of ${formatUsd(typedTotal)} does not cover ${formatUsd(appliedForCheck)} applied plus a ${formatUsd(tip)} tip. Raise the payment amount, or lower one of the other two.`,
          );
          return;
        }

        // STEP 1 OF 2, AND THE ORDER MATTERS. `markInvoicePaid` is the money
        // authority: it writes the `invoices/{id}/payments` subcollection and
        // re-derives the balance from the sum of every recorded payment. Its
        // failure is fatal to the whole action, because nothing was written and
        // no payment happened. Same sequence Android has run since W2-2.
        const res = await markInvoicePaid(invoice._id, {
          ...(amount !== undefined && { amount }),
          ...(method !== '' && { method }),
          ...(reference !== '' && { reference }),
        });

        // WHAT THIS ONE PAYMENT WAS WORTH, which is NOT `res.paidCents`: that
        // figure is everything ever collected on the invoice, so sending it to
        // step 2 would book a $40 ledger row for a $20 second payment.
        //
        // Two exact sources, and no third. The operator's own typed amount, or
        // the difference between the server's new cumulative total and the
        // cumulative total the loaded ledger already showed. Both of those come
        // from the same subcollection, so they cannot disagree. When neither is
        // available (the amount was left blank AND the ledger read failed) no
        // row is written at all: a guessed figure on a payment record is worse
        // than a missing one.
        const typedCents = amount !== undefined ? Math.round(amount * 100) : null;
        const derivedCents = ledger !== null ? res.paidCents - ledger.paidCents : null;
        const thisPaymentCents = typedCents ?? derivedCents;

        // STEP 2 OF 2, BEST-EFFORT. The ROOT `payments` collection is the
        // display ledger the Payments screens and every report read. Until now
        // this app never wrote it, so a payment taken through the web admin was
        // invisible to those screens while Android's identical action showed up
        // in both. It is deliberately NOT folded into step 1: the settlement
        // arithmetic never reads this collection, which is exactly what stops
        // the two rows double-counting against each other.
        //
        // A failure here is REPORTED and does not fail the action. The money has
        // already moved and the invoice is already settled, so throwing now
        // would offer a retry that collects a second time. The operator is told
        // what is missing and where, rather than told nothing or told a lie.
        let ledgerNote = '';
        if (thisPaymentCents === null || thisPaymentCents <= 0) {
          ledgerNote =
            " No row was added to the payment ledger, because this payment's own amount could not be stated exactly: it was left blank and the invoice's recorded payments could not be read. The invoice itself is correct; add the ledger row from the Payments screen.";
        } else {
          try {
            const ledgerRow = await recordPayment({
              kinfolkId: invoice.kinfolkId,
              kinfolkName: invoice.kinfolkName,
              client: invoice.client,
              date: localDateIso(new Date()),
              paymentMethod: method,
              referenceNumber: reference,
              // THE WHOLE SUM THE CLIENT PAID, tip and any leftover included.
              // `markInvoicePaid` above settled the bill with the applied part;
              // this row is the TRANSACTION, which is larger whenever there was
              // a tip or money over.
              amount: typedTotal > 0 ? typedTotal : thisPaymentCents / 100 + tip,
              tip,
              fee,
              notes: paidNotes.trim(),
              autoApply: paidAutoApply,
              sendConfirmationEmail: paidSendConfirmation,
              invoiceId: invoice._id,
              invoiceNumber: invoice.invoiceNumber,
            });
            // NO `apply` FIELD, deliberately. `markInvoicePaid` has already
            // settled this invoice two steps up; sending an apply here would put
            // the same money against the same bill a second time. The Apply
            // amount for this flow IS what markInvoicePaid collected.
            if (paidSendConfirmation && !ledgerRow.confirmationEmailSent) {
              ledgerNote +=
                ' The confirmation email did not go out (the household may have no portal account). The payment itself is recorded.';
            }
            if (ledgerRow.creditedToAccountCents > 0) {
              ledgerNote += ` ${formatUsd(ledgerRow.creditedToAccountCents / 100)} was left over and has been added to the household's account credit, which goes onto their next invoice automatically.`;
            }
          } catch (caught) {
            ledgerNote = ` The payment ledger row did not save (${
              caught instanceof Error ? caught.message : 'recordPayment failed'
            }), so this payment will not appear on the Payments screen. The invoice itself is correct.`;
          }
        }

        // WHAT THE SERVER SAYS HAPPENED, not what the button was called. The
        // whole defect this change fixes was a UI that reported "paid" for a
        // payment that paid off half the invoice.
        outcome =
          (res.state === 'partial'
            ? `Partial payment recorded. ${formatUsd(res.amountDueCents / 100)} is still owed, and the invoice stays open.`
            : res.state === 'overpaid'
              ? `Payment recorded and the invoice is settled. It was overpaid by ${formatUsd(res.overpaidCents / 100)}, which has not been turned into a credit; issue one if that is what the household is owed.`
              : 'Payment recorded. The invoice is paid in full.') + ledgerNote;

        // Both halves of the panel below now describe a stale invoice: the
        // payment just written is in neither list.
        reloadLedger();
      } else await generateReceipt(invoice._id);

      setBusy(false);
      setNotice(outcome);
      setPending(null);
    } catch (caught) {
      setBusy(false);
      setActionError(`${meta.callableName} failed: ${caught instanceof Error ? caught.message : 'Action failed'}`);
    }
  }

  // Stable across re-renders, see InvoiceCreate.tsx's identical note: Dialog's
  // focus-management effect keys off `onClose`'s identity, so a fresh inline
  // arrow here would re-grab focus onto the panel after every action's
  // re-render (each button click, each busy/notice/error state change).
  const handleDialogClose = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  return (
    <Dialog title={`Invoice #${invoice.invoiceNumber || '(none)'}`} onClose={handleDialogClose}>
      <div className="invoice-detail">
        <div className="invoice-detail__summary">
          <span className="invoice-detail__household">{household}</span>
          <span className={`invoices__chip invoices__chip--${info.cssClass}`}>{info.chipLabel}</span>
        </div>
        <dl className="invoice-detail__facts">
          <div className="invoice-detail__fact">
            <dt>Total</dt>
            <dd>{formatUsd(invoice.total)}</dd>
          </div>
          {partial && (
            <div className="invoice-detail__fact">
              <dt>Paid so far</dt>
              <dd>{formatUsd(partial.paidCents / 100)}</dd>
            </div>
          )}
          <div className="invoice-detail__fact">
            <dt>{partial ? 'Still owed' : 'Amount due'}</dt>
            <dd>{formatUsd(invoice.amountDue)}</dd>
          </div>
          <div className="invoice-detail__fact">
            <dt>Due date</dt>
            <dd>{invoice.dueDate.trim() === '' ? 'not set' : invoice.dueDate}</dd>
          </div>
        </dl>

        {/* THE LINES-VERSUS-TOTAL DISAGREEMENT BANNER.
            It names BOTH figures and reconciles NEITHER. It does not pick a
            winner, does not re-derive the total for display, and does not write
            a correction: a silent repair to a money field is how this drift
            arises in the first place. The operator is the only one who knows
            which number is the true one, so the banner's whole job is to make
            sure they are looking at both. See lib/invoiceReconcile.ts. */}
        {totalCheck.disagrees && totalCheck.storedTotalCents !== null && (
          <Banner tone="error" title="This invoice disagrees with itself">
            <p>
              The line items below add up to{' '}
              <strong>{formatCentsUsd(totalCheck.derivedTotalCents)}</strong>, but{' '}
              {storedTotalSourceLabel(totalCheck.storedFrom!)} says{' '}
              <strong>{formatCentsUsd(totalCheck.storedTotalCents)}</strong>.
            </p>
            <p>
              Nothing has been changed to make them match, and nothing will be. The household is
              billed the stored figure. This can happen when an invoice is written outside the
              normal edit path. Re-saving the line items below will recompute the stored total from
              them, if the lines are the version you want to keep.
            </p>
          </Banner>
        )}

        {archived && !notice && (
          <Banner tone="info" title="Archived">
            This invoice is out of the working list and out of the outstanding and billed totals. It
            has not been deleted or cancelled, and the household can still see it and still pay it.
          </Banner>
        )}

        {notice && (
          <Banner tone="success" title="Done">
            {notice}
          </Banner>
        )}
        {actionError && (
          <Banner tone="error" title="Action failed">
            {actionError}
          </Banner>
        )}

        {/* THE ITEMIZATION, or an explicit statement that there isn't one.
            An invoice that was never itemized renders a SENTENCE, not an empty
            table: a table with a heading and no rows reads as "nothing was
            billed", which is a different and much worse claim than "nobody has
            broken this invoice down". Every invoice created before Task 5.1 is
            in that state, so this is the common branch, not the edge case. */}
        {editing === null && (
          storedLines === null ? (
            <p className="invoice-detail__no-lines">
              This invoice has no itemized breakdown. Its total was entered directly. Edit it to add
              line items.
            </p>
          ) : storedLines.length === 0 ? (
            <p className="invoice-detail__no-lines">
              This invoice is itemized as billing nothing: it has a breakdown, and the breakdown is
              empty.
            </p>
          ) : (
            <InvoiceLineItemsTable
              lines={storedLines}
              invoiceDiscountCents={invoice.invoiceDiscountCents ?? 0}
            />
          )
        )}

        {/* THE TWO PANELS THIS OVERLAY WENT WITHOUT: what has been paid against
            this invoice, and which visits it bills. Both come from
            `getInvoiceLedger`, and both follow the itemization for the same
            reason Android orders them that way: what was billed, then what came
            in, then the work behind it. Hidden mid-edit, like the itemization
            directly above, so the edit form is the only thing on screen. */}
        {editing === null && (
          <InvoiceLedgerPanels
            ledger={ledger}
            loading={ledgerLoading}
            error={ledgerError}
            onRetry={reloadLedger}
            // The SAME stored-state answer the action buttons below are built
            // from, so the empty payments state can never point an operator at
            // a control this invoice is not offering.
            canRecordPayment={allowed.includes('markPaid')}
          />
        )}

        {editing !== null ? (
          <div className="invoice-detail__edit">
            {editError && (
              <Banner tone="error" title="Can't save">
                {editError}
              </Banner>
            )}
            {!editing.moneyEditable && (
              <Banner tone="warning" title="Money is locked">
                A payment has already been recorded against this invoice, so its line items and
                discounts cannot change. The number, dates and terms can still be corrected.
              </Banner>
            )}

            <div className="invoice-detail__edit-fields">
              <label className="invoice-detail__field">
                <span className="invoice-detail__field-label">Invoice number</span>
                <input
                  className="invoice-detail__field-input"
                  value={editing.invoiceNumber}
                  onChange={(e) => setEditing({ ...editing, invoiceNumber: e.target.value })}
                  disabled={busy}
                  aria-label="Invoice number"
                />
              </label>
              <label className="invoice-detail__field">
                <span className="invoice-detail__field-label">Date</span>
                {/* A real date input, per the plan: the free-text field it
                    replaces let "Net 14" into a field the server parses as
                    YYYY-MM-DD and the list sorts on. */}
                <input
                  type="date"
                  className="invoice-detail__field-input"
                  value={editing.date}
                  onChange={(e) => setEditing({ ...editing, date: e.target.value })}
                  disabled={busy}
                  aria-label="Invoice date"
                />
              </label>
              <label className="invoice-detail__field">
                <span className="invoice-detail__field-label">Due date</span>
                <input
                  type="date"
                  className="invoice-detail__field-input"
                  value={editing.dueDate}
                  onChange={(e) => setEditing({ ...editing, dueDate: e.target.value })}
                  disabled={busy}
                  aria-label="Invoice due date"
                />
              </label>
              <label className="invoice-detail__field">
                <span className="invoice-detail__field-label">Terms</span>
                <input
                  className="invoice-detail__field-input"
                  value={editing.terms}
                  onChange={(e) => setEditing({ ...editing, terms: e.target.value })}
                  disabled={busy}
                  aria-label="Invoice terms"
                />
              </label>
            </div>

            {editing.moneyEditable && (
              <InvoiceLineItemsEditor
                drafts={editing.lines}
                onChange={(lines) => setEditing({ ...editing, lines })}
                invoiceDiscountText={editing.invoiceDiscountText}
                onInvoiceDiscountChange={(invoiceDiscountText) =>
                  setEditing({ ...editing, invoiceDiscountText })
                }
                disabled={busy}
              />
            )}

            <div className="invoice-detail__confirm-actions">
              <GhostButton label="Cancel" onClick={() => !busy && setEditing(null)} disabled={busy} />
              <PrimaryButton
                label={busy ? 'Saving…' : 'Save changes'}
                onClick={() => void saveEdit()}
                disabled={busy}
                busy={busy}
              />
            </div>
          </div>
        ) : archivePrompt ? (
          <div className="invoice-detail__confirm">
            <p className="invoice-detail__confirm-copy">
              {archivePrompt.direction === 'restore'
                ? 'This puts the invoice back into the working list and back into the outstanding and billed totals. Continue?'
                : 'This takes the invoice out of the working list and out of the outstanding and billed totals. It does NOT delete it, cancel it, or forgive what is owed, and the household can still see it and still pay it. Continue?'}
            </p>
            {archivePrompt.forceOffered && (
              <p className="invoice-detail__confirm-copy">
                Archiving it anyway writes that balance off the outstanding total, so nothing will
                remind you to collect it. That choice is recorded separately in the audit trail.
              </p>
            )}
            <div className="invoice-detail__confirm-actions">
              <GhostButton
                label="Cancel"
                onClick={() => !busy && setArchivePrompt(null)}
                disabled={busy}
              />
              <PrimaryButton
                label={
                  busy
                    ? 'Working…'
                    : archivePrompt.direction === 'restore'
                      ? 'Restore invoice'
                      : archivePrompt.forceOffered
                        ? 'Archive anyway'
                        : 'Archive invoice'
                }
                onClick={() => void confirmArchive(archivePrompt.forceOffered)}
                disabled={busy}
                busy={busy}
              />
            </div>
          </div>
        ) : meta ? (
          <div className="invoice-detail__confirm">
            <p className="invoice-detail__confirm-copy">{meta.confirmCopy}</p>
            {meta.key === 'markPaid' && (
              <div className="invoice-detail__confirm-fields">
                {/* UNCHANGED, and still the first field. It is what comes off
                    this invoice's balance, and leaving it blank still means
                    "settle the rest". Everything added beside it is optional. */}
                <label className="invoice-detail__field">
                  <span className="invoice-detail__field-label">Amount collected</span>
                  <input
                    className="invoice-detail__field-input"
                    value={paidAmount}
                    onChange={(e) => setPaidAmount(e.target.value)}
                    placeholder={String(invoice.amountDue)}
                    inputMode="decimal"
                    disabled={busy}
                    aria-label="Amount collected in dollars"
                  />
                </label>
                <label className="invoice-detail__field">
                  <span className="invoice-detail__field-label">Tip, optional</span>
                  <input
                    className="invoice-detail__field-input"
                    value={paidTip}
                    onChange={(e) => setPaidTip(e.target.value)}
                    placeholder="0.00"
                    inputMode="decimal"
                    disabled={busy}
                    aria-label="Tip in dollars, before any processor fee"
                  />
                </label>
                <label className="invoice-detail__field">
                  <span className="invoice-detail__field-label">Fees, optional</span>
                  <input
                    className="invoice-detail__field-input"
                    value={paidFee}
                    onChange={(e) => setPaidFee(e.target.value)}
                    placeholder="0.00"
                    inputMode="decimal"
                    disabled={busy}
                    aria-label="Processor fee in dollars"
                  />
                </label>
                <label className="invoice-detail__field">
                  <span className="invoice-detail__field-label">
                    Payment amount, if more than the above
                  </span>
                  <input
                    className="invoice-detail__field-input"
                    value={paidTotal}
                    onChange={(e) => setPaidTotal(e.target.value)}
                    placeholder="same as collected plus tip"
                    inputMode="decimal"
                    disabled={busy}
                    aria-label="Total payment amount in dollars"
                  />
                </label>
                <label className="invoice-detail__field">
                  <span className="invoice-detail__field-label">Method, optional</span>
                  <input
                    className="invoice-detail__field-input"
                    value={paidMethod}
                    onChange={(e) => setPaidMethod(e.target.value)}
                    placeholder="check, cash, venmo…"
                    disabled={busy}
                    aria-label="Payment method"
                  />
                </label>
                <label className="invoice-detail__field">
                  <span className="invoice-detail__field-label">Reference, optional</span>
                  <input
                    className="invoice-detail__field-input"
                    value={paidReference}
                    onChange={(e) => setPaidReference(e.target.value)}
                    placeholder="confirmation / check number"
                    disabled={busy}
                    aria-label="Payment reference"
                  />
                </label>
                <label className="invoice-detail__field invoice-detail__field--wide">
                  <span className="invoice-detail__field-label">Notes, staff only</span>
                  <input
                    className="invoice-detail__field-input"
                    value={paidNotes}
                    onChange={(e) => setPaidNotes(e.target.value)}
                    placeholder="not shown to the household"
                    disabled={busy}
                    aria-label="Staff-only notes on this payment"
                  />
                </label>
                {/* THE UNAPPLIED BALANCE, live. This is what it is for: it is
                    how a mis-keyed amount is caught while it is still a typo.
                    The fee is deliberately not in it: a processor fee is a
                    deduction from what the business receives, not from what the
                    client paid. */}
                <p className="invoice-detail__unapplied" role="status">
                  {unapplied === null ? (
                    <span className="invoice-detail__unapplied-unknown">
                      Unapplied balance: not yet, one of the amounts above cannot be read.
                    </span>
                  ) : (
                    <>
                      <span className="invoice-detail__unapplied-label">Unapplied balance</span>
                      <span className="invoice-detail__unapplied-value">
                        {formatUsd(unapplied)}
                      </span>
                      {unapplied > 0 && (
                        <span className="invoice-detail__unapplied-note">
                          {paidAutoApply
                            ? "left over, and it will be held as this household's account credit for their next invoice"
                            : 'left over, and it will not be applied to anything unless you switch on auto-apply'}
                        </span>
                      )}
                    </>
                  )}
                </p>
                <label className="invoice-detail__check">
                  <input
                    type="checkbox"
                    checked={paidAutoApply}
                    onChange={(e) => setPaidAutoApply(e.target.checked)}
                    disabled={busy}
                  />
                  <span>Automatically apply any unapplied amount to future invoices</span>
                </label>
                <label className="invoice-detail__check">
                  <input
                    type="checkbox"
                    checked={paidSendConfirmation}
                    onChange={(e) => setPaidSendConfirmation(e.target.checked)}
                    disabled={busy}
                  />
                  <span>Send a confirmation email to the household</span>
                </label>
              </div>
            )}
            <div className="invoice-detail__confirm-actions">
              <GhostButton label="Cancel" onClick={cancelPending} disabled={busy} />
              <PrimaryButton
                label={busy ? meta.busyLabel : meta.confirmLabel}
                onClick={() => void confirmPending()}
                disabled={busy}
                busy={busy}
              />
            </div>
          </div>
        ) : (
          <div className="invoice-detail__actions">
            {available.length === 0 ? (
              <p className="invoice-detail__no-actions">
                {state === null
                  ? // The deliberate fail-soft for a doc with no recognizable
                    // state stamp (impossible per ADR-0002): say so, offer
                    // nothing, and never guess a state from the money fields.
                    'This invoice carries no recognized state, so no collection actions are offered.'
                  : `No collection actions for a ${info.label.toLowerCase()} invoice.`}
              </p>
            ) : (
              available.map((a) => (
                <GhostButton key={a.key} label={a.label} onClick={() => startAction(a.key)} />
              ))
            )}
            {/* Edit is offered per the STORED editScope, purely so the operator
                is not handed a control the server will reject. The server is the
                enforcement; a refusal that gets through comes back with a code
                and a sentence, and is shown verbatim above. */}
            {canEdit && <GhostButton label="Edit" onClick={startEditing} />}
            {/* Archive is deliberately NOT part of the state-driven action
                matrix. That matrix answers "what can be done about the money",
                and archiving is orthogonal to it: an invoice in any state can be
                taken out of the working list. */}
            <GhostButton
              label={archived ? 'Restore' : 'Archive'}
              onClick={() =>
                setArchivePrompt({
                  direction: archived ? 'restore' : 'archive',
                  forceOffered: false,
                })
              }
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}
