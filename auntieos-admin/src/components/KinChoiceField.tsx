import {
  canChooseKin,
  chosenKin,
  rosterKinLabel,
  toggleKinChoice,
  type KinChoice,
  type KinRosterState,
} from '../lib/kinChoice';
import './KinChoiceField.css';

export interface KinChoiceFieldProps {
  /** Prefix for the ids this field owns, so two forms can be open at once. */
  idPrefix: string;
  /** The household's Kin, from `useHouseholdKinRoster`. */
  roster: KinRosterState;
  /** `null` is every Kin. */
  choice: KinChoice;
  onChange: (next: KinChoice) => void;
  /** The form's own label class, so the field reads like its neighbours. */
  labelClassName?: string;
}

/**
 * "Kin covered" on New booking and New visit (#1822, #1862).
 *
 * Operator ruling 2026-11-12: every visit covers every Kin. So by default this
 * NAMES the household's Kin and offers nothing to tick. With the "Choose Kin
 * for a visit" feature flag on, each Kin is a tick box, every one ticked to
 * begin with.
 *
 * The names are the server's own roster, the list the visit will be stored
 * with, so this field and the visit it makes cannot disagree.
 */
export function KinChoiceField({ idPrefix, roster, choice, onChange, labelClassName }: KinChoiceFieldProps) {
  if (roster.status === 'idle') return null;
  const labelId = `${idPrefix}-kin-label`;
  const choosing = canChooseKin(roster);
  return (
    <div className="kin-choice" data-kin-choice={choosing ? 'choose' : 'all'}>
      <span className={labelClassName ?? 'kin-choice__label'} id={labelId}>
        Kin covered
      </span>
      {roster.status === 'loading' ? (
        <span className="kin-choice__hint" role="status">
          Loading this household&rsquo;s Kin&hellip;
        </span>
      ) : roster.status === 'error' ? (
        <span className="kin-choice__error" role="alert">
          The Kin of this household could not be loaded. The visit still covers every Kin in the home.
        </span>
      ) : roster.kin.length === 0 ? (
        <span className="kin-choice__hint">No Kin on this household yet.</span>
      ) : !choosing ? (
        <div className="kin-choice__all" role="group" aria-labelledby={labelId}>
          <div className="kin-choice__all-title">All Kin in this home</div>
          <span className="kin-choice__all-names">{roster.kin.map(rosterKinLabel).join(', ')}</span>
        </div>
      ) : (
        <>
          <div className="kin-choice__chips" role="group" aria-labelledby={labelId}>
            {roster.kin.map((k) => {
              const picked = choice === null || choice.includes(k.id);
              return (
                <label key={k.id} className={picked ? 'kin-choice__chip kin-choice__chip--on' : 'kin-choice__chip'}>
                  <input
                    type="checkbox"
                    checked={picked}
                    onChange={() => onChange(toggleKinChoice(choice, k.id, roster.kin))}
                  />
                  <span>{rosterKinLabel(k)}</span>
                </label>
              );
            })}
          </div>
          {chosenKin(choice, roster.kin).length === 0 && (
            <span className="kin-choice__error" role="alert">
              Tick at least one Kin.
            </span>
          )}
        </>
      )}
    </div>
  );
}
