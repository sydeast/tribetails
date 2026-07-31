import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getMyInvoices, payInvoice, redeemCredit } from '../api/invoicesApi';
import type { InvoiceDto } from '../contracts/invoiceContracts.generated';
import {
  calTileFor,
  creditTargetLabel,
  formatCentsUsd,
  formatUsd,
  invoiceStatusInfo,
  partPaidStatusInfo,
  partPaidSummary,
  shortDateLabel,
} from '../lib/invoiceFormat';
import { useSignOut } from '../lib/auth';
import { getActiveKinfolkId } from '../lib/activeTribe';
import { PortalNav } from '../components/PortalNav';
import { LaunchError } from './LaunchError';
import '../styles/invoices.css';

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
  const invoices = useQuery({ queryKey: ['myInvoices', kinfolkId], queryFn: () => getMyInvoices(kinfolkId) });

  const pay = useMutation({
    mutationFn: (invoiceId: string) =>
      payInvoice(invoiceId, `${window.location.origin}/invoices/${invoiceId}`, `${window.location.origin}/invoices/${invoiceId}`, kinfolkId),
    onSuccess: (res) => {
      if (res.checkoutUrl) window.location.href = res.checkoutUrl;
    },
  });

  const redeem = useMutation({
    mutationFn: (vars: { invoiceId: string }) => redeemCredit(vars.invoiceId, kinfolkId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['myInvoices', kinfolkId] });
    },
  });

  // These two used to fail silently — a rejected mutation just stopped the
  // spinner with nothing telling the kinfolk why (same class of bug KinTales'
  // comment-post had before it was fixed). Surface each distinctly.
  function mutationErrorMessage(err: unknown, fallback: string): string {
    return err instanceof Error && err.message ? err.message : fallback;
  }

  const { signOut, signingOut } = useSignOut();

  if (invoices.isError) {
    return <LaunchError onRetry={() => void invoices.refetch()} retrying={invoices.isRefetching} onSignOut={signOut} signingOut={signingOut} />;
  }

  const data = invoices.data;

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
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear() ? sum + i.total : sum;
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
            <p className="bnote">Available credit on your account. Applied automatically to your next invoice.</p>
            <div className="brow">
              <div className="bcell">
                <small>Credits</small>
                <b>{formatCentsUsd(creditsAvailableCents)}</b>
              </div>
              <span className="bdiv" />
              <div className="bcell">
                <small>Open invoices</small>
                <b>{formatUsd(openTotal)}</b>
              </div>
              <span className="bdiv" />
              <div className="bcell">
                <small>Paid this month</small>
                <b>{formatUsd(paidThisMonthTotal)}</b>
              </div>
              <div className="bcell" style={{ marginLeft: 'auto', alignSelf: 'flex-end' }}>
                <span className="chip light">AUTO APPLIED</span>
              </div>
            </div>
          </section>
        )}

        <div className="cols">
          <div className="stack">
            <section className="glass card d1">
              <div className="sectlabel">Open Invoices</div>
              {invoices.isLoading ? (
                <p className="sub">Loading your invoices…</p>
              ) : !data || data.open.length === 0 ? (
                <div className="empty">
                  <span className="ico">{'\u{1F4CB}'}</span>
                  <b>No open invoices</b>
                  <p>You are all caught up. New invoices will land here.</p>
                </div>
              ) : (
                data.open.map((inv, i) => (
                  <OpenRow
                    key={inv.id}
                    invoice={inv}
                    divider={i > 0}
                    paying={pay.isPending && pay.variables === inv.id}
                    onPay={() => pay.mutate(inv.id)}
                    payError={pay.isPending || pay.variables !== inv.id ? null : (pay.isError ? mutationErrorMessage(pay.error, "Couldn't open checkout. Try again.") : null)}
                  />
                ))
              )}
            </section>

            <section className="glass card d2">
              <div className="sectlabel">Paid History</div>
              {invoices.isLoading ? null : !data || data.paid.length === 0 ? (
                <div className="empty">
                  <span className="ico">{'\u{1F9FE}'}</span>
                  <b>No paid invoices yet</b>
                  <p>Past payments and receipts will appear here.</p>
                </div>
              ) : (
                data.paid.map((inv, i) => <PaidRow key={inv.id} invoice={inv} divider={i > 0} />)
              )}
            </section>
          </div>

          <div className="stack">
            {data && data.credits.length > 0 && (
              <section className="glass card creditcard d4">
                <div className="sectlabel">Credits</div>
                {data.credits.map((inv, i) => (
                  <CreditRow
                    key={inv.id}
                    invoice={inv}
                    divider={i > 0}
                    redeeming={redeem.isPending && redeem.variables?.invoiceId === inv.id}
                    onRedeem={() => redeem.mutate({ invoiceId: inv.id })}
                    redeemError={redeem.isPending || redeem.variables?.invoiceId !== inv.id ? null : (redeem.isError ? mutationErrorMessage(redeem.error, "Couldn't redeem this credit. Try again.") : null)}
                  />
                ))}
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

function invoiceTitle(inv: InvoiceDto): string {
  return inv.client ?? `Invoice #${inv.id}`;
}

function OpenRow(props: { invoice: InvoiceDto; divider: boolean; paying: boolean; onPay: () => void; payError?: string | null }) {
  const { invoice: inv, paying, onPay, payError } = props;
  // Part-paid keeps the open bucket and the Pay button; only what the row SAYS
  // about itself changes. "PENDING" alone would hide a payment already made.
  const status = inv.partiallyPaid ? partPaidStatusInfo() : invoiceStatusInfo(inv.status, inv.creditRedeemedAtMs);
  const partPaid = partPaidSummary(inv);
  const tile = calTileFor(inv.dueDate);
  // The open bucket now carries four states (server-side map, ADR-0002).
  // "Due <date>" is a bill's line; a quote is not yet a bill and a zero
  // invoice asks for nothing, so neither claims a due date.
  const dueLabel =
    inv.status === 'draft' ? 'Not sent yet'
    : inv.status === 'quote' ? 'Not billed yet'
    : inv.status === 'zero' ? 'No charge'
    : `Due ${shortDateLabel(inv.dueDate) ?? '—'}`;
  const payable = inv.status === 'open' && inv.amountDue > 0;

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
            {inv.client ? `Invoice #${inv.id}` : dueLabel}
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
              {paying ? 'Opening…' : 'Pay now'}
            </button>
          ) : (
            <span className="btn ghost sm">View</span>
          )}
        </div>
      </Link>
      {payError && <p style={{ color: 'var(--red)', marginTop: 8 }}>{payError}</p>}
    </>
  );
}

