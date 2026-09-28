import {
  EMERGENCY_CONTACTS_MAX,
  EMERGENCY_CONTACTS_OVER_LIMIT,
  EMERGENCY_CONTACT_NAME_MAX,
  EMERGENCY_CONTACT_PHONE_MAX,
  EMERGENCY_CONTACT_RELATIONSHIP_MAX,
  type EmergencyContactDraft,
} from '../api/emergencyContacts';
import { GhostButton } from './Buttons';
import './EmergencyContactsEditor.css';

interface Props {
  idPrefix: string;
  value: EmergencyContactDraft[];
  onChange: (next: EmergencyContactDraft[]) => void;
  disabled?: boolean;
}

/**
 * The household's Emergency Contact. One per household (operator ruling
 * 2026-09-27, Q2). A household that still has two on file from the earlier
 * two-contact rule shows both, each with Remove, under a notice asking the
 * admin to remove one; nothing can be added past one. Every field stays
 * editable and clearable (an emptied relationship saves as null, which
 * `api/emergencyContacts.ts` handles on the way out).
 *
 * #829 review: the "who gets called" sentence is an info tip beside the card
 * title, which the caller places (a DenPanel on Edit, `InfoTip` on Add), never a
 * hover-only `title` on the slot, which does nothing on a phone. Inputs are
 * capped at the server's limits. Each slot is a named group, so "Remove" still
 * says which contact it acts on.
 */
export function EmergencyContactsEditor({ idPrefix, value, onChange, disabled = false }: Props) {
  const set = (i: number, patch: Partial<EmergencyContactDraft>) =>
    onChange(value.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const remove = (i: number) => onChange(value.filter((_, j) => j !== i));
  const overLimit = value.length > EMERGENCY_CONTACTS_MAX;

  return (
    <div className="ec-editor">
      {overLimit && (
        <p className="ec-editor__notice" role="note">
          {EMERGENCY_CONTACTS_OVER_LIMIT}
        </p>
      )}
      {value.map((d, i) => {
        const id = `${idPrefix}-ec-${i}`;
        return (
          <fieldset key={i} className="ec-editor__slot" aria-label={`Emergency Contact ${i + 1}`} disabled={disabled}>
            {overLimit && <legend className="ec-editor__legend">{`On file ${i + 1}`}</legend>}
            <div className="ec-editor__field">
              <label className="ec-editor__field-label" htmlFor={`${id}-name`}>
                Name
              </label>
              <input
                id={`${id}-name`}
                type="text"
                maxLength={EMERGENCY_CONTACT_NAME_MAX}
                value={d.name}
                onChange={(e) => set(i, { name: e.target.value })}
              />
            </div>
            <div className="ec-editor__field">
              <label className="ec-editor__field-label" htmlFor={`${id}-phone`}>
                Phone
              </label>
              <input
                id={`${id}-phone`}
                type="tel"
                maxLength={EMERGENCY_CONTACT_PHONE_MAX}
                value={d.phone}
                onChange={(e) => set(i, { phone: e.target.value })}
              />
            </div>
            <div className="ec-editor__field">
              <label className="ec-editor__field-label" htmlFor={`${id}-relationship`}>
                Relationship (optional)
              </label>
              <input
                id={`${id}-relationship`}
                type="text"
                maxLength={EMERGENCY_CONTACT_RELATIONSHIP_MAX}
                value={d.relationship}
                onChange={(e) => set(i, { relationship: e.target.value })}
              />
            </div>
            {overLimit && (
              <div className="ec-editor__actions">
                <GhostButton label="Remove" onClick={() => remove(i)} />
              </div>
            )}
          </fieldset>
        );
      })}
    </div>
  );
}
