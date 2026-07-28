import { Link, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getMyInvoicePdf, getMyInvoices, payInvoice, redeemCredit } from '../api/invoicesApi';
import { getBusinessContact } from '../api/portal';
import {
  creditTargetLabel,
  formatCentsUsd,
  formatUsd,
  invoiceStatusInfo,
  longDateLabel,
  partPaidStatusInfo,
  partPaidSummary,
} from '../lib/invoiceFormat';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { PortalNav } from '../components/PortalNav';
import { LaunchError } from './LaunchError';
import '../styles/invoices.css';

/**
 * Invoice document view, ported from
 * ui-ideas/mytribe-invoice-detail-2026-05-31.html. There's no dedicated
 * getInvoiceById callable (same story as KinDetail's getMyKin reuse) — this
 * screen reads the same ['myInvoices', kinfolkId] cache as Invoices and
 * finds the row by id.
 */
export function InvoiceDetail() {
  const queryClient = useQueryClient();
  const { invoiceId } = useParams({ from: '/invoices/$invoiceId' });
  const kinfolkId = getActiveKinfolkId();

  const invoices = useQuery({ queryKey: ['myInvoices', kinfolkId], queryFn: () => getMyInvoices(kinfolkId) });
  const business = useQuery({ queryKey: ['businessContact'], queryFn: () => getBusinessContact() });

  const pay = useMutation({
    mutationFn: () =>
      payInvoice(invoiceId, `${window.location.origin}/invoices/${invoiceId}`, `${window.location.origin}/invoices/${invoiceId}`, kinfolkId),
    onSuccess: (res) => {
      if (res.checkoutUrl) window.location.href = res.checkoutUrl;
    },
  });

  const downloadPdf = useMutation({
    mutationFn: () => getMyInvoicePdf(invoiceId, kinfolkId),
    onSuccess: (res) => {
      if (res.pdfUrl) window.open(res.pdfUrl, '_blank', 'noopener');
    },
  });

  const redeem = useMutation({
    mutationFn: () => redeemCredit(invoiceId, kinfolkId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['myInvoices', kinfolkId] });
    },
  });

  // These three used to fail silently — a rejected mutation just stopped the
  // spinner with nothing telling the kinfolk why (same class of bug KinTales'
  // comment-post had before it was fixed). Surface each distinctly.
  function mutationErrorMessage(err: unknown, fallback: string): string {
    return err instanceof Error && err.message ? err.message : fallback;
  }

  const { signOut, signingOut } = useSignOut();

  if (invoices.isError) {
    return <LaunchError onRetry={() => void invoices.refetch()} retrying={invoices.isRefetching} onSignOut={signOut} signingOut={signingOut} />;
  }

  if (invoices.isLoading) {
    return (
      <>
        <PortalNav active="invoices" />
        <div className="wrap">
          <p className="sub">Loading invoice…</p>
        </div>
      </>
    );
  }

  const data = invoices.data;
  const found = data ? [...data.open, ...data.paid, ...data.credits].find((i) => i.id === invoiceId) ?? null : null;

  if (!found) {
    return (
      <>
        <PortalNav active="invoices" />
        <div className="wrap">
          <a className="backlink" href="/invoices">
            {'←'} Back to invoices
          </a>
          <section className="glass card">
            <h3 className="title">We couldn&rsquo;t find that invoice.</h3>
            <p className="sub">It may have been removed. Head back to Invoices to see your current billing.</p>
          </section>
        </div>
      </>
    );
  }

  const inv = found;
  // A part-paid invoice is neither paid nor untouched, and this is the screen a
  // paying household reads. It keeps the open bucket and the Pay button; only
  // what it SAYS about itself changes. See lib/invoiceFormat.ts.
  const status = inv.partiallyPaid ? partPaidStatusInfo() : invoiceStatusInfo(inv.status, inv.creditRedeemedAtMs);
  const partPaid = partPaidSummary(inv);
  // The whole credit family: the stamp writes `redeemed` once the credit is
  // spent, and a redeemed credit still carries every credit field this screen
  // renders. Checking `credit` alone would drop a redeemed credit's panel.
  const isCredit = inv.status === 'credit' || inv.status === 'redeemed';
  const redeemed = inv.creditRedeemedAtMs !== null;
  // `paidCents` when the server has recorded one, and only then. The
  // total-minus-balance fallback STAYS (checked 2026-07-28, when the stamp
  // landed): invoices settled before the cents fields existed carry no
  // `paidCents` at all — the backfill stamped only status/editScope — so the
  // server honestly ships 0 for them and deleting this line would blank the
  // "Paid" row on every historical receipt. It can never override a real
  // figure: on every invoice the pre-2026-07-25 write touched it would report
  // the whole total as collected.
  const paidAmount = inv.paidCents > 0 ? inv.paidCents / 100 : Math.max(0, inv.total - inv.amountDue);
  // Same rule as the list row: only an `open` invoice with a balance takes a
  // payment. Spelled positively rather than as the old not-credit/not-
  // cancelled/not-paid negation, which — now that the enum carries all eight
  // stamped states — would have offered a Pay button on a quote (not yet a
  // bill) and on a draft (never sent).
  const payable = inv.status === 'open' && inv.amountDue > 0;

  return (
    <>
      <PortalNav active="invoices" />

      <div className="wrap">
        <Link className="backlink" to="/invoices">
          {'←'} Back to invoices
        </Link>

        <header className="hero-greet">
          <div className="kick">Invoice {inv.id}</div>
          <h1>
            Invoice for <span>{inv.client ?? 'your tribe'}</span>
          </h1>
        </header>

        <div className="cols">
          <div className="stack">
            <section className="glass doc">
              <div className="doc-rail" />
              <div className="doc-body">
                <div className="doc-head">
                  <div className="party">
                    <div className="lbl">From</div>
                    <div className="who">{business.data?.name ?? 'Tribe Tails Pet Care'}</div>
                    {business.data && (
                      <address>
                        {business.data.address}
                        <br />
                        {business.data.email}
                      </address>
                    )}
                  </div>
                  <div className="party">
                    <div className="lbl">Client</div>
                    <div className="who">{inv.client ?? 'Not set'}</div>
                    {inv.address && (
                      <>
                        <div className="lbl" style={{ marginTop: 12 }}>
                          Address
                        </div>
                        <address>{inv.address}</address>
                      </>
                    )}
                  </div>
                  <div className="doc-status">
                    <div className="lbl">Status</div>
                    <span className={`chip big ${status.cssClass}`}>{status.chipLabel}</span>
                    {partPaid && <div className="num">{partPaid}</div>}
                    <div className="num">Invoice {inv.id}</div>
                  </div>
                </div>

                <div className="meta-strip">
                  <div>
                    <div className="lbl">Date</div>
                    <div className="val">{longDateLabel(inv.date) ?? '—'}</div>
                  </div>
                  <div>
                    <div className="lbl">Due Date</div>
                    <div className="val">{longDateLabel(inv.dueDate) ?? '—'}</div>
                  </div>
                  <div>
                    <div className="lbl">Status</div>
                    <div className="val">{status.label}</div>
                  </div>
                  <div>
                    <div className="lbl">Terms</div>
                    <div className="val">{inv.terms ?? '—'}</div>
                  </div>
                </div>

                {inv.lineItems && inv.lineItems.length > 0 && (
                  <table className="items">
                    <thead>
                      <tr>
                        <th>Service</th>
                        <th>Date</th>
                        <th className="r">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inv.lineItems.map((item) => (
                        // Keyed on `lineId`, never `sessionId`: a stored line has
                        // no session behind it, so every stored row would share
                        // the same empty key.
                        <tr key={item.lineId}>
                          <td className="svc">
                            <b>{item.label || 'Visit'}</b>
                            {/* Shown only when it adds something. A quantity of
                                one just repeats the amount column, while a line
                                billed 3 x $20 should not read as a bare $60. */}
                            {item.qty !== null && item.unitCents !== null && item.qty !== 1 && (
                              <small>
                                {item.qty} x {formatCentsUsd(item.unitCents)}
                              </small>
                            )}
                          </td>
                          <td className="date">{longDateLabel(item.dateIso) ?? '—'}</td>
                          <td className="r amt">{item.amountCents !== null ? formatCentsUsd(item.amountCents) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <div className="totals">
                  {isCredit ? (
                    <div className="row total">
                      <span>Credit Amount</span>
                      <b>{formatCentsUsd(inv.creditAmountCents ?? 0)}</b>
                    </div>
                  ) : (
                    <>
                      <div className="row total">
                        <span>Total</span>
                        <b>{formatUsd(inv.total)}</b>
                      </div>
                      {inv.discount && (
                        <div className="row disc">
                          <span>Discount</span>
                          <b>{inv.discount}</b>
                        </div>
                      )}
                      {paidAmount > 0 && (
                        <div className="row paid">
                          <span>Paid</span>
                          <b>{formatUsd(paidAmount)}</b>
                        </div>
                      )}
                      {inv.status === 'cancelled' ? (
                        <div className="row">
                          <span>Amount Due</span>
                          <b>No charge</b>
                        </div>
                      ) : (
                        inv.amountDue > 0 && (
                          <div className="row due">
                            <span>Amount Due</span>
                            <b>{formatUsd(inv.amountDue)}</b>
                          </div>
                        )
                      )}
                    </>
                  )}
                </div>

                <div className="doc-actions">
                  {payable && (
                    <button className="btn grad" onClick={() => pay.mutate()} disabled={pay.isPending}>
                      {'\u{1F4B3}'}{' '}
                      {pay.isPending
                        ? 'Opening checkout…'
                        : inv.partiallyPaid
                          ? `Pay remaining ${formatUsd(inv.amountDue)}`
                          : `Pay ${formatUsd(inv.amountDue)}`}
                    </button>
                  )}
                  <button className="btn ghost" onClick={() => downloadPdf.mutate()} disabled={downloadPdf.isPending}>
                    {'⬇'} {downloadPdf.isPending ? 'Preparing PDF…' : 'Download PDF'}
                  </button>
                  {pay.isError && (
                    <p className="doc-err">
                      {mutationErrorMessage(pay.error, "Couldn't open checkout. Try again.")}
                    </p>
                  )}
                  {downloadPdf.isError && (
                    <p className="doc-err">
                      {mutationErrorMessage(downloadPdf.error, "Couldn't prepare the PDF. Try again.")}
                    </p>
                  )}
                </div>
              </div>
            </section>

            {inv.paymentsHistory && (
              <section className="glass card d2">
                <div className="sectlabel">Payment History</div>
                <p className="note">{inv.paymentsHistory}</p>
              </section>
            )}
          </div>

          <div className="stack">
            {isCredit && !redeemed && (
              <section className="glass card credit-grad d3">
                <div className="ckick">Available Credit</div>
                <div className="camt">{formatCentsUsd(inv.creditAmountCents ?? 0)}</div>
                <div className="cnote">
                  This credit goes to your account balance and comes off your next invoice.
                </div>

                <button type="button" className="btn credit-btn" onClick={() => redeem.mutate()} disabled={redeem.isPending}>
                  {redeem.isPending ? 'Working…' : 'Save to Account Balance'}
                </button>
                {redeem.isError && (
                  <p className="cnote" style={{ marginTop: 10 }}>
                    {'⚠️'} {mutationErrorMessage(redeem.error, "Couldn't redeem this credit. Try again.")}
                  </p>
                )}
              </section>
            )}

            {isCredit && redeemed && (
              <section className="glass card d3">
                <div className="sectlabel">Credit</div>
                <p className="note" style={{ color: 'var(--teal)' }}>
                  {'✓'} {creditTargetLabel(inv.creditTarget)}
                </p>
              </section>
            )}
          </div>
        </div>

        <p className="footnote">
          Billed by <b>Tribe Tails Pet Care</b>
        </p>
      </div>
    </>
  );
}
