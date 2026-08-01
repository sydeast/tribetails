import { useMemo } from 'react';
import { DenPanel, EmptyHint } from '../../components/DenScreenKit';
import { AsyncRegion } from '../../components/AsyncRegion';
import { formatUsd } from '../../lib/invoiceFormat';
import { mondayOfWeekIso, outstandingTotals, weeklyRevenue } from '../../lib/dashboardInsights';
import { useInvoicesStream, useTodayIso } from './homeData';
import './widgets.css';

/**
 * W15 Cash Flow, the parity port of android `HomeScreen.kt`'s
 * `DashKey.CASH_FLOW` panel: money in this week, money still owed, and how many
 * invoices that is.
 *
 * The two amounts come from separate rules on purpose, both in
 * `lib/dashboardInsights.ts`. "Earned this week" is the canonical PAID test
 * (`invoiceIsPaidForRevenue`) over invoices DATED in the Monday-to-today
 * window; "Outstanding" is every invoice with a live balance, whatever week it
 * belongs to. Archived invoices count towards neither: written off is neither
 * earned nor owed.
 *
 * Amounts render with cents (`formatUsd`), unlike the stat tile's rounded
 * `formatRevenue`. Android draws the same distinction between its `formatMoney`
 * and `formatRevenue`, and for the same reason: a tile is a glance, a ledger
 * row is an amount somebody may be about to chase.
 *
 * A FAILED INVOICE READ IS NOT "$0 EARNED". `AsyncRegion` shows the failure and
 * says the region is unknown, because a dashboard that reports zero revenue
 * during a permission error is the exact defect this codebase is built around.
 */
export function CashFlowWidget() {
  const invoices = useInvoicesStream();
  const todayIso = useTodayIso();
  const weekStart = useMemo(() => mondayOfWeekIso(todayIso), [todayIso]);

  return (
    <DenPanel
      title="Cash Flow"
      subtitle="Money in this week, and what is still owed."
      hoverLift
    >
      <AsyncRegion
        state={invoices}
        what="invoices"
        // Never empty: zero earned and zero owed is a real, reportable answer,
        // and hiding it behind an empty state would make a quiet week look like
        // a broken card.
        isEmpty={() => false}
        loading={<EmptyHint>Loading invoices…</EmptyHint>}
        empty={<EmptyHint>No invoices on the books yet.</EmptyHint>}
      >
        {(rows) => {
          const earned = weekStart === null ? 0 : weeklyRevenue(rows, weekStart, todayIso);
          const owed = outstandingTotals(rows);
          return (
            <div className="dash-widget">
              <dl className="cash-flow">
                <div className="cash-flow__row" data-tone="success">
                  <dt className="cash-flow__label">Earned this week</dt>
                  <dd className="cash-flow__value">{formatUsd(earned)}</dd>
                </div>
                <div
                  className="cash-flow__row"
                  data-tone={owed.total > 0 ? 'orange' : 'success'}
                >
                  <dt className="cash-flow__label">Outstanding</dt>
                  <dd className="cash-flow__value">{formatUsd(owed.total)}</dd>
                </div>
              </dl>
              <p className="cash-flow__note">
                {owed.count} unpaid invoice{owed.count === 1 ? '' : 's'}
              </p>
            </div>
          );
        }}
      </AsyncRegion>
    </DenPanel>
  );
}
