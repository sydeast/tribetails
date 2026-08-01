import { DenPanel, EmptyHint } from '../../components/DenScreenKit';
import { AsyncRegion } from '../../components/AsyncRegion';
import { speciesBreakdown } from '../../lib/dashboardInsights';
import { useKinStream } from './homeData';
import './widgets.css';

/**
 * W10 Kin by type, the parity port of android's `PetBreakdownWidget`: the pack
 * grouped by species, biggest group first.
 *
 * A pet with no species on file is counted as "Unknown" rather than dropped.
 * Dropping it would make the widget's total quietly disagree with the "Kin in
 * care" tile above it, and the honest reading of a blank species field is that
 * the label is missing, not the animal.
 *
 * Each row carries a proportional bar as well as the count, because a list of
 * five numbers is not a breakdown. The bar is `<progress>` for the same reason
 * as the capacity card: the ratio it draws is also the ratio it announces.
 */
export function PetBreakdownWidget() {
  const kin = useKinStream();

  return (
    <DenPanel title="Kin by type" subtitle="Who is in the pack, by species." hoverLift>
      <AsyncRegion
        state={kin}
        what="the pack"
        isEmpty={(rows) => speciesBreakdown(rows).length === 0}
        loading={<EmptyHint>Loading the pack…</EmptyHint>}
        empty={<EmptyHint>No kin on the roster yet.</EmptyHint>}
      >
        {(rows) => {
          const slices = speciesBreakdown(rows);
          const total = slices.reduce((n, s) => n + s.count, 0);
          return (
            <div className="dash-widget">
              <p className="dash-widget__count">
                {total} <span className="dash-widget__count-unit">in the pack</span>
              </p>
              <ul className="dash-widget__list">
                {slices.map((s) => (
                  <li key={s.species} className="species-row">
                    <span className="species-row__name">{s.species}</span>
                    <progress
                      className="species-row__bar"
                      value={s.count}
                      max={total}
                      aria-label={`${s.species}, ${String(s.count)} of ${String(total)}`}
                    />
                    <span className="species-row__count">{s.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        }}
      </AsyncRegion>
    </DenPanel>
  );
}
