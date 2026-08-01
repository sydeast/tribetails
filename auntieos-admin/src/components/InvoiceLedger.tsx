import type { GetInvoiceLedgerResult } from '../contracts/invoiceContracts.generated';
import { formatCentsUsd } from '../lib/invoiceReconcile';
import {
  ledgerCoversBalance,
  ledgerRowTotalCents,
  paymentDayLabel,
  paymentMethodLabel,
  paymentsTotalCents,
  sessionDayLabel,
  sessionServiceLabel,
  sessionStatusLabel,
  sessionsWithBrokenBacklink,
} from '../lib/invoiceLedger';
import { Banner } from './Banner';
import { GhostButton } from './Buttons';
import './InvoiceLedger.css';

/**
 * The two panels the invoice detail overlay was missing: what has been PAID
 * against this invoice, and which VISITS it bills.
 *
 * MIRRORS THE ANDROID DETAIL SCREEN'S INFORMATION ARCHITECTURE
 * (`ui/invoices/InvoiceDetailScreen.kt`), which shipped both panels in the same
 * batch: Payments first, Linked Sessions after it, each a titled panel with a
 * per-row summary and an explicit empty sentence. The operator mock under
 * `ui-ideas/` for this screen is stale and sits in the REJECTED directory, so
 * Android is the shape authority here, not it.
 *
 * TWO DIFFERENCES FROM ANDROID, both deliberate and both because Android is
 * missing something rather than because this is a redesign:
 *
 *  1. THE AUTHORITY LIST IS SHOWN. Android's payments panel reads the ROOT
 *     `payments` collection only; it never sees `invoices/{id}/payments`, which
 *     is the subcollection `markInvoicePaid` writes and the one the invoice's
 *     balance is actually derived from. `getInvoiceLedger` returns both, so this
 *     panel leads with the authority and reports the root ledger beneath it,
 *     labelled, rather than presenting a display record as the money.
 *  2. THE BROKEN LINK IS NAMED. `linkInvoiceSessions` keeps both directions in
 *     step now, but a half-written link from before it is a shape live data can
 *     carry, and a visit billed on an invoice that does not claim it is money
 *     attributed to the wrong bill.
 *
 * NOTHING HERE CLASSIFIES OR RECONCILES. Every cents figure arrives computed by
 * the server (ADR-0002); the panel adds up the rows it is showing so its own
 * footer cannot disagree with them, and does nothing else with money.
 */

interface InvoiceLedgerPanelsProps {
  ledger: GetInvoiceLedgerResult | null;
  loading: boolean;
  /** Verbatim server refusal, or a transport failure. Never reworded. */
  error: string | null;
  onRetry: () => void;
  /**
   * Whether the overlay is currently offering the Record payment action, which
   * the stored invoice state decides. Passed in rather than re-derived: the
   * empty payments state points at that control, and pointing at a button a
   * cancelled or already-paid invoice does not have is worse than saying
   * nothing. Same conditional Android puts on its own empty hint.
   */
  canRecordPayment: boolean;
}

export function InvoiceLedgerPanels({
  ledger,
  loading,
  error,
  onRetry,
  canRecordPayment,
}: InvoiceLedgerPanelsProps) {
  // FAIL LOUD, AND FAIL ONCE. Both panels come from one callable, so one
  // failure is one message: two identical banners would read as two faults.
  if (error !== null) {
    return (
      <Banner
        tone="error"
        title="Couldn't load this invoice's payments or visits"
        trailing={<GhostButton label="Try again" onClick={onRetry} />}
      >
        <p>{error}</p>
        <p>
          Nothing below is missing because there is nothing to show; it is missing because the read
          failed. The invoice's own figures above are unaffected.
        </p>
      </Banner>
    );
  }

  if (loading || ledger === null) {
    return (
      <p className="invoice-ledger__loading" role="status">
        Loading payments and linked visits…
      </p>
    );
  }

  return (
    <>
      <PaymentsPanel ledger={ledger} canRecordPayment={canRecordPayment} />
      <SessionsPanel ledger={ledger} />
    </>
  );
}

/* ------------------------------------------------------------------ payments */

