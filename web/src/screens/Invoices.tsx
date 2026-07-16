import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getMyInvoices, payInvoice, redeemCredit } from '../api/invoicesApi';
import type { CreditTarget, InvoiceDto } from '../api/invoicesApi';
import { calTileFor, creditTargetLabel, formatCentsUsd, formatUsd, invoiceStatusInfo, shortDateLabel } from '../lib/invoiceFormat';
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
    mutationFn: (vars: { invoiceId: string; target: CreditTarget }) => redeemCredit(vars.invoiceId, vars.target, kinfolkId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['myInvoices', kinfolkId] });
    },
  });

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
                    onRedeem={(target) => redeem.mutate({ invoiceId: inv.id, target })}
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

function OpenRow(props: { invoice: InvoiceDto; divider: boolean; paying: boolean; onPay: () => void }) {
  const { invoice: inv, paying, onPay } = props;
  const status = invoiceStatusInfo(inv.status, inv.creditRedeemedAtMs);
  const tile = calTileFor(inv.dueDate);
  const dueLabel = inv.status === 'draft' ? 'Not sent yet' : `Due ${shortDateLabel(inv.dueDate) ?? '—'}`;
  const payable = inv.status === 'open' && inv.amountDue > 0;

  return (
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
        <span className="due">{dueLabel}</span>
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

function CreditRow(props: { invoice: InvoiceDto; divider: boolean; redeeming: boolean; onRedeem: (target: CreditTarget) => void }) {
  const { invoice: inv, redeeming, onRedeem } = props;
  const redeemed = inv.creditRedeemedAtMs !== null;
  const cents = inv.creditAmountCents ?? 0;
  const hasOriginalPi = !!inv.originalPaymentIntentId;

  return (
    <div className="crow" style={props.divider ? { marginTop: 8 } : undefined}>
      <div className="ci">{'\u{1F3C6}'}</div>
      <div className="cmeta">
        <b>{invoiceTitle(inv)}</b>
        <small>Invoice #{inv.id}. {redeemed ? 'Applied automatically to your next invoice.' : 'Choose how to use this credit.'}</small>
        {redeemed && (
          <span className={`savedline ${inv.creditTarget === 'originalPaymentMethod' ? 'muted' : ''}`}>
            {'✓'} {creditTargetLabel(inv.creditTarget)}
          </span>
        )}
        {!redeemed && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
            <button className="btn grad block" onClick={() => onRedeem('accountBalance')} disabled={redeeming}>
              {redeeming ? 'Working…' : 'Save to Account Balance'}
            </button>
            <button className="btn ghost block" onClick={() => onRedeem('originalPaymentMethod')} disabled={redeeming || !hasOriginalPi}>
              Return to Original Payment Method
            </button>
            {!hasOriginalPi && <p className="sub">Original card not on file — only Account Balance is available.</p>}
          </div>
        )}
      </div>
      <span className="camt">{formatCentsUsd(cents)}</span>
    </div>
  );
}
