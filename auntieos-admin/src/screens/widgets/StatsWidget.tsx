import { useMemo } from 'react';
import { StatCard } from '../../components/DenScreenKit';
import { asyncScalar, type Async, type ResolvedScalar } from '../../lib/async';
import {
  activeKinCount,
  formatRevenue,
  mondayOfWeekIso,
  pendingDraftCount,
  pendingTaleRows,
  todayPack,
  weeklyRevenue,
} from '../../lib/dashboardInsights';
import {
  useDraftsStream,
  useInvoicesStream,
  useKinStream,
  useSessionsStream,
  useTodayIso,
} from './homeData';
import type { GeneratedDraftRow } from '../../api/drafts';
import './widgets.css';

/**
 * W1 The stat row, the parity port of android `HomeScreen.kt`'s `DashKey.STATS`
 * block: four tiles reading today's run, the review queue, the pack and the
 * week's takings. Same four, same order, same trend lines.
 *
 * Every tile goes through `asyncScalar`, so a number here is a number somebody
 * actually read. That is not decoration: the 2026-07-15 defect this project
 * keeps citing was a stat card printing a confident "0" over a permission
 * denial, and `StatCard` takes a `ResolvedScalar<number>` precisely so there is
 * nowhere left to put a `?? 0`. A failed stream shows a dash and names the
 * failure; a loading one shows an ellipsis and claims nothing.
 *
 * The tile is always full width in the layout model (`normalize` in
 * `lib/dashboardLayout.ts` forces `stats` wide), so the four cards lay
 * themselves out inside it: four across on a wide board, two on a medium one,
 * one on a phone. Android does the same 2x2 fold; this only adds the four-wide
 * case the phone has no room for.
 */
export function StatsWidget() {
  const sessions = useSessionsStream();
  const drafts = useDraftsStream();
  const kin = useKinStream();
  const invoices = useInvoicesStream();
  const todayIso = useTodayIso();

  const pack = useMemo(
    () =>
      sessions.status === 'ready' ? todayPack(sessions.data, todayIso) : null,
    [sessions, todayIso],
  );

  // The week window the revenue tile sums over: Monday to today, inclusive,
  // the same bound android's `localWeekStartIso()` computes.
  const weekStart = useMemo(() => mondayOfWeekIso(todayIso), [todayIso]);

  const todayValue: ResolvedScalar<number> = asyncScalar(sessions, (rows) =>
    todayPack(rows, todayIso).visits.length,
  );
  const reviewValue: ResolvedScalar<number> = asyncScalar(drafts, pendingDraftCount);
  const kinValue: ResolvedScalar<number> = asyncScalar(kin, activeKinCount);
  const revenueValue: ResolvedScalar<number> = asyncScalar(invoices, (rows) =>
    weekStart === null ? 0 : weeklyRevenue(rows, weekStart, todayIso),
  );

  return (
    <div className="stat-row">
      <StatCard
        label="Today's pack"
        value={todayValue}
        trend={
          pack === null
            ? ''
            : `${String(pack.done)} done, ${String(pack.onTheWay)} on the way`
        }
        tone="orange"
        feature
        className="stat-row__feature"
      />
      <StatCard
        label="KinTales to review"
        value={reviewValue}
        trend={trendForDrafts(drafts)}
        tone="teal"
      />
      <StatCard label="Kin in care" value={kinValue} trend="across all households" tone="purple" />
      <StatCard
        label="This week"
        value={revenueValue}
        trend="paid invoices this week"
        tone="success"
        formatValue={formatRevenue}
      />
    </div>
  );
}

/**
 * "3 recent drafts", or nothing at all while the stream is not ready.
 *
 * Returned blank rather than guessed, because `StatCard` renders a trend ONLY
 * beside a real value; a sentence composed from data nobody read would be the
 * second half of the bug the value guard above closes.
 */
function trendForDrafts(drafts: Async<GeneratedDraftRow[]>): string {
  if (drafts.status !== 'ready') return '';
  const shown = pendingTaleRows(drafts.data, 4).length;
  return `${String(shown)} recent draft${shown === 1 ? '' : 's'}`;
}
