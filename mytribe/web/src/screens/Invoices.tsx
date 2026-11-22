import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getMyInvoices, payInvoice, redeemCredit } from '../api/invoicesApi';
import type { InvoiceDto } from '../contracts/invoiceContracts.generated';
import {
  calTileFor,
  creditTargetLabel,
  declinedRowLabel,
  formatCentsUsd,
  formatUsd,
  invoiceName,
  invoiceRowStatusInfo,
  invoiceStatusInfo,
  longDateLabel,
  offersPayment,
  partPaidSummary,
  paidDollarsOf,
  WRITTEN_OFF_ROW_LABEL,
  shortDateLabel,
} from '../lib/invoiceFormat';
import { useAuth, useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { accountCreditHistoryKey, myInvoicesKey } from '../lib/portalQueryKeys';
import { PortalNav } from '../components/PortalNav';
import { LeaveBilling } from '../components/LeaveBilling';
import { isPermissionDenied } from '../lib/billingAccess';
import { CreditHistorySection } from '../components/CreditHistorySection';
import { LaunchError } from './LaunchError';
import { OfflineNotice } from '../components/OfflineNotice';
import { LoadingLine } from '../components/Loading';
import { MutationLabel, OfflineMutationNotice } from '../components/OfflineMutationNotice';
import { viewOfQuery } from '../lib/queryState';
import { errorLine, usePortalMutation, type MutationPhase } from '../lib/mutationState';
import { refreshAfterSave } from '../lib/refreshAfterSave';
import { announceSaved } from '../lib/saveNotice';
import { mintCheckoutIdempotencyKey } from '../lib/moneyIdempotency';
import {
  checkoutReturnUrls,
  PAYMENT_CHECK_EVERY_MS,
  PAYMENT_CHECK_FOR_MS,
  paymentBeingRecorded,
} from '../lib/checkoutReturn';
import '../styles/invoices.css';
import { SettingsBusinessFootnote } from '../components/BusinessFootnote';

/**
 * Invoices list, ported from ui-ideas/mytribe-invoices-2026-05-31.html.
 * Data flow mirrors InvoicesController.kt (reload -> getMyInvoices) and
 * InvoicesScreen.kt's field usage (client/dueDate/date drive the row
 * title+subtitle; the mockup's per-visit "with Auntie X" subtitle has no
 * backing field on InvoiceDto, same simplification the Kotlin reference
 * already made).
 */
export function Invoices() {
  const queryClient = useQueryClient();
  const kinfolkId = getActiveKinfolkId();
  /**
   * #2437: A PAYMENT ON ONE OF THESE BILLS IS STILL BEING RECORDED. Set when
   * `payInvoice` refuses a Pay now for that reason (the household finished at
   * Stripe in another window, or came back by hand, and the payment is not on
   * the invoice yet). While it stands the row offers no Pay now, the server's
   * sentence is printed under it, and the list is read again on the invoice
   * page's own cadence until the payment shows. If it has not shown after
   * `PAYMENT_CHECK_FOR_MS` the row goes back to Pay now, and the server
   * decides again on the next tap.
   */
  const [recording, setRecording] = useState<{ invoiceId: string; since: number; why: string } | null>(null);
  const invoices = useQuery({
    queryKey: myInvoicesKey(kinfolkId),
    queryFn: () => getMyInvoices(kinfolkId),
    refetchInterval: recording ? PAYMENT_CHECK_EVERY_MS : false,
  });
  const recordingBill =
    recording && invoices.data
      ? [...invoices.data.open, ...invoices.data.paid, ...invoices.data.credits].find((i) => i.id === recording.invoiceId)
      : undefined;
  // Only a read that finished after the refusal says anything about the payment.
  const recordingSettled =
    recording !== null && invoices.dataUpdatedAt >= recording.since && recordingBill !== undefined && !offersPayment(recordingBill);
  const recordingPaid = recordingBill ? recordingBill.isPaid || recordingBill.status === 'paid' : false;
  useEffect(() => {
    if (recording === null) return;
    if (recordingSettled) {
      setRecording(null);
      if (recordingPaid) announceSaved('Payment received');
      return;
    }
    const left = recording.since + PAYMENT_CHECK_FOR_MS - Date.now();
    const timer = setTimeout(() => setRecording(null), Math.max(0, left));
    return () => clearTimeout(timer);
  }, [recording, recordingSettled, recordingPaid]);
  // #1039: the viewer's own uid, so a declined quote's meta line can tell
  // "you declined this" from "Sam declined this" instead of assuming the
  // reader is always the one who answered.
  const auth = useAuth();
  const viewerUid = auth.status === 'signedIn' ? auth.user.uid : null;

  /**
   * #2400, #825: ONE CHECKOUT KEY PER INVOICE, held across a re-tap. This
   * button sent no key at all, so a reply lost on the way back from Stripe and
   * a second tap opened a second live session (`lib/moneyIdempotency.ts`). A
   * map and not one held key, because this screen has a Pay button per row: a
   * household can tap one bill, fail, and tap another, and one held key would
   * carry the first invoice's key to the second invoice's checkout. Same shape
   * as the MyTribe Android app's `checkoutKeys`.
   */
  const checkoutKeys = useRef(new Map<string, string>());
  const pay = usePortalMutation({
    mutationFn: (invoiceId: string) => {
      let key = checkoutKeys.current.get(invoiceId);
      if (key === undefined) {
        key = mintCheckoutIdempotencyKey();
        checkoutKeys.current.set(invoiceId, key);
      }
      // #2400: the same two addresses the invoice page sends. This button sent
      // the bare invoice page for both, so a finished checkout came back with
      // no marker: no "Checking payment…", and a live Pay button while the
      // payment was still landing.
      const { successUrl, cancelUrl } = checkoutReturnUrls(window.location.origin, invoiceId);
      return payInvoice(invoiceId, successUrl, cancelUrl, kinfolkId, key);
    },
    onSuccess: (res, invoiceId) => {
      // Dropped BEFORE the redirect, as on the invoice page: a household that
      // comes back to pay a different balance must not reuse a key Stripe
      // still holds.
      checkoutKeys.current.delete(invoiceId);
      // WHAT THIS REDIRECT GUARANTEES (#826). `window.location.href` unloads
      // the page, so this list cannot hold two live Checkout Sessions — and
      // for a while that was the only thing stopping a household being charged
      // twice for one bill, because `payInvoice` mints a fresh session and a
      // fresh PaymentIntent per call. `stripeWebhook` now refuses the second
      // settling session at the INVOICE level and sends the money to account
      // credit, so an in-page transition here is no longer a billing decision.
      // The longer version of this note is on `InvoiceDetail`'s copy.
      if (res.checkoutUrl) window.location.href = res.checkoutUrl;
    },
    // #2437: no checkout was opened because a payment on this bill is still
    // being recorded. The row stops offering Pay now and says so.
    onError: (err, invoiceId) => {
      const why = paymentBeingRecorded(err);
      if (why !== null) setRecording({ invoiceId, since: Date.now(), why });
    },
  }, { policy: 'abandon', what: 'your payment' });

  // HOLD. `redeemCredit` claims and applies inside one Firestore transaction,
  // so a second attempt re-reads the committed `creditRedeemedAt` and is
  // refused. It cannot credit an account twice.
  const redeem = usePortalMutation({
    mutationFn: (vars: { invoiceId: string }) => redeemCredit(vars.invoiceId, kinfolkId),
    // #1281: the button used to fall back to "Save to Account Balance" while
    // the list still showed the old balance, which read as a failure and drew
    // a second press. It now stays on its busy label until the reloaded list
    // shows the credit applied, and then says so in words.
    onSuccess: async () => {
      await refreshAfterSave(queryClient, myInvoicesKey(kinfolkId), accountCreditHistoryKey(kinfolkId));
      announceSaved('Credit saved');
    },
  }, { policy: 'hold', what: 'this credit' });

  // These two used to fail silently — a rejected mutation just stopped the
  // spinner with nothing telling the kinfolk why (same class of bug KinTales'
  // comment-post had before it was fixed). Surface each distinctly.
  //
  // #807: `errorLine` returns null for the three OFFLINE failures, which now
  // have their own sentence under the button. A red "Couldn't open checkout.
  // Try again." over a payment whose fate is unknown is the one line this
  // screen must not print.

  const { signOut, signingOut, error: signOutError } = useSignOut();

  // #1005: refused billing access is not a failure to report. Back to Home.
  if (invoices.isError && isPermissionDenied(invoices.error)) return <LeaveBilling />;
  if (invoices.isError) {
    return <LaunchError onRetry={() => void invoices.refetch()} retrying={invoices.isRefetching} onSignOut={signOut} signingOut={signingOut} signOutError={signOutError} />;
  }

  const data = invoices.data;
  // Two views over the one query, because the panels report separately: a
  // household with open bills and no paid history must still see the empty
  // "No paid invoices yet" card, and neither may show while the read is paused.
  const openView = viewOfQuery(invoices, { isEmpty: (d) => d.open.length === 0 });
  const paidView = viewOfQuery(invoices, { isEmpty: (d) => d.paid.length === 0 });

  // Derived balance-hero metrics, computed from already-fetched real fields
  // (no dedicated billing-summary callable exists).
  const creditsAvailableCents = (data?.credits ?? [])
    .filter((c) => c.creditRedeemedAtMs === null)
    .reduce((sum, c) => sum + (c.creditAmountCents ?? 0), 0);
  const openTotal = (data?.open ?? []).reduce((sum, i) => sum + i.amountDue, 0);
  const paidThisMonthTotal = (data?.paid ?? []).reduce((sum, i) => {
    const ms = i.date ? Date.parse(i.date) : NaN;
    if (Number.isNaN(ms)) return sum;
    const d = new Date(ms);
    const now = new Date();
    // #2090: a written-off invoice adds only what was actually paid on it.
    const paid = i.status === 'written_off' ? paidDollarsOf(i) : i.total;
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear() ? sum + paid : sum;
  }, 0);

  return (
    <>
      <PortalNav active="invoices" />

      <div className="wrap">
        <header className="hero-greet">
          <div className="kick">Billing</div>
          <h1>
            Your <span>invoices</span> and balance.
          </h1>
        </header>

        {data && data.accountBalanceCents > 0 && (
          <section className="balance">
            <div className="btag">ACCOUNT BALANCE</div>
            <div className="bnum">{formatCentsUsd(data.accountBalanceCents)}</div>
            {/* #1294: this figure is what the household can spend. #1872
                (operator ruling 2026-11-11): nothing takes it off a bill by
                itself any more; the admin applies an amount to an invoice. A
                credit below counts only once it is saved, so it is labelled as
                waiting, and the AUTO APPLIED chip that sat beside it is gone. */}
            <p className="bnote">What you can spend. Your Auntie applies it to an invoice for you.</p>
            <div className="brow">
              {creditsAvailableCents > 0 && (
                <>
                  <div className="bcell">
                    <small>Credits to save</small>
                    <b>{formatCentsUsd(creditsAvailableCents)}</b>
                  </div>
                  <span className="bdiv" />
                </>
              )}
              <div className="bcell">
                <small>Open invoices</small>
                <b>{formatUsd(openTotal)}</b>
              </div>
              <span className="bdiv" />
              <div className="bcell">
                <small>Paid this month</small>
                <b>{formatUsd(paidThisMonthTotal)}</b>
              </div>
            </div>
          </section>
        )}

        <div className="cols">
          <div className="stack">
            <section className="glass card d1">
              <div className="sectlabel">Open Invoices</div>
              {openView.kind === 'offline' ? (
                <OfflineNotice what="your invoices" />
              ) : openView.kind === 'empty' ? (
                <div className="empty">
                  <span className="ico">{'\u{1F4CB}'}</span>
                  <b>No open invoices</b>
                  <p>You are all caught up. New invoices will land here.</p>
                </div>
              ) : openView.kind !== 'data' ? (
                <LoadingLine what="your invoices" retry={() => void invoices.refetch()}>
            Loading your invoices…
          </LoadingLine>
              ) : (
                openView.data.open.map((inv, i) => (
                  <OpenRow
                    key={inv.id}
                    invoice={inv}
                    divider={i > 0}
                    payPhase={pay.variables === inv.id ? pay.phase : 'idle'}
                    onPay={() => pay.mutate(inv.id)}
                    // #2437: the "still being recorded" refusal has its own
                    // line under the row and is never printed as a failure.
                    payError={
                      pay.variables !== inv.id || paymentBeingRecorded(pay.error) !== null
                        ? null
                        : errorLine(pay, "Couldn't open checkout. Try again.")
                    }
                    recording={recording?.invoiceId === inv.id ? recording.why : null}
                    onCheckAgain={() => void invoices.refetch()}
                    viewerUid={viewerUid}
                  />
                ))
              )}
            </section>

            <section className="glass card d2">
              <div className="sectlabel">Paid History</div>
              {paidView.kind === 'offline' ? (
                <OfflineNotice what="your payment history" />
              ) : paidView.kind === 'empty' ? (
                <div className="empty">
                  <span className="ico">{'\u{1F9FE}'}</span>
                  <b>No paid invoices yet</b>
                  <p>Past payments and receipts will appear here.</p>
                </div>
              ) : paidView.kind !== 'data' ? (
                // Was `null`: a silent wait, with the section label sitting over
                // an empty card and nothing to tell a slow read from a finished
                // one. The 2026-09-12 ruling covers the waits that showed
                // nothing at all, not just the ones that showed a bare line.
                <LoadingLine what="your payment history" retry={() => void invoices.refetch()}>
                  Loading your payment history…
                </LoadingLine>
              ) : (
                paidView.data.paid.map((inv, i) => <PaidRow key={inv.id} invoice={inv} divider={i > 0} />)
              )}
            </section>
          </div>

          <div className="stack">
            <CreditHistorySection kinfolkId={kinfolkId} />
            {data && data.credits.length > 0 && (
              <section className="glass card creditcard d4">
                <div className="sectlabel">Credits</div>
                {data.credits.map((inv, i) => (
                  <CreditRow
                    key={inv.id}
                    invoice={inv}
                    divider={i > 0}
                    redeemPhase={redeem.variables?.invoiceId === inv.id ? redeem.phase : 'idle'}
                    onRedeem={() => redeem.mutate({ invoiceId: inv.id })}
                    redeemError={redeem.variables?.invoiceId !== inv.id ? null : errorLine(redeem, "Couldn't redeem this credit. Try again.")}
                  />
                ))}
              </section>
            )}
          </div>
        </div>

        <SettingsBusinessFootnote lead="Billed by" />
      </div>
    </>
  );
}

function invoiceTitle(inv: InvoiceDto): string {
  return inv.client ?? invoiceName(inv);
}

function OpenRow(props: {
  invoice: InvoiceDto;
  divider: boolean;
  payPhase: MutationPhase;
  onPay: () => void;
  payError?: string | null;
  /** #2437: the server's sentence while a payment on this bill is still being recorded, else null. */
  recording?: string | null;
  onCheckAgain?: () => void;
  viewerUid: string | null;
}) {
  const { invoice: inv, payPhase, onPay, payError, viewerUid } = props;
  // Was a `paying: boolean` off `isPending`, which is true for a mutation that
  // PAUSED offline as well as one the server is working on. The phase tells
  // those apart, which is all #807 is about.
  const paying = payPhase === 'sending' || payPhase === 'queued';
  // Part-paid keeps the open bucket and the Pay button; only what the row SAYS
  // about itself changes. "PENDING" alone would hide a payment already made.
  const status = invoiceRowStatusInfo(inv);
  const partPaid = partPaidSummary(inv);
  const tile = calTileFor(inv.dueDate);
  // The open bucket now carries four states (server-side map, ADR-0002).
  // "Due <date>" is a bill's line; a quote is not yet a bill and a zero
  // invoice asks for nothing, so neither claims a due date.
  const dueLabel =
    inv.status === 'draft' ? 'Not sent yet'
    // A quote the household turned down is not waiting on anybody. Saying "Not
    // billed yet" would read as still pending, which is the state they just
    // left. See functions/src/portal/quoteDecision.ts for why a declined quote
    // keeps `quote` status instead of becoming `cancelled`.
    : inv.status === 'quote' ? (inv.quoteDecision === 'denied' ? declinedRowLabel(inv, viewerUid) : 'Needs your answer')
    : inv.status === 'zero' ? 'No charge'
    : (shortDateLabel(inv.dueDate) === null ? 'No due date' : `Due ${shortDateLabel(inv.dueDate)}`);
  // One rule with the detail screen, and never on a paid invoice (docket Q5).
  // #2437: and not while a payment on this bill is still being recorded.
  const payable = offersPayment(inv) && !props.recording;

  return (
    <>
      <Link
        className={`inv ${status.invClass}`}
        to="/invoices/$invoiceId"
        params={{ invoiceId: inv.id }}
        style={props.divider ? undefined : { borderTop: 'none' }}
      >
        <div className="cal">
          <div className="m">{tile.month}</div>
          <div className="d">{tile.day}</div>
        </div>
        <div className="info">
          <b>{invoiceTitle(inv)}</b>
          <small className="id">
            {inv.client ? invoiceName(inv) : dueLabel}
            {inv.client ? ` · ${dueLabel}` : ''}
          </small>
        </div>
        <div className="amt">
          <span className="v">{formatUsd(inv.amountDue)}</span>
          <span className="due">{partPaid ?? dueLabel}</span>
        </div>
        <div className="end">
          <span className={`chip ${status.cssClass}`}>{status.chipLabel}</span>
          {payable ? (
            <button
              className="btn grad sm"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onPay();
              }}
              disabled={paying}
            >
              <MutationLabel mutation={{ phase: payPhase }} busy="Opening…">
                Pay now
              </MutationLabel>
            </button>
          ) : (
            <span className="btn ghost sm">View</span>
          )}
        </div>
      </Link>
      <OfflineMutationNotice phase={payPhase} what="your payment" check="this invoice" />
      {props.recording && (
        <div className="pay-check" data-testid="payment-being-recorded">
          <p className="pay-blocked">{props.recording}</p>
          <LoadingLine what="your payment" retry={props.onCheckAgain}>
            Checking payment…
          </LoadingLine>
        </div>
      )}
      {payError && <p style={{ color: 'var(--red)', marginTop: 8 }}>{payError}</p>}
    </>
  );
}

