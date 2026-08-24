import { AsyncRegion } from './AsyncRegion';
import { DenPanel, EmptyHint } from './DenScreenKit';
import { useOneShot } from '../lib/useOneShot';
import { getDossier, type Dossier } from '../api/recipientContext';
import './AuntieNotesPanel.css';

/**
 * "Auntie's notes", the mock's third left-hand panel, headed `admin only`.
 *
 * WHAT IT READS is the household's DOSSIER, the admin-side record of what Auntie
 * knows about these people: how they like to be talked to, what she has been
 * told about the home, where the relationship stands. Android's profile has
 * shown it for a while (`DossierCard`); the React admin showed nothing, which is
 * one of the gaps issue #407 marks.
 *
 * THE STANDING RULING, restated because this is exactly the surface it governs:
 * dossiers and the_411 are ADMIN-ONLY and kinfolk never see them, and the
 * dossier band belongs on the ADMIN profile screen. That makes this panel
 * correct here and forbidden in `mytribe/web`. Nothing in this file may be
 * lifted into a kinfolk-facing surface.
 *
 * READ-ONLY. The dossier is written by the reconcile/synthesize pipeline, and
 * the one mutating action it ever had on a profile (clearing the migrated
 * household notes) was deliberately moved off this read-only screen and onto
 * the editor (K3/A8, `EditKinfolkScreen`). This panel does not bring it back.
 */
export function AuntieNotesPanel({ kinfolkId }: { kinfolkId: string }) {
  const state = useOneShot(() => getDossier(kinfolkId), 'getDossier');

  return (
    <DenPanel title="Auntie’s notes" meta="admin only">
      <AsyncRegion
        state={state}
        what="this household's dossier"
        isEmpty={(d) => d === null || !hasAnything(d)}
        empty={<EmptyHint>Nothing written about this household yet.</EmptyHint>}
      >
        {(dossier) => {
          // Unreachable when empty (AsyncRegion decides that branch), narrowed
          // for the type rather than defended against.
          if (dossier === null) return null;
          const summary = firstNonBlank(dossier.tldr, dossier.rawSummary);
          return (
            <>
              {summary !== '' && <p className="auntie-notes__box">{summary}</p>}
              <dl className="auntie-notes__facts">
                <Note label="Household notes" value={dossier.householdNotes} />
                <Note label="Communication style" value={dossier.communicationStyle} />
                <Note label="Relationship with Auntie" value={dossier.relationshipWithAuntie} />
              </dl>
            </>
          );
        }}
      </AsyncRegion>
    </DenPanel>
  );
}

/** One labelled note. A blank field renders nothing at all, never an empty row. */
function Note({ label, value }: { label: string; value: string }) {
  if (value.trim() === '') return null;
  return (
    <div className="auntie-notes__note">
      <dt className="auntie-notes__note-label">{label}</dt>
      <dd className="auntie-notes__note-value">{value}</dd>
    </div>
  );
}

function firstNonBlank(...values: string[]): string {
  return values.find((v) => v.trim() !== '') ?? '';
}

/** True when the dossier holds at least one thing worth showing. */
function hasAnything(d: Dossier): boolean {
  return [
    d.tldr,
    d.rawSummary,
    d.householdNotes,
    d.communicationStyle,
    d.relationshipWithAuntie,
  ].some((v) => v.trim() !== '');
}
