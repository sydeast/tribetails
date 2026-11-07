import { useMemo } from 'react';
import { DenPanel, EmptyHint } from '../../components/DenScreenKit';
import { LoadingRow } from '../../components/LoadingRow';
import { AsyncRegion } from '../../components/AsyncRegion';
import { PrimaryButton } from '../../components/Buttons';
import { pendingTaleRows } from '../../lib/dashboardInsights';
import { useDraftsStream } from './homeData';
import './widgets.css';

interface KinTalesPendingWidgetProps {
  /**
   * Opens Communicate, where a draft is reviewed and sent, on the draft with
   * this `generated_drafts` id, or on a blank form when null (#1563).
   */
  onReviewTales: (draftId: string | null) => void;
}

/**
 * W3 KinTales pending, the parity port of android `HomeScreen.kt`'s
 * `DashKey.KINTALES` panel: the newest generated drafts waiting on a sign-off,
 * four at a time, with the review queue's own button under them.
 *
 * READS `generated_drafts`, NOT `kin_care_reports`, exactly as the phone does.
 * See `api/drafts.ts` for why those are two different things and why putting
 * sent reports in a "waiting for your sign-off" card would be a false claim
 * about every row.
 *
 * The three slots per row are built by `pendingTaleRows`, which carries the
 * spec's item-6 fix: the household name appears ONCE, in the meta line. The old
 * Compose row printed it as both the subtitle and the meta, which is how the
 * live screenshot came to read "visit report / Sara / GENERATED · Sara".
 *
 * EVERY ROW OPENS ITS DRAFT, and the button opens the newest one (#1563). Both
 * used to lead nowhere useful: the rows were static, and the button opened a
 * blank Communicate form with no draft loaded, so a draft counted here could
 * never be reviewed or sent.
 */
export function KinTalesPendingWidget({ onReviewTales }: KinTalesPendingWidgetProps) {
  const drafts = useDraftsStream();
  const rows = useMemo(
    () => (drafts.status === 'ready' ? pendingTaleRows(drafts.data, 4) : []),
    [drafts],
  );

  return (
    <DenPanel
      title="KinTales pending"
      subtitle="Visit reports waiting for your sign-off."
      hoverLift
    >
      <AsyncRegion
        state={drafts}
        what="drafts"
        isEmpty={() => rows.length === 0}
        loading={<LoadingRow label="Loading drafts…" className="den-hint" />}
        empty={
          <>
            <EmptyHint>All caught up, no drafts waiting.</EmptyHint>
            <PrimaryButton label="Review and send tales" onClick={() => onReviewTales(null)} />
          </>
        }
      >
        {() => (
          <div className="dash-widget">
            <ul className="dash-widget__list">
              {rows.map((row, i) => (
                // The mark's tone cycles over three, matching the phone's
                // `index % 3`, so a stack of four rows reads as four rows.
                <li key={row.id} className="tale-row__item">
                  <button
                    type="button"
                    className="tale-row tale-row--open"
                    data-mark={i % 3}
                    onClick={() => onReviewTales(row.id)}
                  >
                    <span className="tale-row__mark" aria-hidden="true" />
                    <span className="tale-row__body">
                      <span className="tale-row__title">{row.title}</span>
                      <span className="tale-row__blurb">{row.blurb}</span>
                      <span className="tale-row__meta">{row.meta}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <PrimaryButton label="Review and send tales" onClick={() => onReviewTales(rows[0]?.id ?? null)} />
          </div>
        )}
      </AsyncRegion>
    </DenPanel>
  );
}
