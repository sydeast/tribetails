import { useEffect, useRef, useState } from 'react';
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
  discountAmountText,
  discountNoteOf,
  formatCentsUsd,
  formatUsd,
  documentNoun,
  invoiceDiscountFigures,
  lineDiscountLine,
  invoiceName,
  invoiceRowStatusInfo,
  longDateLabel,
  longDateLabelFromMs,
  offersPayment,
  partPaidSummary,
  paidDollarsOf,
  payBlockedReason,
  NOTHING_TO_PAY,
  quoteActorLabel,
} from '../lib/invoiceFormat';
import { useAuth, useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { PortalNav } from '../components/PortalNav';
import { PayOptions } from '../components/PayOptions';
import { LeaveBilling } from '../components/LeaveBilling';
import { isPermissionDenied } from '../lib/billingAccess';
import { LaunchError } from './LaunchError';
import { OfflineNotice } from '../components/OfflineNotice';
import { LoadingLine } from '../components/Loading';
import { MutationLabel, OfflineMutationNotice } from '../components/OfflineMutationNotice';
import { viewOfQuery } from '../lib/queryState';
import { errorLine, usePortalMutation } from '../lib/mutationState';
import { refreshAfterSave } from '../lib/refreshAfterSave';
import { accountCreditHistoryKey, businessContactKey, myHomeKey, myInvoicesKey } from '../lib/portalQueryKeys';
import { announceSaved } from '../lib/saveNotice';
import { mintCheckoutIdempotencyKey } from '../lib/moneyIdempotency';
import {
  cameBackFromCheckout,
  checkoutReturnUrls,
  dropCheckoutMarker,
  PAYMENT_CHECK_EVERY_MS,
  PAYMENT_CHECK_FOR_MS,
  paymentBeingRecorded,
} from '../lib/checkoutReturn';
import '../styles/invoices.css';
import { BusinessFootnote } from '../components/BusinessFootnote';

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
// #2437: the two check timings live in `lib/checkoutReturn.ts` now, where the
// invoices list reads them too. Still exported from here for their tests.
export { PAYMENT_CHECK_EVERY_MS, PAYMENT_CHECK_FOR_MS };
/**
 * #2366, #2402: where the payment check stands after the household came back
 * from Stripe.
 *
 *   checking   the bill is being read again, Pay held back.
 *   not-seen   time ran out and a read made since the return still says owed.
 *              Pay is offered again, beside Check again.
 *   not-read   time ran out and NO read since the return got through. Nothing
 *              is known about the payment, so Pay stays held back: a second
 *              payment would be a second real charge, and there are no refunds.
 *
 * `since` is when the check began. Only a read that finished after it counts.
 *
 * #2437: `why` is the server's sentence when the check began because
 * `payInvoice` refused: a payment on this invoice has finished at Stripe and
 * is not recorded yet. It is printed where Pay was for as long as that check
 * runs.
 */
type PaymentCheck = { since: number; phase: 'checking' | 'not-seen' | 'not-read'; why?: string };
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
  // #1039: whose name goes in "___ accepted/declined this quote". A
  // SECONDARY with billing access can answer a quote now, so the signed-in
  // reader is not always the one who did.
  const auth = useAuth();
  const viewerUid = auth.status === 'signedIn' ? auth.user.uid : null;

  // #2366: set when the household lands here from a finished Stripe checkout,
  // cleared once a fresh read shows the bill settled. See `PaymentCheck`.
  const [check, setCheck] = useState<PaymentCheck | null>(() =>
    cameBackFromCheckout() ? { since: Date.now(), phase: 'checking' } : null,
  );
  const checking = check?.phase === 'checking';
  const invoices = useQuery({
    queryKey: myInvoicesKey(kinfolkId),
    queryFn: () => getMyInvoices(kinfolkId),
    refetchInterval: checking ? PAYMENT_CHECK_EVERY_MS : false,
  });
  useEffect(() => {
    if (checking) dropCheckoutMarker();
  }, [checking]);
  // What the latest read says about this bill: still waiting on a payment, or
  // not (paid, or no longer a bill that takes one). Undefined until it loads.
  const readBill = invoices.data
    ? [...invoices.data.open, ...invoices.data.paid, ...invoices.data.credits].find((i) => i.id === invoiceId)
    : undefined;
  const stillOwed = readBill ? offersPayment(readBill) : null;
  const readPaid = readBill ? readBill.isPaid || readBill.status === 'paid' : false;
  // Only a read that FINISHED after the return counts: a cached copy from
  // before the checkout says nothing about the payment. `dataUpdatedAt` moves
  // on a read that worked and never on one that failed.
  const readSinceReturn = check !== null && invoices.dataUpdatedAt >= check.since;
  useEffect(() => {
    if (check === null) return;
    if (readSinceReturn && stillOwed === false) {
      setCheck(null);
      if (readPaid) announceSaved('Payment received');
      return;
    }
    // #2402: the check gave up with nothing read, and a read has got through
    // since. The bill is known again and still owed, so Pay may come back.
    if (check.phase === 'not-read' && readSinceReturn) {
      setCheck({ since: check.since, phase: 'not-seen' });
      return;
    }
    if (check.phase !== 'checking') return;
    const left = check.since + PAYMENT_CHECK_FOR_MS - Date.now();
    const timer = setTimeout(() => {
      setCheck({ since: check.since, phase: readSinceReturn ? 'not-seen' : 'not-read' });
    }, Math.max(0, left));
    return () => clearTimeout(timer);
  }, [check, readSinceReturn, stillOwed, readPaid]);
  const checkAgain = () => {
    setCheck({ since: Date.now(), phase: 'checking' });
    void invoices.refetch();
  };
  const business = useQuery({ queryKey: businessContactKey(), queryFn: () => getBusinessContact() });
  // PR30: `payMethods` (the resolved option list) rides the same
  // `['myHome', kinfolkId]` cache PortalNav already keeps warm on every
  // screen for branding, so this is free on the common path where the nav
  // already fetched it. Same `staleTime` for the same reason PortalNav uses
  // one: which options are configured changes rarely.
  //
  // ISSUE #409 kept this query rather than dropping it: the invoice's own
  // list is preferred now, but a server that predates that field still
  // answers here, and this screen must keep working across that window.
  const home = useQuery({ queryKey: myHomeKey(kinfolkId), queryFn: () => getMyHome(kinfolkId), staleTime: 5 * 60_000 });

  /**
   * #825: ONE CHECKOUT KEY PER SUBMISSION, held across a re-tap.
   *
   * Minted lazily on the first tap and dropped the moment a checkout URL comes
   * back, so the only tap that reuses it is a tap after a visible failure.
   *
   * IT COVERS A DIFFERENT TAP FROM #826's SESSION REUSE. That reuse hands back
   * the session stored on the invoice, so it needs the previous call to have
   * finished and written one. This key covers the call that did NOT finish:
   * Stripe made the session, and the reply was lost on the way back. Nothing
   * was stored, so the server has nothing to hand back, and without the key the
   * retry opens a second live session. `lib/moneyIdempotency.ts` has the
   * reasoning and the 24-hour Stripe window it has to respect.
   */
  const checkoutKey = useRef<string | null>(null);
  // ABANDON, AND STILL ABANDON. See lib/mutationState.ts for what was
  // established from the callable: holding this one would walk a pocketed phone
  // to Stripe on reconnect, minutes after the household put the phone away.
  // The key makes a household's own second TAP safe; it says nothing about a
  // redirect nobody asked for at a moment nobody chose. Two different claims,
  // and only the first one changed.
  const pay = usePortalMutation({
    mutationFn: () => {
      checkoutKey.current ??= mintCheckoutIdempotencyKey();
      // #2366: back to this invoice either way; the success address carries
      // the marker that starts the payment check above. The invoices list's
      // Pay now sends the same two (`lib/checkoutReturn.ts`, #2400).
      const { successUrl, cancelUrl } = checkoutReturnUrls(window.location.origin, invoiceId);
      return payInvoice(invoiceId, successUrl, cancelUrl, kinfolkId, checkoutKey.current);
    },
    onSuccess: (res) => {
      // Dropped BEFORE the redirect. A household that comes back to pay a
      // different balance later must not reuse a key Stripe still holds.
      // (The server now folds the round and the amount into the key it hands
      // Stripe, so a changed balance mints a fresh session rather than earning
      // an error; dropping it here is the belt to that braces.)
      checkoutKey.current = null;
      // WHAT THIS REDIRECT GUARANTEES, AND WHAT IT NO LONGER HAS TO (#826).
      //
      // `window.location.href` UNLOADS THE PAGE. That is why this screen cannot
      // hold two live Checkout Sessions at once, and for a while it was the
      // only thing standing between a household and two real charges for one
      // bill: `payInvoice` minted a new session, and a new PaymentIntent, on
      // every call, and the webhook's per-event and per-intent ledgers cannot
      // see two intents as one invoice.
      //
      // The server now refuses that itself: a second completed session for one
      // balance goes to account credit instead of paying the bill twice
      // (functions/src/lib/invoiceCheckoutDedupe.ts). So turning this into an
      // in-page transition, a modal checkout or a router navigation is no
      // longer a billing decision. It is still worth knowing that it once was,
      // because nothing about the line says so.
      if (res.checkoutUrl) window.location.href = res.checkoutUrl;
    },
    // #2437: the server opened no checkout because a payment on this invoice
    // is still being recorded. That is what the check above is for, so it
    // starts here too: Pay is held back, the server's sentence takes its
    // place, and the bill is read again until the payment shows.
    onError: (err) => {
      const why = paymentBeingRecorded(err);
      if (why !== null) setCheck({ since: Date.now(), phase: 'checking', why });
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
    // #1281: see the same mutation on Invoices.tsx. Pending until the reloaded
    // invoice shows the credit applied, then confirmed in words.
    onSuccess: async () => {
      await refreshAfterSave(queryClient, myInvoicesKey(kinfolkId), accountCreditHistoryKey(kinfolkId));
      announceSaved('Credit saved');
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
    // #1281: pending until the reloaded invoice shows the answer.
    onSuccess: () => refreshAfterSave(queryClient, myInvoicesKey(kinfolkId)),
  }, { policy: 'hold', what: 'your answer' });

  // These three used to fail silently — a rejected mutation just stopped the
  // spinner with nothing telling the kinfolk why (same class of bug KinTales'
  // comment-post had before it was fixed). Surface each distinctly.
  //
  // #807: `errorLine` answers null for the three OFFLINE phases, which carry
  // their own sentence now. A red "Couldn't open checkout. Try again." over a
  // payment whose fate is not known is the one line this screen must not
  // print.
  // #2437: the "still being recorded" refusal is not printed here. Its sentence
  // goes where Pay was while the payment is checked, and a second copy in red
  // would read as a second failure.
  const payError =
    paymentBeingRecorded(pay.error) !== null ? null : errorLine(pay, "Couldn't open checkout. Try again.");
  const pdfError = errorLine(downloadPdf, "Couldn't prepare the PDF. Try again.");
  const quoteError = errorLine(decideQuote, "Couldn't send your answer. Try again.");
  const redeemError = errorLine(redeem, "Couldn't redeem this credit. Try again.");

  const { signOut, signingOut, error: signOutError } = useSignOut();

  // #1005: refused billing access is not a failure to report. Back to Home.
  if (invoices.isError && isPermissionDenied(invoices.error)) return <LeaveBilling />;
  // #2402: A FAILED RE-READ DURING A PAYMENT CHECK KEEPS THE INVOICE. The check
  // reads the bill every few seconds on a phone that has just come back from
  // Stripe, and one read that did not get through used to swap the whole page
  // for the trouble-loading screen, at the moment the household had just paid.
  // The invoice already loaded is still the right thing to show: the check cue
  // stays beside it and the next tick reads again. The trouble-loading screen
  // is for a read that failed with nothing to show.
  const heldThroughFailure = invoices.isError && invoices.data !== undefined && check !== null;
  if (invoices.isError && !heldThroughFailure) {
    return <LaunchError onRetry={() => void invoices.refetch()} retrying={invoices.isRefetching} onSignOut={signOut} signingOut={signingOut} signOutError={signOutError} />;
  }

  // Paused, this fell through to the "invoice not found" card, about a bill
  // that is on the account and was simply never fetched.
  //
  // `viewOfQuery` reads a failed query as 'error' whatever it still holds, so
  // the held invoice is handed on as data here and not asked about again.
  const invoicesView = heldThroughFailure
    ? ({ kind: 'data', data: invoices.data } as const)
    : viewOfQuery(invoices);
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
  // #2090: on a written-off invoice only the recorded payments (`paidDollarsOf`).
  const paidAmount = paidDollarsOf(inv);
  // #1974: subtotal and invoice discount as amounts, or null to keep the old row.
  const figures = invoiceDiscountFigures(inv);
  const discountNote = discountNoteOf(inv.discount);
  const writtenOff = inv.status === 'written_off';
  // Same rule as the list row: only an `open` invoice with a balance takes a
  // payment. Spelled positively rather than as the old not-credit/not-
  // cancelled/not-paid negation, which — now that the enum carries all eight
  // stamped states — would have offered a Pay button on a quote (not yet a
  // bill) and on a draft (never sent).
  //
  // A PAID INVOICE TAKES NO PAYMENT (docket Q5): `offersPayment` also refuses
  // on `isPaid`, so the list and this screen share one rule.
  const payable = offersPayment(inv);
  // #2410: an open bill the server says cannot take a payment. No pay option
  // is drawn for it, and its sentence goes where they would be.
  const payBlocked = payBlockedReason(inv);
  // A quote still waiting for an answer. `quoteDecision` is what separates it
  // from one already answered: a DECLINED quote keeps `status: 'quote'` on the
  // server (see functions/src/portal/quoteDecision.ts), and an ACCEPTED one is
  // an open invoice by the time it gets back here.
  const isQuote = inv.status === 'quote';
  const awaitingDecision = isQuote && inv.quoteDecision === null;
  // #1039: "You" only when the viewer is the one who answered; otherwise the
  // actor's name, or null when no name was stored (see `quoteActorLabel`).
  const quoteActor = quoteActorLabel(inv, viewerUid);
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
          <div className="kick">
            {invoiceName(inv)}
          </div>
          <h1>
            {documentNoun(inv)} for <span>{inv.client ?? 'your tribe'}</span>
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
                    <div className="who">{business.data?.name?.trim() || 'Your Auntie'}</div>
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
                    <div className="who">{inv.client ?? inv.kinfolkName ?? 'Not set'}</div>
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
                    <div className="num">{invoiceName(inv)}</div>
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
                            {/* #1974: what was taken off, already out of the amount. */}
                            {lineDiscountLine(item.discountCents) !== null && (
                              <small>{lineDiscountLine(item.discountCents)}</small>
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
                      {/* #1974: an invoice built from lines shows its subtotal and
                          the invoice discount as amounts, so the lines add up to
                          the total. An older server sends neither key, and an
                          invoice with no stored lines has neither figure: both
                          keep the free-text discount row as before. */}
                      {figures !== null && (
                        <>
                          <div className="row" data-testid="invoice-subtotal">
                            <span>Subtotal</span>
                            <b>{formatCentsUsd(figures.subtotalCents)}</b>
                          </div>
                          {figures.invoiceDiscountCents > 0 && (
                            <div className="row disc" data-testid="invoice-discount">
                              <span>
                                Discount
                                {discountNote !== null && <small className="disc-note">{discountNote}</small>}
                              </span>
                              <b>{discountAmountText(figures.invoiceDiscountCents)}</b>
                            </div>
                          )}
                          <div className="rule" />
                        </>
                      )}
                      <div className="row total">
                        <span>Total</span>
                        <b>{formatUsd(inv.total)}</b>
                      </div>
                      {figures === null && inv.discount && (
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
                      {writtenOff && inv.writtenOffCents !== null && inv.writtenOffCents > 0 && (
                        <div className="row" data-testid="written-off-row">
                          <span>Written off</span>
                          <b>{formatCentsUsd(inv.writtenOffCents)}</b>
                        </div>
                      )}
                      {inv.status === 'cancelled' || writtenOff ? (
                        <div className="row">
                          <span>Amount Due</span>
                          <b>{writtenOff ? NOTHING_TO_PAY : 'No charge'}</b>
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
                  {/* #2366: back from a finished checkout, the bill is read
                      again until the webhook's verdict shows. Pay is held back
                      meanwhile: a second payment would go to account credit,
                      and there are no refunds. */}
                  {payable && checking && (
                    <div className="pay-check" data-testid="payment-check">
                      {check?.why && (
                        <p className="pay-blocked" data-testid="payment-being-recorded">
                          {check.why}
                        </p>
                      )}
                      <LoadingLine what="your payment" retry={() => void invoices.refetch()}>
                        Checking payment…
                      </LoadingLine>
                    </div>
                  )}
                  {payable && check?.phase === 'not-seen' && (
                    <p className="pay-check-note" data-testid="payment-not-seen">
                      This payment has not shown up yet. If you finished paying, check again in a minute.{' '}
                      <button type="button" className="btn ghost" onClick={checkAgain}>
                        Check again
                      </button>
                    </p>
                  )}
                  {/* #2402: the check ran out and no read got through, so
                      nothing is known about the payment. Pay stays held back
                      until a read says the bill is still owed. */}
                  {payable && check?.phase === 'not-read' && (
                    <p className="pay-check-note" data-testid="payment-not-checked">
                      We could not check this payment. Check again in a minute.{' '}
                      <button type="button" className="btn ghost" onClick={checkAgain}>
                        Check again
                      </button>
                    </p>
                  )}
                  {payable && (check === null || check.phase === 'not-seen') && (
                    <PayOptions
                      methods={payMethods}
                      amountDue={amountDueCents}
                      onCheckout={() => pay.mutate()}
                      checkoutPhase={pay.phase}
                    />
                  )}
                  {payBlocked && (
                    <p className="pay-blocked" data-testid="pay-blocked">
                      {payBlocked}
                    </p>
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
                  {/* #2088: a quote has no expiry, so no "good through" date. */}
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
                  {'✓'} {quoteActor ? `${quoteActor} declined this quote` : 'Declined'}
                  {longDateLabelFromMs(inv.quoteDecidedAtMs) ? ` on ${longDateLabelFromMs(inv.quoteDecidedAtMs)}` : ''}.
                  Nothing has been billed. Ask your Auntie if you would like a fresh one.
                </p>
              </section>
            )}
            {inv.quoteDecision === 'accepted' && (
              <section className="glass card d3">
                <div className="sectlabel">Quote accepted</div>
                <p className="note" style={{ color: 'var(--teal)' }}>
                  {'✓'} {quoteActor ? `${quoteActor} accepted this quote` : 'Accepted'}
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
                  This credit goes to your account balance. Your Auntie applies it to an invoice for you.
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

        <BusinessFootnote lead="Billed by" name={business.data?.name} />
      </div>
    </>
  );
}
