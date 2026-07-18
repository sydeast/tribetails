import { useMemo } from 'react';
import { SESSIONS_QUERY, type SessionEntry } from '../../api/sessions';
import { getKinfolkProfile } from '../../api/kinfolkProfile';
import { useCollection } from '../../lib/firestore';
import { useOneShot } from '../../lib/useOneShot';
import { nextUpcomingSession, safeboxAccessLines } from '../../lib/dashboardInsights';
import { sessionHousehold, sessionWindow } from '../../lib/sessionFormat';
import { DenPanel, ServicePill, EmptyHint } from '../../components/DenScreenKit';
import { AsyncRegion } from '../../components/AsyncRegion';
import './widgets.css';

/**
 * AO-36 / punch-list W3 — Key & Code Safebox. Shows the access notes (gate/door
 * code, entry + parking notes, wifi) for the ONE next upcoming visit's household,
 * so the operator has exactly what they need for the next stop and nothing else.
 *
 * Two-step read: the bounded sessions stream picks the next upcoming visit
 * (`nextUpcomingSession`), then that visit's household profile is fetched on its
 * own (`SafeboxAccess`, keyed by kinfolkId so it reloads if the next visit
 * changes). Logic is in `lib/dashboardInsights.ts`; this only renders.
 */
export function SafeboxWidget() {
  const rows = useCollection<SessionEntry>(SESSIONS_QUERY);
  // A full ISO instant (not a local date): "upcoming" is future-of-now, and it
  // doesn't change mid-render, so compute it once.
  const nowIso = useMemo(() => new Date().toISOString(), []);

  return (
    <DenPanel
      title="Key & code safebox"
      subtitle="Access notes for your next visit only."
      hoverLift
    >
      <AsyncRegion
        state={rows}
        what="visits"
        isEmpty={(data) => nextUpcomingSession(data, nowIso) === null}
        loading={<EmptyHint>Loading visits…</EmptyHint>}
        empty={<EmptyHint>No upcoming visits on the books.</EmptyHint>}
      >
        {(data) => {
          // Non-null: isEmpty already returned false for this same data + nowIso.
          const next = nextUpcomingSession(data, nowIso)!;
          return (
            <div className="dash-widget">
              <div className="safebox__head">
                <span className="safebox__who">{sessionHousehold(next.kinfolkName)}</span>
                <ServicePill serviceType={next.serviceType} />
                <span className="safebox__when">{sessionWindow(next.startTime, next.endTime)}</span>
              </div>
              <SafeboxAccess kinfolkId={next.kinfolkId} />
            </div>
          );
        }}
      </AsyncRegion>
    </DenPanel>
  );
}

interface SafeboxAccessProps {
  kinfolkId: string;
}

/** The next visit's household access notes, loaded on their own by kinfolkId. */
function SafeboxAccess({ kinfolkId }: SafeboxAccessProps) {
  const profile = useOneShot(
    () => getKinfolkProfile(kinfolkId),
    `getKinfolkProfile:${kinfolkId}`,
  );

  return (
    <AsyncRegion
      state={profile}
      what="household access"
      isEmpty={() => false}
      loading={<EmptyHint>Loading access notes…</EmptyHint>}
      empty={<EmptyHint>Nothing to show.</EmptyHint>}
    >
      {(p) => {
        const lines = safeboxAccessLines(p);
        if (lines.length === 0) {
          return <EmptyHint>No access notes on file for this household.</EmptyHint>;
        }
        return (
          <dl className="safebox__facts">
            {lines.map((line) => (
              <div key={line.label} className="safebox__fact">
                <dt className="safebox__fact-label">{line.label}</dt>
                <dd
                  className={
                    line.mono ? 'safebox__fact-value safebox__fact-value--mono' : 'safebox__fact-value'
                  }
                >
                  {line.value}
                </dd>
              </div>
            ))}
          </dl>
        );
      }}
    </AsyncRegion>
  );
}