function PaidRow(props: { invoice: InvoiceDto; divider: boolean }) {
  const { invoice: inv } = props;
  const status = invoiceStatusInfo(inv.status, inv.creditRedeemedAtMs);
  const tile = calTileFor(inv.date);
  const paidLabel = inv.status === 'cancelled' ? 'No charge' : `Paid ${shortDateLabel(inv.date) ?? '—'}`;

  return (
    <Link className={`inv ${status.invClass}`} to="/invoices/$invoiceId" params={{ invoiceId: inv.id }} style={props.divider ? undefined : { borderTop: 'none' }}>
      <div className="cal">
        <div className="m">{tile.month}</div>
        <div className="d">{tile.day}</div>
      </div>
      <div className="info">
        <b>{invoiceTitle(inv)}</b>
        <small className="id">
          {inv.client ? `Invoice #${inv.id} · ${paidLabel}` : paidLabel}
        </small>
      </div>
      <div className="amt">
        <span className="v">{formatUsd(inv.total)}</span>
        <span className="due">{paidLabel}</span>
      </div>
      <div className="end">
        <span className={`chip ${status.cssClass}`}>{status.chipLabel}</span>
        <span className="btn ghost sm">{inv.status === 'cancelled' ? 'View' : 'Receipt'}</span>
      </div>
    </Link>
  );
}

function CreditRow(props: { invoice: InvoiceDto; divider: boolean; redeeming: boolean; onRedeem: () => void; redeemError?: string | null }) {
  const { invoice: inv, redeeming, onRedeem, redeemError } = props;
  const redeemed = inv.creditRedeemedAtMs !== null;
  const cents = inv.creditAmountCents ?? 0;

  return (
    <div className="crow" style={props.divider ? { marginTop: 8 } : undefined}>
      <div className="ci">{'\u{1F3C6}'}</div>
      <div className="cmeta">
        <b>{invoiceTitle(inv)}</b>
        <small>
          Invoice #{inv.id}.{' '}
          {redeemed ? 'Applied automatically to your next invoice.' : 'Save this to your account balance.'}
        </small>
        {redeemed && (
          <span className="savedline">
            {'✓'} {creditTargetLabel(inv.creditTarget)}
          </span>
        )}
        {!redeemed && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
            <button className="btn grad block" onClick={() => onRedeem()} disabled={redeeming}>
              {redeeming ? 'Working…' : 'Save to Account Balance'}
            </button>
            {redeemError && <p style={{ color: 'var(--red)', marginTop: 8 }}>{redeemError}</p>}
          </div>
        )}
      </div>
      <span className="camt">{formatCentsUsd(cents)}</span>
    </div>
  );
}
