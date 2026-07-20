import { useMemo } from 'react';
import { useOneShot } from '../../lib/useOneShot';
import { listExpirations } from '../../api/expirations';
import { localDateIso, humanizeDate } from '../../lib/invoiceFormat';
import { upcomingExpirations } from '../../lib/dashboardInsights';
import { DenPanel, EmptyHint } from '../../components/DenScreenKit';
import { AsyncRegion } from '../../components/AsyncRegion';
import './widgets.css';

/** Friendly countdown copy: "Today" / "Tomorrow" / "in N days". */
function countdownLabel(daysUntil: number): string {
  if (daysUntil <= 0) return 'Today';
  if (daysUntil === 1) return 'Tomorrow';
  return `in ${daysUntil} days`;
}

interface ExpirationCountdownWidgetProps {
  /** How far ahead to look. Defaults to the 60-day horizon in the spec. */
  withinDays?: number;
}

/**
 * AO-39 Expiration Countdown. Loads the `listExpirations` one-shot and surfaces
 * the items lapsing within the horizon, soonest first, so gate codes, vet
 * records, cards and licenses get renewed before they bite. All logic is in
 * `lib/dashboardInsights.ts#upcomingExpirations`; this only renders. Empty is a
 * real "nothing due" state, distinct from a failed load (AsyncRegion never shows
 * the empty copy during an error).
 */
export function ExpirationCountdownWidget({ withinDays = 60 }: ExpirationCountdownWidgetProps) {
  const rows = useOneShot(listExpirations, 'listExpirations');
  const todayIso = useMemo(() => localDateIso(new Date()), []);

  return (
    <DenPanel
      title="Expiration countdown"
      subtitle="What lapses soon: gate codes, vet records, cards."
      hoverLift
    >
      <AsyncRegion
        state={rows}
        what="expirations"
        isEmpty={(data) => upcomingExpirations(data, todayIso, withinDays).length === 0}
        loading={<EmptyHint>Loading expirations…</EmptyHint>}
        empty={<EmptyHint>Nothing lapses in the next {withinDays} days.</EmptyHint>}
      >
        {(data) => {
          const upcoming = upcomingExpirations(data, todayIso, withinDays);
          return (
            <div className="dash-widget">
              <p className="dash-widget__count">
                {upcoming.length} <span className="dash-widget__count-unit">coming up</span>
              </p>
              <ul className="dash-widget__list">
                {upcoming.map((e) => (
                  <li
                    key={`${e.label}-${e.dateIso}`}
                    className="exp-row"
                    data-soon={e.daysUntil <= 7 ? 'true' : undefined}
                  >
                    <span className="exp-row__main">
                      <span className="exp-row__label">{e.label}</span>
                      <span className="exp-row__kind">{e.kind}</span>
                    </span>
                    <span className="exp-row__when">
                      <span className="exp-row__countdown">{countdownLabel(e.daysUntil)}</span>
                      <time className="exp-row__date" dateTime={e.dateIso}>
                        {humanizeDate(e.dateIso, todayIso)}
                      </time>
                    </span>
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
