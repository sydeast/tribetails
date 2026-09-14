import { useCallback, useEffect, useRef, useState } from 'react';
import {
  invoiceDispute,
  invoiceDisputeDeadline,
  invoiceDisputeReasonGloss,
  invoiceDisputeTimeLeft,
  invoiceLineItems,
  invoiceQuoteDecision,
  invoiceStamp,
  isArchivedInvoice,
  type InvoiceDispute,
  type InvoiceEntry,
} from '../api/invoices';
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
import { lastReminderLabel, reminderOutcomeMessage } from '../lib/invoiceReminder';
import {
  markInvoicePaid,
  sendInvoiceReminder,
  generateReceipt,
  getInvoiceLedger,
  recordPayment,
  resendQuote,
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
import { phaseOfError } from '../lib/offlineWrite';
import {
  mintInvoicePaymentIdempotencyKey,
  mintPaymentIdempotencyKey,
} from '../lib/moneyIdempotency';
import './InvoiceDetail.css';

/**
 * What this panel says when a money action fails (#807).
 *
 * THE SENTENCE THAT MATTERS IS WHICH OF THREE THINGS HAPPENED, and until now
 * all three read the same: "markInvoicePaid failed: internal". The SDK reports
 * `functions/internal` for every transport failure, so that one string covered
 * "never left the device", "we cannot tell", and a genuine server refusal —
 * and on this panel those call for different actions:
 *
 *   blocked  nothing was sent. Re-enter it when there is a signal. Safe.
 *   unknown  it was away when the signal went. SINCE #825 THIS IS SAFE TO
 *            RE-SUBMIT, and the sentence below says so rather than sending the
 *            operator off to check by hand. Both money callables in this
 *            panel's flow now carry a caller-minted `idempotencyKey` — the id
 *            of the row each will write — and the panel holds one pair of keys
 *            for as long as the form is unchanged, so pressing again lands on
 *            the rows the first press may already have written.
 *
 *            What that fixed: `recordPayment` wrote an auto-id row into the
 *            root `payments` collection with no dedupe of any kind and, with
 *            `autoApply`, also incremented `families/{id}.accountBalanceCents`
 *            — so a second one was a double-counted payment AND spendable
 *            credit made from nothing. `markInvoicePaid` refused a replay only
 *            when the first call SETTLED the invoice; on an explicit partial
 *            it wrote a second subcollection row and dropped the balance twice.
 *
 *            EDITING THE FORM MINTS NEW KEYS, because an edited payment is a
 *            different payment. So the safe advice still depends on leaving the
 *            form alone, and the sentence says that.
 *   failed   the server answered. Its own sentence is the useful one.
 *
 * The offline classes carry their whole sentence, so the callable-name prefix
 * is dropped for them: "markInvoicePaid failed: This device is offline…" reads
 * as a bug in the app rather than a fact about the phone.
 */
export function invoiceActionError(caught: unknown, callableName: string): string {
  const phase = phaseOfError(caught);
  const message = caught instanceof Error && caught.message ? caught.message : 'Action failed';
  if (phase === 'blocked') return message;
  if (phase === 'unknown') {
    return `${message} Press the same button again WITHOUT changing anything: this payment carries a key that makes a second attempt land on the same record. Changing a figure first would make it a different payment.`;
  }
  return `${callableName} failed: ${message}`;
}

/**
 * THE CHARGEBACK PANEL: the only thing on this screen that can contradict the
 * PAID chip six lines above it.
 *
 * A dispute deliberately does not un-pay the invoice — flipping it back to
 * outstanding would restart the reminder cron against a household over their own
 * bank's action, and writing a reversing payment row would invent a repayment
 * nobody made (functions/src/billing/stripeDispute.ts). The cost of that correct
 * decision is that a clawed-back invoice looks settled everywhere. This panel is
 * where that debt is paid back to the operator.
 *
 * TONE IS DECIDED BY ONE FLAG AND ONE ONLY, `dispute.open`. Nothing clears
 * `disputeStatus`, so an invoice disputed once carries it forever; keying the
 * alarm off "there is a status" would light up every invoice that was ever
 * contested and won, permanently. A won dispute is history and reads as history.
 *
 * NO FIGURE APPEARS HERE THAT STRIPE DID NOT SEND. The disputed amount is
 * printed when the event carried one and named in words when it did not, never
 * as $0.00. The actual debit — disputed amount plus Stripe's dispute fee — is
 * described but never computed, because the fee is not on the object and a
 * subtraction we cannot source is a lie with a dollar sign on it.
 *
 * There is no dismiss, no clear, no "resolve" button, by design.
 */
/**
 * The deadline as a date the operator can read, in THEIR timezone.
 *
 * No `timeZone` option, deliberately. The webhook stores epoch milliseconds and
 * formats nothing, "because a date rendered in the backend is a date rendered in
 * the SERVER'S locale and timezone, and the operator reading it is not there"
 * (stripeDispute.ts). `timeZoneName` is spelled out because a deadline whose
 * zone is ambiguous is a deadline with a several-hour error bar on it.
 *
 * Explicit component options rather than `dateStyle`/`timeStyle`: `timeZoneName`
 * cannot legally be combined with those, and the zone is not optional here.
 */
function formatDisputeDeadline(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(ms));
}

