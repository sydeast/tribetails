import { useState } from 'react';
import type { BusinessSettings } from '../../api/settings';
import { DenPanel } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton } from '../../components/Buttons';
import { deviceTimeZone, isUsableTimeZone, timeZoneOptions } from '../../lib/businessOperations';
import { BUSINESS_PROFILE_FIELDS, type StringFieldKey } from './sections';
import '../SettingsEdit.css';

/**
 * ISSUE #709: Business profile, now carrying the business's own contact
 * fields AND its time zone as fields of the SAME panel, saved by the SAME
 * Save button.
 *
 * Issue #519 gave the time zone its own panel (`TimeZoneSection`, now
 * deleted) on the reasoning that a validated picker with real consequences
 * (a wrong value silently makes the phone line answer as open around the
 * clock) deserved its own save gate before going out. Operator ruling,
 * 2026-09-10 walk mark 36: "Time Zone needs to be in the profile box; not
 * its own block." This panel is the fold: the picker keeps its own
 * validation (a zone this runtime cannot format still blocks the WHOLE
 * panel's Save, with the same warning banner `TimeZoneSection` showed), but
 * there is one panel, one Save, and one Cancel for the business's identity
 * now. `TimeZoneSection.tsx` is deleted; nothing else imported it.
 */

interface BusinessProfileSectionProps {
  data: BusinessSettings;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}

interface Draft {
  values: Record<string, string>;
  timeZone: string;
}

function seed(data: BusinessSettings): Draft {
  const values: Record<string, string> = {};
  for (const f of BUSINESS_PROFILE_FIELDS) values[f.key] = data[f.key];
  return { values, timeZone: data.timeZone };
}

export function BusinessProfileSection({ data, onSave }: BusinessProfileSectionProps) {
  // Seeded ONCE at mount, the `TextFieldsSection` non-clobbering convention: a
  // sibling section's save round-trips through the same `data` prop.
  const [draft, setDraft] = useState<Draft>(() => seed(data));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const zoneOptions = timeZoneOptions(data.timeZone);
  const device = deviceTimeZone();
  const usable = isUsableTimeZone(draft.timeZone);

  const fieldsDirty = BUSINESS_PROFILE_FIELDS.some((f) => (draft.values[f.key] ?? '') !== data[f.key]);
  const zoneDirty = draft.timeZone !== data.timeZone;
  const dirty = fieldsDirty || zoneDirty;

  function updateField(key: StringFieldKey, next: string) {
    setDraft((d) => ({ ...d, values: { ...d.values, [key]: next } }));
    setJustSaved(false);
  }

  function updateZone(next: string) {
    setDraft((d) => ({ ...d, timeZone: next }));
    setJustSaved(false);
  }

  async function handleSave() {
    if (!dirty || busy || !usable) return;
    setBusy(true);
    setError(null);
    const textPatch: Partial<Pick<BusinessSettings, StringFieldKey>> = {};
    for (const f of BUSINESS_PROFILE_FIELDS) textPatch[f.key] = (draft.values[f.key] ?? '').trim();
    const patch: Partial<BusinessSettings> = { ...textPatch, timeZone: draft.timeZone };
    try {
      await onSave(patch);
      setJustSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  function handleCancel() {
    setDraft(seed(data));
    setError(null);
    setJustSaved(false);
  }

  return (
    <DenPanel
      title="Business profile"
      subtitle="Who kinfolk and invoices contact, the area the Home weather widgets cover, and the clock the business runs on."
    >
      {error ? (
        <Banner tone="error" title="Save failed" className="settingsEdit__sectionBanner">
          {error}
        </Banner>
      ) : null}

      <div className="settingsEdit__fields">
        {BUSINESS_PROFILE_FIELDS.map((f) => (
          <div key={f.key} className="settingsEdit__fieldGroup">
            <label className="settingsEdit__field">
              <span className="settingsEdit__fieldLabel">{f.label}</span>
              <input
                type={f.type ?? 'text'}
                className="settingsEdit__input"
                value={draft.values[f.key] ?? ''}
                {...(f.placeholder !== undefined ? { placeholder: f.placeholder } : {})}
                disabled={busy}
                onChange={(e) => updateField(f.key, e.target.value)}
                {...(f.hint ? { 'aria-describedby': `${f.key}-hint` } : {})}
              />
            </label>
            {f.hint ? (
              <span id={`${f.key}-hint`} className="settingsEdit__hint">
                {f.hint}
              </span>
            ) : null}
          </div>
        ))}
      </div>

      <div className="settingsEdit__subsection">
        <span className="settingsEdit__groupHeading">Time zone</span>
        <label className="settingsEdit__field">
          <span className="settingsEdit__fieldLabel">Business time zone</span>
          <select
            className="settingsEdit__input"
            value={draft.timeZone}
            disabled={busy}
            aria-describedby="timeZone-hint"
            onChange={(e) => updateZone(e.target.value)}
          >
            {zoneOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <span id="timeZone-hint" className="settingsEdit__hint">
          {device && device !== draft.timeZone
            ? `This computer is on ${device}. Times you type into the booking dialog stay on this computer's clock; the zone above is what the phone line and outgoing messages read.`
            : 'Times you type into the booking dialog use this computer’s clock. The zone above is what the phone line and outgoing messages read.'}
        </span>
        {!usable ? (
          <Banner tone="warning" title="This zone will not work" className="settingsEdit__sectionBanner">
            Nothing on this computer can read a time in &ldquo;{draft.timeZone}&rdquo;. Saved as it is,
            the phone line answers as open around the clock. Pick a zone from the list.
          </Banner>
        ) : null}
      </div>

      <div className="settingsEdit__saveRow">
        <GhostButton label="Cancel" onClick={handleCancel} disabled={!dirty || busy} />
        <PrimaryButton
          label={busy ? 'Saving…' : 'Save'}
          onClick={() => void handleSave()}
          disabled={!dirty || busy || !usable}
          busy={busy}
        />
        {justSaved && !dirty ? <span className="settingsEdit__savedNote">Saved</span> : null}
      </div>
    </DenPanel>
  );
}
