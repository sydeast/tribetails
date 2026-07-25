import { useCallback, useState } from 'react';
import { type InvoiceEntry } from '../api/invoices';
import {
  formatUsd,
  invoiceActionsFor,
  invoicePartialPayment,
  invoiceState,
  invoiceStateInfo,
  isInvoiceOverdue,
  localDateIso,
  type InvoiceAction,
} from '../lib/invoiceFormat';
import {
  markInvoicePaid,
  sendInvoiceReminder,
  generateReceipt,
  reviewAndSendDraftInvoice,
} from '../api/invoicesWrite';
import { Dialog } from './Dialog';
import { PrimaryButton, GhostButton } from './Buttons';
import { Banner } from './Banner';
import './InvoiceDetail.css';

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
  onClose: () => void;
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
export function InvoiceDetail({ invoice, onClose }: InvoiceDetailProps) {
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [paidMethod, setPaidMethod] = useState('');
  const [paidReference, setPaidReference] = useState('');
  // Free text, not a number input, so a half-typed "2" is never read as $2.
  // Parsed and validated at submit, where the operator can be told what is wrong.
  const [paidAmount, setPaidAmount] = useState('');

  const todayIso = localDateIso(new Date());
  const state = invoiceState({
    status: invoice.status,
    amountDue: invoice.amountDue,
    total: invoice.total,
    creditRedeemed: invoice.creditRedeemedAt !== undefined,
  });
  const overdue = isInvoiceOverdue(state, invoice.dueDate, todayIso);
  // Part-paid is a display refinement of `open`, like overdue, never its own
  // state: it changes the chip and the copy and leaves the action set alone,
  // which is what keeps collecting the rest possible. See invoiceFormat.ts.
  const partial = invoicePartialPayment(state, invoice);
  const info = overdue
    ? { label: 'Overdue', chipLabel: 'OVERDUE', cssClass: 'overdue' }
    : partial
      ? { label: 'Part paid', chipLabel: 'PART PAID', cssClass: 'partpaid' }
      : invoiceStateInfo(state);
  const household = invoice.kinfolkName || invoice.client || 'Unknown';

  // AO-19: the actions offered are decided by the SAME enumerated state the
  // Invoices list chips and filters off (lib/invoiceFormat.ts), so the list and
  // this panel can never disagree about what an invoice is. A PAID invoice no
  // longer offers "Mark paid" (which the server rejects) or "Send reminder"
  // (which would nag a household that already paid). `overdue` is deliberately
  // NOT passed: it is a display refinement of `open`, never its own state, so
  // an overdue invoice already resolves to the outstanding set.
  const allowed = invoiceActionsFor(state);
  const available = ACTIONS.filter((a) => allowed.includes(a.key));

  const meta = pending ? ACTIONS.find((a) => a.key === pending) : undefined;

  function startAction(key: PendingAction) {
    setActionError(null);
    setNotice(null);
    setPaidMethod('');
    setPaidReference('');
    // Prefilled with the outstanding balance so the common case is one click,
    // and editable so a partial is one field away rather than impossible.
    setPaidAmount(key === 'markPaid' && invoice.amountDue > 0 ? String(invoice.amountDue) : '');
    setPending(key);
  }

  function cancelPending() {
    if (busy) return;
    setPending(null);
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

        const res = await markInvoicePaid(invoice._id, {
          ...(amount !== undefined && { amount }),
          ...(method !== '' && { method }),
          ...(reference !== '' && { reference }),
        });

        // WHAT THE SERVER SAYS HAPPENED, not what the button was called. The
        // whole defect this change fixes was a UI that reported "paid" for a
        // payment that paid off half the invoice.
        outcome =
          res.state === 'partial'
            ? `Partial payment recorded. ${formatUsd(res.amountDueCents / 100)} is still owed, and the invoice stays open.`
            : res.state === 'overpaid'
              ? `Payment recorded and the invoice is settled. It was overpaid by ${formatUsd(res.overpaidCents / 100)}, which has not been turned into a credit; issue one if that is what the household is owed.`
              : 'Payment recorded. The invoice is paid in full.';
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

        {meta ? (
          <div className="invoice-detail__confirm">
            <p className="invoice-detail__confirm-copy">{meta.confirmCopy}</p>
            {meta.key === 'markPaid' && (
              <div className="invoice-detail__confirm-fields">
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
                No actions available for a {info.label.toLowerCase()} invoice.
              </p>
            ) : (
              available.map((a) => (
                <GhostButton key={a.key} label={a.label} onClick={() => startAction(a.key)} />
              ))
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
