import { useState } from 'react';
import { type BusinessSettings, type MyTribePortalConfig } from '../../api/settings';
import { DenPanel } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton } from '../../components/Buttons';
import { Toggle } from '../../components/Toggle';
import { portalHomeSummary } from '../../lib/settingsFormat';
// The `settingsEdit__*` class vocabulary these sections use lives here. It is
// also depended on by the sibling editors (BusinessHoursEditor, TimeOffEditor,
// KinCareRatesEditor), which import their own CSS but reuse these input / save-row
// / toggle classes, so this import is what keeps them styled now that the old
// SettingsEdit.tsx (its former home) is gone.
import '../SettingsEdit.css';

/**
 * The independently-saving Settings section editors, lifted out of the old
 * `SettingsEdit.tsx` verbatim when the read-only overview and the editor were
 * merged into the single nav-driven `Settings.tsx`. Each one still owns its own
 * draft state, Save action, and busy/error banner, exactly as before: nothing
 * about how a section saves changed, only where these components are mounted
 * (one at a time, behind a section nav, instead of all stacked in one scroll).
 *
 * There is no callable for any of this (`business_settings` is `allow write: if
 * isAuntie()` in `firestore.rules`, a direct client write), so every section
 * saves through the shared `persist` the shell hands down as `onSave`, a
 * `setDoc(..., {merge: true})` on the single doc (`api/settingsWrite.ts`).
 */

// ── Field specs (Business profile / Weather area / Payments / Branding) ──────

/**
 * The `BusinessSettings` fields rendered as a plain text input. Restricted to
 * the doc's actual `string` fields (verified against `api/settings.ts`), so
 * `TextFieldsSection` can read/write them without a single `any`.
 */
export type StringFieldKey =
  | 'businessName'
  | 'businessEmail'
  | 'businessPhone'
  | 'businessAddress'
  | 'weatherLocation'
  | 'venmoHandle'
  | 'paypalHandle'
  | 'cashappHandle'
  | 'logoUrl'
  | 'brandWordmark'
  | 'brandTagline'
  | 'homeGreeting'
  | 'homeAccentTail';

export interface TextFieldSpec {
  key: StringFieldKey;
  label: string;
  placeholder?: string;
  type?: 'text' | 'email' | 'tel';
}

export const BUSINESS_PROFILE_FIELDS: readonly TextFieldSpec[] = [
  { key: 'businessName', label: 'Business name' },
  { key: 'businessEmail', label: 'Email', type: 'email' },
  { key: 'businessPhone', label: 'Phone', type: 'tel' },
  { key: 'businessAddress', label: 'Address' },
];

export const WEATHER_AREA_FIELDS: readonly TextFieldSpec[] = [
  { key: 'weatherLocation', label: 'City, metro, or ZIP', placeholder: 'Austin, TX' },
];

export const PAYMENT_FIELDS: readonly TextFieldSpec[] = [
  { key: 'venmoHandle', label: 'Venmo handle', placeholder: '@tribetails' },
  { key: 'paypalHandle', label: 'PayPal', placeholder: 'you@email.com or paypal.me/tribetails' },
  { key: 'cashappHandle', label: 'Cash App', placeholder: '$tribetails' },
];

export const BRANDING_FIELDS: readonly TextFieldSpec[] = [
  { key: 'logoUrl', label: 'Logo URL', placeholder: 'https://…' },
  { key: 'brandWordmark', label: 'App name', placeholder: 'AuntieOS' },
  { key: 'brandTagline', label: 'Tagline', placeholder: 'Tribe Tails Care' },
  { key: 'homeGreeting', label: 'Home greeting' },
  { key: 'homeAccentTail', label: 'Home accent word', placeholder: 'Auntie.' },
];

// ── Business profile / Weather area / Payment options / Branding ────────────

interface TextFieldsSectionProps {
  title: string;
  subtitle: string;
  data: BusinessSettings;
  fields: readonly TextFieldSpec[];
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}

/**
 * One panel of plain text fields, one Save button. Local `values` is seeded
 * ONCE from `data` at mount (a lazy initializer, not an effect keyed on
 * `data`): a sibling section's save round-trips through the SAME `data` prop
 * (see the shell's `persist`), so re-deriving `values` from `data` on every
 * change would silently erase an in-progress edit here whenever the operator
 * saved a DIFFERENT panel first. `dirty` compares live against `data` instead,
 * which self-heals to false the moment this section's own save lands (the
 * trimmed value the operator typed and the freshly-persisted `data` value
 * agree), without needing to know THAT is why `data` changed.
 */
