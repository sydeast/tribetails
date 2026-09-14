import {
  EMERGENCY_CONTACTS_MAX,
  EMERGENCY_CONTACT_NAME_MAX,
  EMERGENCY_CONTACT_PHONE_MAX,
  EMERGENCY_CONTACT_RELATIONSHIP_MAX,
  EMPTY_EMERGENCY_CONTACT_DRAFT,
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
 * Up to two Emergency Contacts, index 0 called first. Every field stays
 * editable and clearable (an emptied relationship saves as null, which
 * `api/emergencyContacts.ts` handles on the way out).
 *
 * #829 review: the "who gets called" sentence is an info tip beside the card
 * title, which the caller places (a DenPanel on Edit, `InfoTip` on Add), never a
 * hover-only `title` on the slot, which does nothing on a phone. Inputs are
 * capped at the server's limits. Each slot is a named group, so "Call first"
 * and "Remove" read as what they do and still say which contact they act on.
 */
export function EmergencyContactsEditor({ idPrefix, value, onChange, disabled = false }: Props) {
  const set = (i: number, patch: Partial<EmergencyContactDraft>) =>
    onChange(value.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const remove = (i: number) => onChange(value.filter((_, j) => j !== i));
  const moveFirst = (i: number) => {
    const chosen = value[i];
    if (chosen === undefined) return;
    onChange([chosen, ...value.filter((_, j) => j !== i)]);
  };

  return (
    <div className="ec-editor">
      {value.map((d, i) => {
        const id = `${idPrefix}-ec-${i}`;
        return (
          <fieldset key={i} className="ec-editor__slot" aria-label={`Emergency Contact ${i + 1}`} disabled={disabled}>
            <legend className="ec-editor__legend">{i === 0 ? 'Called first' : 'Called second'}</legend>
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
            {value.length > 1 && (
              <div className="ec-editor__actions">
                {i > 0 && <GhostButton label="Call first" onClick={() => moveFirst(i)} />}
                <GhostButton label="Remove" onClick={() => remove(i)} />
              </div>
            )}
          </fieldset>
        );
      })}
      {value.length < EMERGENCY_CONTACTS_MAX && (
        <GhostButton
          label="Add a second Emergency Contact"
          disabled={disabled}
          onClick={() => onChange([...value, { ...EMPTY_EMERGENCY_CONTACT_DRAFT }])}
        />
      )}
    </div>
  );
}
