import { useRef } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  acceptQuote,
  denyQuote,
  getMyInvoicePdf,
  getMyInvoices,
  payInvoice,
  redeemCredit,
} from '../api/invoicesApi';
import { getBusinessContact, getMyHome } from '../api/portal';
import type { PayMethod } from '../api/types';
import {
  creditTargetLabel,
  formatCentsUsd,
  formatUsd,
  invoiceRowStatusInfo,
  longDateLabel,
  longDateLabelFromMs,
  partPaidSummary,
} from '../lib/invoiceFormat';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { PortalNav } from '../components/PortalNav';
import { PayOptions } from '../components/PayOptions';
import { LaunchError } from './LaunchError';
import { OfflineNotice } from '../components/OfflineNotice';
import { LoadingLine } from '../components/Loading';
import { MutationLabel, OfflineMutationNotice } from '../components/OfflineMutationNotice';
import { viewOfQuery } from '../lib/queryState';
import { errorLine, usePortalMutation } from '../lib/mutationState';
import { mintCheckoutIdempotencyKey } from '../lib/moneyIdempotency';
import '../styles/invoices.css';

/**
 * Deploy skew fallback (web and functions don't deploy atomically): if
 * `payMethods` is missing from the response — an old server, or the
 * `getMyHome` query itself failing — a household must still be able to pay.
 * `PayOptions` stays the single rendering path either way; this is the one
 * method it's ever asked to render on its own.
 */