function PaymentsPanel({
  ledger,
  canRecordPayment,
}: {
  ledger: GetInvoiceLedgerResult;
  canRecordPayment: boolean;
}) {
  const { payments, ledgerPayments } = ledger;
  const recorded = paymentsTotalCents(payments);
  const stripeGap = ledgerCoversBalance(ledger);

  return (
    <section className="invoice-ledger" aria-labelledby="invoice-ledger-payments">
      <h3 className="invoice-ledger__heading" id="invoice-ledger-payments">
        Payments
      </h3>

      {payments.length === 0 ? (
        <p className="invoice-ledger__empty">
          No payment has been recorded against this invoice, so nothing has come off its balance.
          {canRecordPayment && ' Use Record payment below to log one.'}
        </p>
      ) : (
        <table className="invoice-ledger__table">
          <caption className="invoice-ledger__caption">
            What settled this invoice. Its balance is calculated from these and nothing else.
          </caption>
          <thead>
            <tr>
              <th scope="col">Method</th>
              <th scope="col">Date</th>
              <th scope="col">Reference</th>
              <th scope="col" className="invoice-ledger__num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.paymentId}>
                <td>{paymentMethodLabel(p.method)}</td>
                <td>{paymentDayLabel(p.paidAt)}</td>
                <td>
                  {p.reference === null || p.reference.trim() === '' ? (
                    <span className="invoice-ledger__missing">none</span>
                  ) : (
                    p.reference
                  )}
                </td>
                <td className="invoice-ledger__num">{formatCentsUsd(p.amountCents)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="invoice-ledger__total-row">
              <th scope="row" colSpan={3}>Collected</th>
              <td className="invoice-ledger__num">{formatCentsUsd(recorded)}</td>
            </tr>
            <tr>
              <th scope="row" colSpan={3}>Still owed</th>
              <td className="invoice-ledger__num">{formatCentsUsd(ledger.amountDueCents)}</td>
            </tr>
          </tfoot>
        </table>
      )}

      {/* THE ROOT LEDGER, SEPARATE AND SAID TO BE SEPARATE. These rows are real
          money on a real invoice, but the settlement arithmetic never reads
          them, so folding them into the table above would either double a
          payment recorded through both paths or claim a balance had moved when
          it had not. */}
      {ledgerPayments.length > 0 && (
        <table className="invoice-ledger__table">
          <caption className="invoice-ledger__caption">
            Also in the payment ledger. Recorded against this invoice for the books, and NOT counted
            in the figures above.
          </caption>
          <thead>
            <tr>
              <th scope="col">Method</th>
              <th scope="col">Date</th>
              <th scope="col">Reference</th>
              <th scope="col" className="invoice-ledger__num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {ledgerPayments.map((row) => (
              <tr key={row.paymentId}>
                <td>{paymentMethodLabel(row.method)}</td>
                <td>{row.date.trim() === '' ? 'no date recorded' : row.date}</td>
                <td>
                  {row.reference.trim() === '' ? (
                    <span className="invoice-ledger__missing">none</span>
                  ) : (
                    row.reference
                  )}
                </td>
                <td className="invoice-ledger__num">
                  {formatCentsUsd(ledgerRowTotalCents(row))}
                  {row.tipCents > 0 && (
                    <span className="invoice-ledger__note">
                      includes {formatCentsUsd(row.tipCents)} tip
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* The Stripe case, named rather than left as a contradiction on screen.
          A card payment is written to the root ledger and never to the
          subcollection, so an invoice can show a balance owed directly beneath a
          ledger row that covers it. */}
      {stripeGap && (
        <Banner tone="warning" title="The ledger shows money this balance does not">
          <p>
            The rows in the payment ledger add up to at least what this invoice still says is owed,
            but none of them settled it. A card payment taken through Stripe is written to the ledger
            only, so this is what that looks like.
          </p>
          <p>
            Nothing has been changed either way. If the money really came in, recording it above is
            what moves the balance and takes the invoice out of Outstanding.
          </p>
        </Banner>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ sessions */

function SessionsPanel({ ledger }: { ledger: GetInvoiceLedgerResult }) {
  const { sessions, missingSessionIds, orphanSessionIds, truncated } = ledger;
  const brokenBacklink = sessionsWithBrokenBacklink(sessions);

  return (
    <section className="invoice-ledger" aria-labelledby="invoice-ledger-sessions">
      <h3 className="invoice-ledger__heading" id="invoice-ledger-sessions">
        Linked visits
      </h3>
      <p className="invoice-ledger__subtitle">The visits this invoice bills.</p>

      {sessions.length === 0 ? (
        <p className="invoice-ledger__empty">
          No visit is linked to this invoice. Its total is not attributed to any recorded work.
          Visits are linked when the invoice is composed, from the uninvoiced-visits picker.
        </p>
      ) : (
        <table className="invoice-ledger__table">
          <thead>
            <tr>
              <th scope="col">Visit</th>
              <th scope="col">Date</th>
              <th scope="col">Length</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.sessionId}>
                <td>{sessionServiceLabel(s.serviceType)}</td>
                <td>{sessionDayLabel(s)}</td>
                <td>
                  {s.durationMinutes === null ? (
                    // Never "0 min". A visit with no recorded length is not a
                    // zero-length visit, and on a billing panel that is the
                    // difference between "not recorded" and "billed for nothing".
                    <span className="invoice-ledger__missing">not recorded</span>
                  ) : (
                    `${s.durationMinutes} min`
                  )}
                </td>
                <td>{sessionStatusLabel(s.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {truncated && (
        <p className="invoice-ledger__note-block">
          This invoice names more visits than one page shows. The list above is the first 200.
        </p>
      )}

      {missingSessionIds.length > 0 && (
        <Banner tone="error" title="This invoice claims a visit that does not exist">
          <p>
            This invoice bills for {missingSessionIds.length === 1 ? 'a visit' : 'visits'} with no
            record behind {missingSessionIds.length === 1 ? 'it' : 'them'}:{' '}
            {missingSessionIds.join(', ')}. The work is charged for and cannot be shown.
          </p>
        </Banner>
      )}

      {brokenBacklink.length > 0 && (
        <Banner tone="warning" title="A linked visit does not point back">
          <p>
            {brokenBacklink.length === 1
              ? 'One of the visits above is claimed by this invoice, but the visit itself is not marked as billed here, so it can still be picked up as uninvoiced work and billed a second time.'
              : `${brokenBacklink.length} of the visits above are claimed by this invoice, but those visits are not marked as billed here, so they can still be picked up as uninvoiced work and billed a second time.`}
          </p>
        </Banner>
      )}

      {orphanSessionIds.length > 0 && (
        <Banner tone="warning" title="A visit points at this invoice, which does not claim it">
          <p>
            {orphanSessionIds.join(', ')} {orphanSessionIds.length === 1 ? 'is' : 'are'} marked as
            billed on this invoice, but the invoice does not list{' '}
            {orphanSessionIds.length === 1 ? 'it' : 'them'}. That work is neither shown here nor
            available to bill elsewhere.
          </p>
        </Banner>
      )}
    </section>
  );
}
