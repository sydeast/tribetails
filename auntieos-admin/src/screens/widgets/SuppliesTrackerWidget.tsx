import { useState } from 'react';
import { useOneShot } from '../../lib/useOneShot';
import { listSupplies, adjustSupply, type SupplyRow } from '../../api/supplies';
import { lowSupplies } from '../../lib/dashboardInsights';
import { DenPanel, EmptyHint, ErrorHint } from '../../components/DenScreenKit';
import { LoadingRow } from '../../components/LoadingRow';
import { AsyncRegion } from '../../components/AsyncRegion';
import { GhostButton } from '../../components/Buttons';
import './widgets.css';

/**
 * AO-41 Supplies Tracker. Loads `listSupplies`, headlines how many are at or
 * below par (the server's `lowCount`), and lists the low ones most-depleted
 * first with a +1 restock control on each. Adjusting calls `adjustSupply` then
 * reloads; a rejected adjust fails LOUD on the row (never a silent phantom
 * restock). Row selection/order is `lib/dashboardInsights.ts#lowSupplies`.
 *
 * Reload rides [nonce] in the one-shot's label: bumping it re-fires the load
 * effect for a genuine refetch.
 */
export function SuppliesTrackerWidget() {
  const [nonce, setNonce] = useState(0);
  const list = useOneShot(listSupplies, `listSupplies#${nonce}`);
  const reload = (): void => setNonce((n) => n + 1);

  return (
    <DenPanel
      title="Supplies tracker"
      subtitle="What is running low, and a tap to restock."
      hoverLift
    >
      <AsyncRegion
        state={list}
        what="supplies"
        isEmpty={(data) => data.lowCount === 0}
        loading={<LoadingRow label="Loading supplies…" className="den-hint" />}
        empty={<EmptyHint>Everything is stocked above par.</EmptyHint>}
      >
        {(data) => {
          const low = lowSupplies(data.supplies);
          return (
            <div className="dash-widget">
              <p className="dash-widget__count">
                {data.lowCount} <span className="dash-widget__count-unit">low</span>
              </p>
              <ul className="dash-widget__list">
                {low.map((s) => (
                  <SupplyRowItem key={s._id} supply={s} onAdjusted={reload} />
                ))}
              </ul>
            </div>
          );
        }}
      </AsyncRegion>
    </DenPanel>
  );
}

interface SupplyRowItemProps {
  supply: SupplyRow;
  /** Called after a successful adjust so the parent can reload the list. */
  onAdjusted: () => void;
}

/** One low-supply row with a +1 restock button that fails loud on rejection. */
function SupplyRowItem({ supply, onAdjusted }: SupplyRowItemProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bump = (): void => {
    setBusy(true);
    setError(null);
    void adjustSupply(supply._id, 1)
      .then(() => {
        setBusy(false);
        onAdjusted();
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(`adjustSupply failed: ${err instanceof Error ? err.message : 'Adjust failed'}`);
      });
  };

  // Name, on-hand count and the restock control are three SIBLING cells, not a
  // stacked pair plus a button. The name is the only elastic one, so it is the
  // only one that truncates, and the counts line up in a column of their own
  // down the list instead of each starting wherever its name ended. `title`
  // keeps the full name reachable when it is cut.
  return (
    <li className="supply-row">
      <span className="supply-row__name" title={supply.name}>
        {supply.name}
      </span>
      <span className="supply-row__count">
        {supply.onHand} / {supply.par} {supply.unit}
      </span>
      <GhostButton label={busy ? '…' : '+1'} onClick={bump} disabled={busy} />
      {error !== null && (
        <span className="supply-row__error">
          <ErrorHint>{error}</ErrorHint>
        </span>
      )}
    </li>
  );
}