function PaidRow(props: { invoice: InvoiceDto; divider: boolean }) {
  const { invoice: inv } = props;
  const status = invoiceStatusInfo(inv.status, inv.creditRedeemedAtMs);
  const tile = calTileFor(inv.date);
  // #1330: with the year. A history spanning New Year read Jul 1, Jun 17, Dec 17.
  const paidLabel =
    inv.status === 'cancelled'
      ? 'No charge'
      : inv.status === 'written_off'
        ? WRITTEN_OFF_ROW_LABEL
        : (longDateLabel(inv.date) === null ? 'Paid' : `Paid ${longDateLabel(inv.date)}`);

  return (
    <Link className={`inv ${status.invClass}`} to="/invoices/$invoiceId" params={{ invoiceId: inv.id }} style={props.divider ? undefined : { borderTop: 'none' }}>
      <div className="cal">
        <div className="m">{tile.month}</div>
        <div className="d">{tile.day}</div>
      </div>
      <div className="info">
        <b>{invoiceTitle(inv)}</b>
        <small className="id">
          {inv.client ? `${invoiceName(inv)} · ${paidLabel}` : paidLabel}
        </small>
      </div>
      <div className="amt">
        <span className="v">{formatUsd(inv.total)}</span>
        <span className="due">{paidLabel}</span>
      </div>
      <div className="end">
        <span className={`chip ${status.cssClass}`}>{status.chipLabel}</span>
        <span className="btn ghost sm">{inv.status === 'cancelled' || inv.status === 'written_off' ? 'View' : 'Receipt'}</span>
      </div>
    </Link>
  );
}