/**
 * WHY THE CARDHOLDER IS DISPUTING.
 *
 * The raw Stripe token is always shown, and plain English joins it when this
 * build has a gloss for that category. A token with no gloss renders alone: it
 * is not relabelled `general`, not called "Unknown", and it certainly does not
 * take the banner down with it. `reason` is a plain `string` in the pinned SDK
 * and Stripe ships new categories on its own schedule, so an unfamiliar one is
 * the expected case rather than the broken one.
 *
 * Renders on the closed-history banner too. The reason a dispute happened is
 * worth keeping once it is over; the clock is not.
 */
function InvoiceDisputeReason({ reason }: { reason: string }) {
  const gloss = invoiceDisputeReasonGloss(reason);
  return (
    <p className="invoice-detail__dispute-reason" data-dispute-reason={reason}>
      The bank filed it as <strong>{reason}</strong>
      {gloss !== null ? <>: {gloss}.</> : <>. This build has no plain-English description for that
        category, which means Stripe has added one since it shipped; the Stripe dashboard has
        Stripe's own wording for it.</>}
    </p>
  );
}

/**
 * BY WHEN THE OPERATOR MUST ACT — or an honest account of why there is no clock.
 *
 * Renders nothing at all unless the dispute is answerable (see
 * `invoiceDisputeDeadline`), so a settled dispute cannot show a countdown to a
 * date that has stopped meaning anything. The three states it does render are
 * three different sentences, and two of them are refusals:
 *
 *  - `due`: the date and how long is left. The one place urgency is earned.
 *  - `unstated`: Stripe stated no deadline. That covers a `due_by` of 0, which
 *    Stripe sends to mean the issuing bank allows NO response at all, and a
 *    dispute record that carried no deadline. Neither is a date; neither gets a
 *    countdown; both get pointed at the Stripe dashboard.
 *  - `passed`: the window shut. NOT a verdict — `disputeStatus` here is a
 *    webhook mirror and can still read `needs_response` after Stripe has closed
 *    the dispute, so the screen states the clock, admits the status can lag, and
 *    leaves the outcome to Stripe. A negative countdown would be arithmetic that
 *    is right attached to a sentence that is nonsense.
 */
function InvoiceDisputeDeadlineLine({ dispute, nowMs }: { dispute: InvoiceDispute; nowMs: number }) {
  const deadline = invoiceDisputeDeadline(dispute, nowMs);
  if (deadline.state === 'none') return null;

  if (deadline.state === 'unstated') {
    return (
      <p className="invoice-detail__dispute-deadline" data-deadline-state="unstated">
        Stripe has stated no response deadline for this dispute. That can mean the issuing bank
        allows no response to it at all, so there is no countdown to show and none is being guessed
        at. Open the dispute in the Stripe dashboard to see what it will accept.
      </p>
    );
  }

  if (deadline.state === 'passed') {
    return (
      <p className="invoice-detail__dispute-deadline" data-deadline-state="passed">
        The window to respond closed on <strong>{formatDisputeDeadline(deadline.dueByMs)}</strong>.
        This screen still shows the dispute as awaiting a response, and that reading comes from
        Stripe by webhook and can lag behind Stripe itself, so what happened after the window shut
        is not something this screen knows. Open the dispute in the Stripe dashboard before
        assuming it is either still answerable or already settled.
      </p>
    );
  }

  return (
    <p className="invoice-detail__dispute-deadline" data-deadline-state="due">
      Respond by <strong>{formatDisputeDeadline(deadline.dueByMs)}</strong>:{' '}
      <strong>{invoiceDisputeTimeLeft(deadline.msRemaining)}</strong>. A chargeback nobody answers
      in time is lost by default, so this date decides the money on its own.
    </p>
  );
}

function InvoiceDisputeBanner({ dispute, nowMs }: { dispute: InvoiceDispute; nowMs: number }) {
  const amount =
    dispute.amountCents !== null ? (
      <>
        The bank is disputing <strong>{formatCentsUsd(dispute.amountCents)}</strong>.
      </>
    ) : (
      <>The dispute event did not carry an amount, so how much is contested is not stated here.</>
    );

  if (!dispute.open) {
    return (
      <Banner tone="info" title="Dispute won" dismissible className="invoice-detail__dispute">
        <p>
          This payment was disputed and the dispute was resolved in your favor. Nothing was
          undone, because nothing needed undoing: the invoice was never un-paid while the contest
          ran. {amount}
        </p>
        {dispute.reason !== null && <InvoiceDisputeReason reason={dispute.reason} />}
        <p>
          {dispute.fundsState === 'withdrawn'
            ? 'The money has not been reported back in the Stripe balance yet. Stripe reinstates funds after the ruling rather than at the moment of it, so a gap here is ordinary.'
            : dispute.fundsState === 'reinstated'
              ? 'Stripe has reported the money back in the balance.'
              : 'Stripe has reported no movement of the balance either way.'}{' '}
          This stays on record because the dispute genuinely happened; it is not something to
          clear.
          {dispute.disputeId !== null ? ` Stripe dispute ${dispute.disputeId}.` : ''}
        </p>
      </Banner>
    );
  }

  return (
    <Banner tone="error" title="This payment is being taken back" className="invoice-detail__dispute">
      <p>
        {dispute.status !== null ? (
          <>
            The cardholder's bank has raised a chargeback and Stripe puts it at{' '}
            <strong>{dispute.status}</strong>.
          </>
        ) : (
          <>
            The cardholder's bank has raised a chargeback. Stripe has not said where the dispute
            stands, only that the money moved.
          </>
        )}{' '}
        {amount}
        {dispute.disputeId !== null ? ` Stripe dispute ${dispute.disputeId}.` : ''}
      </p>
      {dispute.reason !== null && <InvoiceDisputeReason reason={dispute.reason} />}
      <InvoiceDisputeDeadlineLine dispute={dispute} nowMs={nowMs} />
      <p>
        {dispute.fundsState === 'withdrawn'
          ? "The money has already been pulled out of the Stripe balance. What actually left is the disputed amount plus Stripe's dispute fee, and the fee is not on the record here, so read the real debit in the Stripe balance report rather than from this screen."
          : dispute.fundsState === 'reinstated'
            ? 'Stripe has reported the money back in the balance, while the contest itself is still open.'
            : 'Stripe has not yet reported the balance moving. It usually moves before the dispute closes, so treat this as not-yet-seen rather than as money that is safe.'}
      </p>
      <p>
        This invoice still reads paid and still shows nothing due, on purpose. Un-paying it would
        start sending the household overdue reminders over something their bank did, and recording
        a reversal would invent a repayment that never happened. Where contested money ends up is
        your call to make, not this screen's.
      </p>
    </Banner>
  );
}

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
/**
 * " on May 21, 2026", or an empty string when the doc carries no decision time.
 * A sentence that reads correctly either way, rather than a fabricated date.
 */
function quoteDecidedLabel(invoice: InvoiceEntry): string {
  // `.toDate()`, the accessor every other timestamp on this screen reads
  // through (`bookingFormat.ts`, `kinTaleList.ts`), rather than `.toMillis()`.
  const at = invoice.quoteDecidedAt?.toDate?.();
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return '';
  return ` on ${at.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })}`;
}
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
  /**
   * Whether the notice above is wholly good news.
   *
   * An action can land AND leave something undone: `markInvoicePaid` settles
   * the bill, then the payment-ledger row is written best-effort, and a failure
   * there is appended to the outcome sentence rather than thrown. Mark 10 of
   * the 2026-08-17 walk is what that looked like when the whole sentence
   * rendered green: "why green box when there was a failure". A banner may not
   * be the last thing to know the action was partly refused.
   */
  const [noticeIncomplete, setNoticeIncomplete] = useState(false);
  /**
   * When the household was last reminded about this invoice (#832). Seeded
   * from the stored stamp (the cron and this button both write it) and moved
   * to whatever the server answers, so the fact below is right the moment a
   * press lands, sent or refused, without waiting for the list to reload.
   */
  const [lastReminderAt, setLastReminderAt] = useState<unknown>(invoice.reminderNotifiedAtMs);
  // The invoice prop is the live row, so a stamp written while the panel is open
  // (the cron, another operator's press, another tab) arrives here and must
  // replace what the panel showed.
  useEffect(() => {
    setLastReminderAt(invoice.reminderNotifiedAtMs);
  }, [invoice.reminderNotifiedAtMs]);
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
  /**
   * #825: ONE PAIR OF KEYS PER SUBMISSION, held across a re-press.
   *
   * This flow makes TWO money writes — `markInvoicePaid` (the authority) and
   * `recordPayment` (the display ledger) — so it holds two keys, one shaped for
   * each callable's anchor row. They are minted lazily on the first press and
   * kept while the form is unchanged, which is exactly the case that used to
   * double-collect: the operator sees `functions/internal`, which the SDK
   * reports whether the request never arrived or the write committed and the
   * reply was lost, and presses again.
   *
   * KEEPING THEM ACROSS A PARTIAL FAILURE IS THE POINT. Step 1 can land and
   * step 2 fail; pressing again then replays step 1 (the server answers from
   * the row it already wrote, rather than collecting a second time) and writes
   * the ledger row that is genuinely missing. Without the keys, the only safe
   * advice after that was "go and look", and the only unsafe-but-tempting
   * action was to press again.
   *
   * Cleared by `startAction` (a new dialog is a new payment) and by the effect
   * below whenever any figure on the form changes (an edited payment is a
   * different payment, and a held key would report the first one's figures back
   * for money that was never collected).
   */
  const settleKey = useRef<string | null>(null);
  const ledgerKey = useRef<string | null>(null);
  useEffect(() => {
    settleKey.current = null;
    ledgerKey.current = null;
  }, [
    paidAmount,
    paidTip,
    paidFee,
    paidTotal,
    paidMethod,
    paidReference,
    paidNotes,
    paidAutoApply,
    paidSendConfirmation,
  ]);

  // Edit mode. Seeded from the invoice the moment Edit is pressed rather than
  // held in sync with it: the live listener would otherwise overwrite what the
  // operator is typing every time the doc changed underneath them.
  const [editing, setEditing] = useState<EditDraft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  // Archive/restore confirm. Separate from `pending` because the ACTIONS array
  // is the state-driven action matrix and archiving is orthogonal to state: an
  // invoice in any state can be archived.
  const [archivePrompt, setArchivePrompt] = useState<ArchivePrompt | null>(null);
  /**
   * The revise-and-resend confirm for a DECLINED quote (issue #448).
   *
   * Separate from `pending` for the same reason `archivePrompt` is: the ACTIONS
   * array is the state-driven matrix, and this action does not turn on the
   * state. A declined quote and one still waiting for an answer are BOTH in
   * state 'quote'; the household's answer is the only thing that tells them
   * apart, so it cannot be derived from `invoiceActionsFor`.
   */
  const [resendPrompt, setResendPrompt] = useState(false);

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
  const dispute = invoiceDispute(invoice);
  // The household's answer to a quote (issue #385). Read through the accessor
  // rather than off the cast, same rule as the stamp and the dispute.
  const quoteDecision = invoiceQuoteDecision(invoice);
  // The clock, read once per render and passed down rather than reached for
  // inside the banner. The countdown does NOT tick: a self-updating clock on a
  // panel measured in days would re-render the whole detail view every second to
  // move a figure nobody is watching, and a stale "3 days left" is off by at
  // most a day on a deadline weeks away. Reopening the invoice re-reads it.
  const nowMs = Date.now();

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
    setNoticeIncomplete(false);
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
    // A NEW DIALOG IS A NEW PAYMENT (#825). The effect above already clears
    // these whenever a figure changes, but opening the dialog is not a figure
    // change, and a key held from the last payment would report that one's
    // result back for this one.
    settleKey.current = null;
    ledgerKey.current = null;
    setPending(key);
  }

  function cancelPending() {
    if (busy) return;
    setPending(null);
  }

  function startEditing() {
    setActionError(null);
    setNoticeIncomplete(false);
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
      setNoticeIncomplete(false);
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
        setNoticeIncomplete(false);
        setNotice('Invoice restored to the working list.');
      } else {
        await archiveInvoice(invoice._id, force);
        setNoticeIncomplete(false);
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

  async function confirmResend() {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await resendQuote(invoice._id);
      setBusy(false);
      setResendPrompt(false);
      setNoticeIncomplete(false);
      setNotice('Quote sent again. The household can accept or decline it now.');
    } catch (caught) {
      setBusy(false);
      setResendPrompt(false);
      // Fail loud and verbatim: every refusal this callable makes names what to
      // do next (give it a new due date, send a reminder instead), and
      // paraphrasing it here would throw that away.
      setActionError(
        `resendQuote failed: ${caught instanceof Error ? caught.message : 'Resend failed'}`,
      );
    }
  }

  async function confirmPending() {
    if (!meta || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      let outcome = meta.successMessage;
      // Set wherever an outcome sentence gets a clause saying part of this did
      // not happen. It drives the banner's tone below, so the colour and the
      // words can never disagree.
      let incomplete = false;

      if (meta.key === 'reminder') {
        const reminder = await sendInvoiceReminder(invoice._id);
        // Only a real time moves the fact. `null` means no reminder is on record,
        // which is what the panel already shows; it never blanks a stamp.
        if (reminder.lastReminderAtMs !== null) setLastReminderAt(reminder.lastReminderAtMs);
        outcome = reminderOutcomeMessage(reminder);
        // A refusal is not a failure (the household HAS been reminded), but it
        // is not "Done" either: nothing was sent by this press.
        if (!reminder.sent) incomplete = true;
      } else if (meta.key === 'reviewSend') await reviewAndSendDraftInvoice(invoice._id);
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
        settleKey.current ??= mintInvoicePaymentIdempotencyKey();
        ledgerKey.current ??= mintPaymentIdempotencyKey();
        const res = await markInvoicePaid(invoice._id, {
          ...(amount !== undefined && { amount }),
          ...(method !== '' && { method }),
          ...(reference !== '' && { reference }),
          idempotencyKey: settleKey.current,
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
          incomplete = true;
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
              idempotencyKey: ledgerKey.current,
            });
            // NO `apply` FIELD, deliberately. `markInvoicePaid` has already
            // settled this invoice two steps up; sending an apply here would put
            // the same money against the same bill a second time. The Apply
            // amount for this flow IS what markInvoicePaid collected.
            if (paidSendConfirmation && !ledgerRow.confirmationEmailSent) {
              incomplete = true;
              ledgerNote +=
                ' The confirmation email did not go out (the household may have no portal account). The payment itself is recorded.';
            }
            if (ledgerRow.creditedToAccountCents > 0) {
              ledgerNote += ` ${formatUsd(ledgerRow.creditedToAccountCents / 100)} was left over and has been added to the household's account credit, which goes onto their next invoice automatically.`;
            }
          } catch (caught) {
            incomplete = true;
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
      setNoticeIncomplete(incomplete);
      setNotice(outcome);
      setPending(null);
    } catch (caught) {
      setBusy(false);
      setActionError(invoiceActionError(caught, meta.callableName));
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
          <div className="invoice-detail__fact">
            <dt>Last reminder</dt>
            <dd>{lastReminderLabel(lastReminderAt)}</dd>
          </div>
        </dl>

        {/* FIRST OF THE BANNERS, above the disagreement one, because money that
            has left the balance outranks two figures that disagree on screen. */}
        {dispute !== null && <InvoiceDisputeBanner dispute={dispute} nowMs={nowMs} />}
        {/* WHAT THE HOUSEHOLD SAID ABOUT THIS QUOTE. Before issue #385 they had
            no way to say anything: `quote.accepted` and `quote.denied` were two
            switches on the notification gate with nothing behind them, and a
            quote sat in this panel until an operator asked in person.
            The declined case is the one that needs saying out loud. A declined
            quote keeps `status: 'quote'` (cancelling it would be the operator
            withdrawing it, which is a different fact and not what happened), so
            without this banner the panel reads as a quote still out for an
            answer that has already come back. */}
        {quoteDecision !== null && (
          <Banner
            tone={quoteDecision === 'accepted' ? 'success' : 'info'}
            title={quoteDecision === 'accepted' ? 'Quote accepted' : 'Quote declined'}
          >
            {quoteDecision === 'accepted' ? (
              <p>
                {`The household accepted this quote${quoteDecidedLabel(invoice)}, so it is an invoice now and the balance above is owed. The figures are locked from here: they are what the household agreed to. Issue a new quote if the work has changed.`}
              </p>
            ) : (
              <p>
                {`The household declined this quote${quoteDecidedLabel(invoice)}. Nothing is owed and nothing has been cancelled. Edit it and send it back out, and they can answer the revised one; the quote number and everything on it stay as they are.`}
              </p>
            )}
          </Banner>
        )}

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
          <Banner tone="info" title="Archived" dismissible>
            This invoice is out of the working list and out of the outstanding and billed totals. It
            has not been deleted or cancelled, and the household can still see it and still pay it.
          </Banner>
        )}

        {notice && (
          /* Tone follows the sentence. An action that settled the invoice but
             could not write the ledger row is not a green "Done", and the walk
             that produced mark 10 read the green before it read the words. */
          <Banner
            tone={noticeIncomplete ? 'warning' : 'success'}
            title={noticeIncomplete ? 'Done, but not all of it' : 'Done'}
          >
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
        ) : resendPrompt ? (
          <div className="invoice-detail__confirm">
            <p className="invoice-detail__confirm-copy">
              This sends the quote to the household again and clears the decline, so they can
              accept or decline the revised one. It is the SAME quote, keeping its number and its
              lines; nothing new is created. Send it now?
            </p>
            <div className="invoice-detail__confirm-actions">
              <GhostButton
                label="Cancel"
                onClick={() => !busy && setResendPrompt(false)}
                disabled={busy}
              />
              <PrimaryButton
                label={busy ? 'Sending…' : 'Send quote again'}
                onClick={() => void confirmResend()}
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
            {/* THE WAY OUT OF A DECLINE (issue #448). Offered only when the
                household has actually said no: one still waiting for an answer
                has nothing to revive (a reminder is the action for that), and an
                accepted one is agreed and frozen. Like Edit, this is an
                affordance, not the enforcement — the server refuses the other
                two by name and the refusal is shown verbatim above. */}
            {quoteDecision === 'denied' && (
              <GhostButton label="Revise and resend" onClick={() => setResendPrompt(true)} />
            )}
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
