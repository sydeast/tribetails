import type { GetInvoiceLedgerResult } from '../contracts/invoiceContracts.generated';
import { formatCentsUsd } from '../lib/invoiceReconcile';
import {
  ledgerCoversBalance,
  ledgerRowAppliedLabel,
  ledgerRowBalanceCents,
  ledgerRowCaveat,
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

      {/* PAYMENT HISTORY: the transactions themselves, and the ONE table on this
          screen that can show a tip or a fee, because the root `payments`
          collection is the only place either is recorded.
          IT IS STILL SEPARATE FROM THE AUTHORITY ABOVE, and still says so. The
          settlement arithmetic never reads these rows, so folding the two
          together would either double a payment recorded through both paths or
          claim a balance had moved when it had not.
          THE COLUMNS ARE THE OPERATOR'S OWN, matched to her production screen:
          Transaction Date, Method, Reference #, Amount, Applied to #n, Tip, and
          Balance, plus Fee, which is the field whose absence made invoice
          (Applied to, Tip, Balance) were not missing from the SERVER: the
          callable has returned `tipCents` since this panel shipped and the panel
          simply never showed it. */}
      {ledgerPayments.length > 0 && (
        <table className="invoice-ledger__table">
          <caption className="invoice-ledger__caption">
            Payment history. What the client actually paid, recorded for the books, and NOT counted
            in the figures above. A row reads across as amount = applied + tip + balance; the fee is
            the processor's cut, taken off what reaches the business rather than off the bill.
          </caption>
          <thead>
            <tr>
              <th scope="col">Transaction date</th>
              <th scope="col">Method</th>
              <th scope="col">Reference #</th>
              <th scope="col" className="invoice-ledger__num">Amount</th>
              <th scope="col">Applied to</th>
              <th scope="col" className="invoice-ledger__num">Tip</th>
              <th scope="col" className="invoice-ledger__num">Fee</th>
              <th scope="col" className="invoice-ledger__num">Balance</th>
            </tr>
          </thead>
          <tbody>
            {ledgerPayments.map((row) => {
              const appliedTo = ledgerRowAppliedLabel(row);
              return (
                <tr key={row.paymentId}>
                  <td>{row.date.trim() === '' ? 'no date recorded' : row.date}</td>
                  <td>{paymentMethodLabel(row.method)}</td>
                  <td>
                    {row.reference.trim() === '' ? (
                      <span className="invoice-ledger__missing">none</span>
                    ) : (
                      row.reference
                    )}
                  </td>
                  {/* THE WHOLE SUM COLLECTED, tip included. Not amount + tip:
                      on the operator's real data the tip is already inside this
                      figure, and adding them counts the gratuity twice.

                      A row the server could not read gets no dollar figure at
                      all. Its `amountCents` is 0 because that is the floor the
                      schema allows, not because nothing was collected, and
                      printing it made an unreadable row look like a payment of
                      nothing. Same treatment the Fee cell already gives an
                      unrecorded fee. */}
                  <td className="invoice-ledger__num">
                    {row.amountResolved ? (
                      formatCentsUsd(row.amountCents)
                    ) : (
                      <span className="invoice-ledger__missing">could not be read</span>
                    )}
                  </td>
                  <td>
                    {appliedTo === '' ? (
                      // Never "$0.00 applied". A payment that touched no balance
                      // is a different fact from one that applied nothing.
                      <span className="invoice-ledger__missing">not applied</span>
                    ) : (
                      <>
                        {appliedTo}
                        <span className="invoice-ledger__note">
                          {formatCentsUsd(row.appliedCents)}
                        </span>
                      </>
                    )}
                  </td>
                  <td className="invoice-ledger__num">
                    {formatCentsUsd(row.tipCents)}
                    {/* The tax-relevant fact, said once per row that has one:
                        the stored tip is the GROSS. The net is derived, never
                        stored, so nothing can lose the deductible half again. */}
                    {row.tipCents > 0 && row.tipBasis === 'gross' && (
                      <span className="invoice-ledger__note">gross</span>
                    )}
                  </td>
                  <td className="invoice-ledger__num">
                    {row.feeCents > 0 ? (
                      formatCentsUsd(row.feeCents)
                    ) : row.reconciles ? (
                      formatCentsUsd(0)
                    ) : (
                      // A zero here would be a claim. On a migrated row the fee
                      // is not zero, it is unrecorded, and those are different.
                      <span className="invoice-ledger__missing">not recorded</span>
                    )}
                  </td>
                  <td className="invoice-ledger__num">
                    {formatCentsUsd(ledgerRowBalanceCents(row))}
                    {/* Where the leftover went, said on the row. Auto-apply puts
                        it into the household's account credit for a future
                        invoice; without it the money is simply unapplied. */}
                    {row.unappliedCents > 0 && row.autoApply && (
                      <span className="invoice-ledger__note">held as credit</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {/* THE ROWS THAT CANNOT BE MADE TO ADD UP, named rather than left as
          arithmetic that silently fails. This is the defect itself: the
          migration kept the NET tip and dropped the fee, so on those rows the
          gross is unrecoverable and no amount of display can recover it. */}
      {ledgerPayments.some((row) => ledgerRowCaveat(row) !== '') && (
        <Banner tone="warning" title="Some of these rows cannot be reconciled">
          <p>
            {ledgerPayments
              .filter((row) => ledgerRowCaveat(row) !== '')
              .map((row) => ledgerRowCaveat(row))
              .filter((msg, i, all) => all.indexOf(msg) === i)
              .join(' ')}
          </p>
          <p>
            Nothing has been guessed to make them balance. Payments recorded from now on store the
            gross tip and the processor fee separately, so they reconcile on their own.
          </p>
        </Banner>
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