function CreditRow(props: { invoice: InvoiceDto; divider: boolean; redeemPhase: MutationPhase; onRedeem: () => void; redeemError?: string | null }) {
  const { invoice: inv, redeemPhase, onRedeem, redeemError } = props;
  const redeeming = redeemPhase === 'sending' || redeemPhase === 'queued';
  const redeemed = inv.creditRedeemedAtMs !== null;
  const cents = inv.creditAmountCents ?? 0;

  return (
    <div className="crow" style={props.divider ? { marginTop: 8 } : undefined}>
      <div className="ci">{'\u{1F3C6}'}</div>
      <div className="cmeta">
        <b>{invoiceTitle(inv)}</b>
        <small>
          {invoiceName(inv)}.{' '}
          {redeemed ? 'It is in your account balance.' : 'Save it to your account balance to spend it.'}
        </small>
        {redeemed && (
          <span className="savedline">
            {'✓'} {creditTargetLabel(inv.creditTarget)}
          </span>
        )}
        {!redeemed && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
            <button className="btn grad block" onClick={() => onRedeem()} disabled={redeeming}>
              <MutationLabel mutation={{ phase: redeemPhase }} busy="Working…">
                Save to Account Balance
              </MutationLabel>
            </button>
            <OfflineMutationNotice phase={redeemPhase} what="this credit" check="your account balance" />
            {redeemError && <p style={{ color: 'var(--red)', marginTop: 8 }}>{redeemError}</p>}
          </div>
        )}
      </div>
      <span className="camt">{formatCentsUsd(cents)}</span>
    </div>
  );
}
