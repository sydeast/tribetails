import { useMemo } from 'react';
import { SESSIONS_QUERY, type SessionEntry } from '../../api/sessions';
import { KIN_CARE_QUERY, type KinCareRow } from '../../api/kinCare';
import { useCollection } from '../../lib/firestore';
import { localDateIso } from '../../lib/invoiceFormat';
import { careFlags, type CareFlag, type KinCareInfo } from '../../lib/dashboardInsights';
import type { Async } from '../../lib/async';
import { DenPanel, EmptyHint } from '../../components/DenScreenKit';
import { AsyncRegion } from '../../components/AsyncRegion';
import './widgets.css';

/** How a flag's kind reads as a small chip label. */
const CARE_KIND_LABEL: Record<CareFlag['kind'], string> = {
  reactive: 'Reactive',
  medication: 'Meds',
  feeding: 'Feeding',
};

/**
 * AO-37 Care Flags. Reads NO callable: it streams the `kin` mirror (the three
 * care fields, `api/kinCare.ts`) and the bounded sessions list, then joins
 * today's non-cancelled visits to their pets to surface reactive, medication and
 * feeding cautions before the operator heads out. All logic is in
 * `lib/dashboardInsights.ts#careFlags`; this only renders.
 *
 * Both streams are required, so the two load states are combined into one: a
 * failure on EITHER is a fail-loud error (never a false "all clear"), a load in
 * flight on either is loading, and only once both are ready is the join run.
 */
export function CareFlagsWidget() {
  const kin = useCollection<KinCareRow>(KIN_CARE_QUERY);
  const sessions = useCollection<SessionEntry>(SESSIONS_QUERY);
  // A LOCAL calendar date (the AO-18 fix): "today" is the operator's day, not UTC.
  const todayIso = useMemo(() => localDateIso(new Date()), []);

  const combined: Async<CareFlag[]> = useMemo(() => {
    // Fail loud if either stream failed: an unreadable roster must never render
    // as an empty "nothing to flag" state.
    if (kin.status === 'error') return kin;
    if (sessions.status === 'error') return sessions;
    if (kin.status === 'loading' || sessions.status === 'loading') return { status: 'loading' };

    const kinById = new Map<string, KinCareInfo>();
    for (const k of kin.data) {
      kinById.set(k._id, {
        name: k.name ?? '',
        reactive: k.reactive === true,
        medicationHealthNotes: k.medicationHealthNotes ?? '',
        feedingBrand: k.feedingBrand ?? '',
      });
    }
    return { status: 'ready', data: careFlags(sessions.data, kinById, todayIso) };
  }, [kin, sessions, todayIso]);

  return (
    <DenPanel
      title="Care flags"
      subtitle="Reactive, meds and feeding notes for today's visits."
      hoverLift
    >
      <AsyncRegion
        state={combined}
        what="care flags"
        isEmpty={(data) => data.length === 0}
        loading={<EmptyHint>Loading care flags…</EmptyHint>}
        empty={<EmptyHint>No special care notes for today's roster.</EmptyHint>}
      >
        {(flags) => (
          <div className="dash-widget">
            <p className="dash-widget__count">
              {flags.length} <span className="dash-widget__count-unit">to mind</span>
            </p>
            <ul className="dash-widget__list">
              {flags.map((f) => (
                <li key={`${f.kinId}-${f.kind}`} className="care-flag" data-kind={f.kind}>
                  <span className="care-flag__chip">{CARE_KIND_LABEL[f.kind]}</span>
                  <span className="care-flag__body">
                    <span className="care-flag__who">
                      {f.kinName === '' ? 'Kin' : f.kinName}
                      <span className="care-flag__household"> · {f.household}</span>
                    </span>
                    <span className="care-flag__text">{f.text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </AsyncRegion>
    </DenPanel>
  );
}
