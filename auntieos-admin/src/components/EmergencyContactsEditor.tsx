import { EMERGENCY_CONTACTS_MAX, EMPTY_EMERGENCY_CONTACT_DRAFT, type EmergencyContactDraft } from '../api/emergencyContacts';
import { GhostButton } from './Buttons';
import './EmergencyContactsEditor.css';

interface Props {
  idPrefix: string;
  value: EmergencyContactDraft[];
  onChange: (next: EmergencyContactDraft[]) => void;
  disabled?: boolean;
}

const WHO_GETS_CALLED = 'Called only when no kinfolk can be reached. The first one is called first.';

/**
 * Up to two Emergency Contacts, index 0 called first. Every field stays
 * editable and clearable (an emptied relationship saves as null, which
 * `api/emergencyContacts.ts` handles on the way out). The explanation of who
 * gets called lives on the slot's `title` tooltip, never as a subtitle under
 * the legend (operator ruling 2026-09-11).
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
          <fieldset
            key={i}
            className="ec-editor__slot"
            aria-label={`Emergency Contact ${i + 1}`}
            title={WHO_GETS_CALLED}
            disabled={disabled}
          >
            <legend className="ec-editor__legend">{i === 0 ? 'Called first' : 'Called second'}</legend>
            <div className="ec-editor__field">
              <label className="ec-editor__field-label" htmlFor={`${id}-name`}>
                Name
              </label>
              <input id={`${id}-name`} type="text" value={d.name} onChange={(e) => set(i, { name: e.target.value })} />
            </div>
            <div className="ec-editor__field">
              <label className="ec-editor__field-label" htmlFor={`${id}-phone`}>
                Phone
              </label>
              <input id={`${id}-phone`} type="tel" value={d.phone} onChange={(e) => set(i, { phone: e.target.value })} />
            </div>
            <div className="ec-editor__field">
              <label className="ec-editor__field-label" htmlFor={`${id}-relationship`}>
                Relationship (optional)
              </label>
              <input
                id={`${id}-relationship`}
                type="text"
                value={d.relationship}
                onChange={(e) => set(i, { relationship: e.target.value })}
              />
            </div>
            <div className="ec-editor__actions">
              {i > 0 && (
                <GhostButton label={`Call ${d.name.trim() || 'this contact'} first`} onClick={() => moveFirst(i)} />
              )}
              {value.length > 1 && (
                <GhostButton label={`Remove Emergency Contact ${i + 1}`} onClick={() => remove(i)} />
              )}
            </div>
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