export function TextFieldsSection({ title, subtitle, data, fields, onSave }: TextFieldsSectionProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const f of fields) seed[f.key] = data[f.key];
    return seed;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const dirty = fields.some((f) => (values[f.key] ?? '') !== data[f.key]);

  function update(key: StringFieldKey, next: string) {
    setValues((v) => ({ ...v, [key]: next }));
    setJustSaved(false);
  }

  async function handleSave() {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    const patch: Partial<Pick<BusinessSettings, StringFieldKey>> = {};
    for (const f of fields) patch[f.key] = (values[f.key] ?? '').trim();
    try {
      await onSave(patch);
      setJustSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <DenPanel title={title} subtitle={subtitle}>
      {error ? (
        <Banner tone="error" title="Save failed" className="settingsEdit__sectionBanner">
          {error}
        </Banner>
      ) : null}
      <div className="settingsEdit__fields">
        {fields.map((f) => (
          <label key={f.key} className="settingsEdit__field">
            <span className="settingsEdit__fieldLabel">{f.label}</span>
            <input
              type={f.type ?? 'text'}
              className="settingsEdit__input"
              value={values[f.key] ?? ''}
              {...(f.placeholder !== undefined ? { placeholder: f.placeholder } : {})}
              disabled={busy}
              onChange={(e) => update(f.key, e.target.value)}
            />
          </label>
        ))}
      </div>
      <div className="settingsEdit__saveRow">
        <PrimaryButton
          label={busy ? 'Saving…' : 'Save'}
          onClick={() => void handleSave()}
          disabled={!dirty || busy}
          busy={busy}
        />
        {justSaved && !dirty ? <span className="settingsEdit__savedNote">Saved</span> : null}
      </div>
    </DenPanel>
  );
}

// ── Booking behavior ─────────────────────────────────────────────────────────

type BookingToggleKey = 'autoConfirmRepeatKinfolk' | 'snapRescheduleTo15Min';

interface BookingBehaviorSectionProps {
  data: BusinessSettings;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}

/**
 * Two instant-save toggles, no separate Save button, matching the wasm
 * `BookingBehaviorPanel`'s `AuntieToggle(checked = s?.field == true, onCheckedChange
 * = { vm.saveSettings(s.copy(field = next)) })`: the switch reads straight off the
 * loaded doc and saves on every flip, rather than staging a draft. `data` (not a
 * local optimistic copy) drives `checked`, so a failed save leaves the switch
 * exactly where it was (the fail-loud error banner explains why) instead of
 * showing a flip that never actually persisted.
 */