const STRIPE_ONLY_FALLBACK: PayMethod[] = [
  { id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', url: null, instructions: null },
];

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
  // PR30: `payMethods` (the resolved option list) rides the same
  // `['myHome', kinfolkId]` cache PortalNav already keeps warm on every
  // screen for branding, so this is free on the common path where the nav
  // already fetched it. Same `staleTime` for the same reason PortalNav uses
  // one: which options are configured changes rarely.
  //
  // ISSUE #409 kept this query rather than dropping it: the invoice's own
  // list is preferred now, but a server that predates that field still
  // answers here, and this screen must keep working across that window.
  const home = useQuery({ queryKey: ['myHome', kinfolkId], queryFn: () => getMyHome(kinfolkId), staleTime: 5 * 60_000 });

  /**
   * #825: ONE CHECKOUT KEY PER SUBMISSION, held across a re-tap.
   *
   * Minted lazily on the first tap and dropped the moment a checkout URL comes
   * back, so the only tap that reuses it is a tap after a visible failure —
   * which is the one that used to open a SECOND live Checkout Session. Both
   * sessions stayed payable, both would settle through `stripeWebhook`, and
   * there is no refund to undo the second charge. `lib/moneyIdempotency.ts` has
   * the reasoning and the 24-hour Stripe window it has to respect.
   */
  const checkoutKey = useRef<string | null>(null);
  // ABANDON, AND STILL ABANDON. The key makes a household's own second TAP
  // safe; it does not make it right to walk a pocketed phone to Stripe on
  // reconnect, which is a redirect nobody asked for at a moment nobody chose.
  // Those are two different claims, and only the first one changed. See
  // lib/mutationState.ts.
  const pay = usePortalMutation({
    mutationFn: () => {
      checkoutKey.current ??= mintCheckoutIdempotencyKey();
      return payInvoice(
        invoiceId,
        `${window.location.origin}/invoices/${invoiceId}`,
        `${window.location.origin}/invoices/${invoiceId}`,
        kinfolkId,
        checkoutKey.current,
      );
    },
    onSuccess: (res) => {
      // Dropped BEFORE the redirect. A household that comes back to pay a
      // different balance later must not reuse a key Stripe still holds: the
      // body would differ and Stripe would refuse it.
      checkoutKey.current = null;
      if (res.checkoutUrl) window.location.href = res.checkoutUrl;
    },
  }, { policy: 'abandon', what: 'your payment' });

  // ABANDON, though it reads like a download. `getMyInvoicePdf` re-renders the
  // document and mints a fresh `firebaseStorageDownloadTokens` on every call
  // (functions/src/lib/invoicePdf.ts), which kills the URL an earlier attempt
  // handed out. Resuming it later would also fire `window.open` at a moment
  // nobody asked for a popup.
  const downloadPdf = usePortalMutation({
    mutationFn: () => getMyInvoicePdf(invoiceId, kinfolkId),
    onSuccess: (res) => {
      if (res.pdfUrl) window.open(res.pdfUrl, '_blank', 'noopener');
    },
  }, { policy: 'abandon', what: 'your PDF' });

  // HOLD. The credit guard, the balance increment and the `creditRedeemedAt`
  // stamp are one Firestore transaction, so a second redeem re-reads the
  // committed stamp and is refused. It cannot double-credit.
  const redeem = usePortalMutation({
    mutationFn: () => redeemCredit(invoiceId, kinfolkId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['myInvoices', kinfolkId] });
    },
  }, { policy: 'hold', what: 'this credit' });

  /**
   * THE HOUSEHOLD'S ANSWER TO A QUOTE (issue #385). One mutation for both
   * answers rather than two, so the panel can never show two spinners at once
   * and a second tap while the first is in flight is impossible.
   *
   * Both invalidate the invoices cache on success: accepting re-stamps the doc
   * as an open bill, and this screen reads the row out of that cache, so
   * without the refetch the household would press Accept and watch nothing
   * change.
   */
  // HOLD. Both answers run in one transaction that refuses an already-decided
  // quote with `quote_already_decided`, so the answer cannot land twice.
  const decideQuote = usePortalMutation({
    mutationFn: (decision: 'accept' | 'decline') =>
      decision === 'accept' ? acceptQuote(invoiceId, kinfolkId) : denyQuote(invoiceId, kinfolkId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['myInvoices', kinfolkId] });
    },
  }, { policy: 'hold', what: 'your answer' });

  // These three used to fail silently — a rejected mutation just stopped the
  // spinner with nothing telling the kinfolk why (same class of bug KinTales'
  // comment-post had before it was fixed). Surface each distinctly.
  //
  // #807: `errorLine` answers null for the three OFFLINE phases, which carry
  // their own sentence now. A red "Couldn't open checkout. Try again." over a
  // payment whose fate is not known is the one line this screen must not
  // print.
  const payError = errorLine(pay, "Couldn't open checkout. Try again.");
  const pdfError = errorLine(downloadPdf, "Couldn't prepare the PDF. Try again.");
  const quoteError = errorLine(decideQuote, "Couldn't send your answer. Try again.");
  const redeemError = errorLine(redeem, "Couldn't redeem this credit. Try again.");

  const { signOut, signingOut } = useSignOut();

  if (invoices.isError) {
    return <LaunchError onRetry={() => void invoices.refetch()} retrying={invoices.isRefetching} onSignOut={signOut} signingOut={signingOut} />;
  }

  // Paused, this fell through to the "invoice not found" card, about a bill
  // that is on the account and was simply never fetched.
  const invoicesView = viewOfQuery(invoices);
  if (invoicesView.kind === 'offline') {
    return (
      <>
        <PortalNav active="invoices" />
        <div className="wrap">
          <section className="glass card">
            <OfflineNotice what="this invoice" />
          </section>
        </div>
      </>
    );
  }
  if (invoicesView.kind !== 'data') {
    return (
      <>
        <PortalNav active="invoices" />
        <div className="wrap">
          <LoadingLine variant="block" what="this invoice" retry={() => void invoices.refetch()}>
          Loading invoice…
        </LoadingLine>
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
  const status = invoiceRowStatusInfo(inv);
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
  // A quote still waiting for an answer. `quoteDecision` is what separates it
  // from one already answered: a DECLINED quote keeps `status: 'quote'` on the
  // server (see functions/src/portal/quoteDecision.ts), and an ACCEPTED one is
  // an open invoice by the time it gets back here.
  const isQuote = inv.status === 'quote';
  const awaitingDecision = isQuote && inv.quoteDecision === null;
  // THREE SOURCES, IN ORDER OF HOW MUCH THEY KNOW (issue #409).
  //
  //   1. the invoice's OWN list, resolved server-side off the options this
  //      bill was issued with. The only one that can be right about a bill
  //      sent before the operator changed her mind, and the only one that
  //      carries the instructions kind.
  //   2. the business-wide list off `getMyHome`, for a server that predates
  //      (1). Same meaning it always had.
  //   3. Stripe alone, when neither arrives: an old server, or a failed
  //      `getMyHome` fetch. Better than leaving `payable` true with no way
  //      to act on it.
  //
  // `?.length` rather than a presence check at every rung, because an EMPTY
  // list from (1) is a real answer on a settled invoice, and this whole
  // block only runs when the invoice is payable.
  const payMethods = inv.payMethods?.length
    ? inv.payMethods
    : home.data?.payMethods?.length
      ? home.data.payMethods
      : STRIPE_ONLY_FALLBACK;
  // `inv.amountDue` is dollars (the legacy shape of this collection, see
  // `invoiceFormat.ts`); PayOptions and the rest of this codebase's money
  // fields are cents. Rounded, not truncated, so $127.505 doesn't clip.
  const amountDueCents = Math.round(inv.amountDue * 100);

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
                    <PayOptions
                      methods={payMethods}
                      amountDue={amountDueCents}
                      onCheckout={() => pay.mutate()}
                      checkoutPhase={pay.phase}
                    />
                  )}
                  <button className="btn ghost" onClick={() => downloadPdf.mutate()} disabled={downloadPdf.isPending}>
                    {'⬇'}{' '}
                    <MutationLabel mutation={downloadPdf} busy="Preparing PDF…">
                      Download PDF
                    </MutationLabel>
                  </button>
                  <OfflineMutationNotice phase={pay.phase} what="your payment" check="this invoice" />
                  <OfflineMutationNotice phase={downloadPdf.phase} what="your PDF" />
                  {payError && <p className="doc-err">{payError}</p>}
                  {pdfError && <p className="doc-err">{pdfError}</p>}
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
            {/* THE QUOTE PANEL (issue #385). A quote is a proposal, so this is
                the one screen where the household is asked a question rather
                than shown a figure. It sits at the top of the side stack, above
                the credit panel, because an unanswered quote is the only thing
                on this page waiting on them. */}
            {awaitingDecision && (
              <section className="glass card d3">
                <div className="sectlabel">This is a quote</div>
                <p className="note">
                  Nothing has been billed yet. Accept it and it becomes an invoice you can pay.
                  Decline it and your Auntie will know you have passed on it.
                  {inv.dueDate ? ` This quote is good through ${longDateLabel(inv.dueDate)}.` : ''}
                </p>
                <div className="doc-actions">
                  <button
                    type="button"
                    className="btn grad"
                    onClick={() => decideQuote.mutate('accept')}
                    disabled={decideQuote.isPending}
                  >
                    <MutationLabel
                      mutation={{ phase: decideQuote.variables === 'accept' ? decideQuote.phase : 'idle' }}
                      busy="Working…"
                    >
                      Accept quote
                    </MutationLabel>
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => decideQuote.mutate('decline')}
                    disabled={decideQuote.isPending}
                  >
                    <MutationLabel
                      mutation={{ phase: decideQuote.variables === 'decline' ? decideQuote.phase : 'idle' }}
                      busy="Working…"
                    >
                      Decline
                    </MutationLabel>
                  </button>
                </div>
                <OfflineMutationNotice phase={decideQuote.phase} what="your answer" check="this quote" />
                {quoteError && (
                  /* The SERVER'S sentence, not a generic one: it is the side
                     that knows whether this quote expired, was already answered
                     in another tab, or belongs to somebody else. */
                  <p className="doc-err">{quoteError}</p>
                )}
              </section>
            )}
            {isQuote && inv.quoteDecision === 'denied' && (
              <section className="glass card d3">
                <div className="sectlabel">Quote declined</div>
                <p className="note">
                  {'✓'} You declined this quote
                  {longDateLabelFromMs(inv.quoteDecidedAtMs) ? ` on ${longDateLabelFromMs(inv.quoteDecidedAtMs)}` : ''}.
                  Nothing has been billed. Ask your Auntie if you would like a fresh one.
                </p>
              </section>
            )}
            {inv.quoteDecision === 'accepted' && (
              <section className="glass card d3">
                <div className="sectlabel">Quote accepted</div>
                <p className="note" style={{ color: 'var(--teal)' }}>
                  {'✓'} You accepted this quote
                  {longDateLabelFromMs(inv.quoteDecidedAtMs) ? ` on ${longDateLabelFromMs(inv.quoteDecidedAtMs)}` : ''}.
                  It is an invoice now, and the amount above is what is due.
                </p>
              </section>
            )}
            {isCredit && !redeemed && (
              <section className="glass card credit-grad d3">
                <div className="ckick">Available Credit</div>
                <div className="camt">{formatCentsUsd(inv.creditAmountCents ?? 0)}</div>
                <div className="cnote">
                  This credit goes to your account balance and comes off your next invoice.
                </div>

                <button type="button" className="btn credit-btn" onClick={() => redeem.mutate()} disabled={redeem.isPending}>
                  <MutationLabel mutation={redeem} busy="Working…">
                    Save to Account Balance
                  </MutationLabel>
                </button>
                <OfflineMutationNotice phase={redeem.phase} what="this credit" check="your account balance" />
                {redeemError && (
                  <p className="cnote" style={{ marginTop: 10 }}>
                    {'⚠️'} {redeemError}
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