export function BookingBehaviorSection({ data, onSave }: BookingBehaviorSectionProps) {
  const [savingKey, setSavingKey] = useState<BookingToggleKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(key: BookingToggleKey, next: boolean) {
    if (savingKey) return;
    setSavingKey(key);
    setError(null);
    try {
      await onSave({ [key]: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <DenPanel
      title="Booking behavior"
      subtitle="How new bookings are confirmed and adjusted. Each toggle saves immediately."
    >
      {error ? (
        <Banner tone="error" title="Save failed" className="settingsEdit__sectionBanner">
          {error}
        </Banner>
      ) : null}
      <ul className="settingsEdit__toggleList">
        <li className="settingsEdit__toggleRow">
          <span className="settingsEdit__toggleLabel">Auto-confirm repeat kinfolk</span>
          <Toggle
            label="Toggle auto-confirm repeat kinfolk"
            checked={data.autoConfirmRepeatKinfolk}
            disabled={savingKey !== null}
            onChange={(next) => void toggle('autoConfirmRepeatKinfolk', next)}
          />
        </li>
        <li className="settingsEdit__toggleRow">
          <span className="settingsEdit__toggleLabel">Snap drag-to-reschedule to 15 min</span>
          <Toggle
            label="Toggle snap drag-to-reschedule to 15 min"
            checked={data.snapRescheduleTo15Min}
            disabled={savingKey !== null}
            onChange={(next) => void toggle('snapRescheduleTo15Min', next)}
          />
        </li>
      </ul>
    </DenPanel>
  );
}

// ── MyTribe portal (theme id, banner, chat; Home layout stays deferred) ─────

interface MyTribePortalSectionProps {
  data: BusinessSettings;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}

/**
 * One combined Save/Cancel bar for the whole sub-object, matching the wasm
 * `MyTribePanel`'s single `AuntieSaveBar` for `mytribePortal` (dirty = `portal !=
 * loaded`) rather than a Save per field. `portal` seeds once from `data` at mount,
 * same non-clobbering rationale as `TextFieldsSection` above. The patch sends the
 * WHOLE `mytribePortal` object (not per-field), which is safe under `merge: true`:
 * it deep-merges the nested map, and `portal` already carries `home` unchanged
 * (never mutated here), so a save can never blank out the Home layout a sibling
 * surface configured. The Home layout stays view-only (no drag-reorder editor in
 * this repo yet); it is shown, read-only, at the foot of the panel so the merge
 * did not lose the summary the old overview rendered.
 */
export function MyTribePortalSection({ data, onSave }: MyTribePortalSectionProps) {
  const [portal, setPortal] = useState<MyTribePortalConfig>(() => data.mytribePortal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const dirty = JSON.stringify(portal) !== JSON.stringify(data.mytribePortal);

  function edit(next: MyTribePortalConfig) {
    setPortal(next);
    setJustSaved(false);
  }

  async function handleSave() {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ mytribePortal: portal });
      setJustSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  function handleCancel() {
    setPortal(data.mytribePortal);
    setError(null);
    setJustSaved(false);
  }

  return (
    <DenPanel
      title="MyTribe portal"
      subtitle="The kinfolk-facing portal chrome. Home layout editing isn&rsquo;t available here yet; theme, top banner, and the Message Auntie chat are below."
    >
      {error ? (
        <Banner tone="error" title="Save failed" className="settingsEdit__sectionBanner">
          {error}
        </Banner>
      ) : null}

      <label className="settingsEdit__field">
        <span className="settingsEdit__fieldLabel">Theme id</span>
        <input
          type="text"
          className="settingsEdit__input"
          value={portal.themeId}
          placeholder="default"
          disabled={busy}
          onChange={(e) => edit({ ...portal, themeId: e.target.value })}
        />
      </label>

      <div className="settingsEdit__subsection">
        <div className="settingsEdit__toggleRow">
          <span className="settingsEdit__toggleLabel">Show top banner</span>
          <Toggle
            label="Toggle the portal top banner"
            checked={portal.banner.enabled}
            disabled={busy}
            onChange={(next) => edit({ ...portal, banner: { ...portal.banner, enabled: next } })}
          />
        </div>
        <label className="settingsEdit__field">
          <span className="settingsEdit__fieldLabel">Banner message</span>
          <input
            type="text"
            className="settingsEdit__input"
            value={portal.banner.message}
            placeholder="Closed for the holiday"
            disabled={busy || !portal.banner.enabled}
            onChange={(e) => edit({ ...portal, banner: { ...portal.banner, message: e.target.value } })}
          />
        </label>
      </div>

      <div className="settingsEdit__subsection">
        <div className="settingsEdit__toggleRow">
          <span className="settingsEdit__toggleLabel">Message Auntie chat</span>
          <Toggle
            label="Toggle the Message Auntie chat"
            checked={portal.chat.enabled}
            disabled={busy}
            onChange={(next) => edit({ ...portal, chat: { ...portal.chat, enabled: next } })}
          />
        </div>
        <label className="settingsEdit__field">
          <span className="settingsEdit__fieldLabel">Away message</span>
          <input
            type="text"
            className="settingsEdit__input"
            value={portal.chat.awayMessage}
            placeholder="We're out with the pups, back soon"
            disabled={busy || !portal.chat.enabled}
            onChange={(e) => edit({ ...portal, chat: { ...portal.chat, awayMessage: e.target.value } })}
          />
        </label>
      </div>

      <div className="settingsEdit__subsection">
        <span className="settingsEdit__fieldLabel">Home layout</span>
        <p className="settingsEdit__readonlyValue">{portalHomeSummary(portal.home)}</p>
        <p className="settingsEdit__hint">
          The Home layout&rsquo;s drag-to-reorder editor isn&rsquo;t built here yet, so this stays
          view-only. Everything above saves for real.
        </p>
      </div>

      <div className="settingsEdit__saveRow">
        <GhostButton label="Cancel" onClick={handleCancel} disabled={!dirty || busy} />
        <PrimaryButton
          label={busy ? 'Saving…' : 'Save'}
          onClick={() => void handleSave()}
          disabled={!dirty || busy}
          busy={busy}
        />
        {justSaved && !dirty ? <span className="settingsEdit__savedNote">Saved</span> : null}
      </div>
    </DenPanel>
  );
}

// Google Calendar sync used to live here as a read-only panel whose hint said
// syncing "needs a Google sign-in that isn't wired into this admin yet". That
// was wrong: the free/busy import runs as a service account inside the Cloud
// Function and needs no sign-in from any client. It is now a real editor with a
// Run Sync action, in its own file, `./CalendarSyncSection.tsx`.
