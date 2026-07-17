import { useCallback, useEffect, useState } from 'react';
import { getBusinessSettings, type BusinessSettings, type MyTribePortalConfig } from '../api/settings';
import { saveBusinessSettings } from '../api/settingsWrite';
import { type Async } from '../lib/async';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { Toggle } from '../components/Toggle';
import { lastSavedLabel } from '../lib/settingsFormat';
import './SettingsEdit.css';

/**
 * The Settings EDITOR: the write surface the read-only `Settings.tsx` overview
 * deferred (see that file's header). Loads `business_settings/business_settings`
 * the same one-shot way the overview does, then renders one `DenPanel` per
 * editable section, each with ITS OWN Save action and its own busy/error state,
 * mirroring the wasm `SettingsScreen.kt`: every panel there (`BusinessProfilePanel`,
 * `PaymentOptionsPanel`, `WeatherAreaPanel`, `BookingBehaviorPanel`, `BrandingPanel`,
 * `MyTribePanel`) is its own independently-saved unit, not one giant form with a
 * single submit. There is no callable for any of this (verified: `business_settings`
 * is `allow write: if isAuntie()` in `firestore.rules`, a direct client write, not a
 * Cloud Function), so every section saves through `saveBusinessSettings`
 * (`api/settingsWrite.ts`), a `setDoc(..., {merge: true})` on the single doc.
 *
 * SCOPE, deliberately partial: ships real, saving field editors for the simple
 * sections (Business profile, Weather area, Booking behavior, Payment options,
 * Branding, MyTribe portal chrome). It does NOT build the complex sub-editors the
 * wasm screen has for:
 *   - Business hours (the day-by-day open/close grid)
 *   - Time off (US-holiday checklist + company-holiday and special-hours date lists)
 *   - KinCare types (add/rename/remove service-rate rows)
 *   - Google Calendar sync (the connect/sync action, not just the id field)
 *   - MyTribe portal Home layout (the section drag-reorder editor) and its logo
 *     upload (Cloudinary picker; out of scope without that pipeline in this repo)
 * Those stay exactly as read-only as the overview already renders them (this
 * screen does not re-render them at all; the operator returns to the overview to
 * see them). This is flagged here, in the on-screen banner below, and in the
 * fan-out report, not silently dropped.
 */
interface SettingsEditProps {
  /** Called when the operator leaves the editor (the "Back to overview" action). */
  onDone: () => void;
}

/**
 * The `BusinessSettings` fields this editor renders as a plain text input.
 * Restricted to the doc's actual `string` fields (verified against `api/settings.ts`),
 * so `TextFieldsSection` below can read/write them without a single `any`.
 */
type StringFieldKey =
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

interface TextFieldSpec {
  key: StringFieldKey;
  label: string;
  placeholder?: string;
  type?: 'text' | 'email' | 'tel';
}

const BUSINESS_PROFILE_FIELDS: readonly TextFieldSpec[] = [
  { key: 'businessName', label: 'Business name' },
  { key: 'businessEmail', label: 'Email', type: 'email' },
  { key: 'businessPhone', label: 'Phone', type: 'tel' },
  { key: 'businessAddress', label: 'Address' },
];

const WEATHER_AREA_FIELDS: readonly TextFieldSpec[] = [
  { key: 'weatherLocation', label: 'City, metro, or ZIP', placeholder: 'Austin, TX' },
];

const PAYMENT_FIELDS: readonly TextFieldSpec[] = [
  { key: 'venmoHandle', label: 'Venmo handle', placeholder: '@tribetails' },
  { key: 'paypalHandle', label: 'PayPal', placeholder: 'you@email.com or paypal.me/tribetails' },
  { key: 'cashappHandle', label: 'Cash App', placeholder: '$tribetails' },
];

const BRANDING_FIELDS: readonly TextFieldSpec[] = [
  { key: 'logoUrl', label: 'Logo URL', placeholder: 'https://…' },
  { key: 'brandWordmark', label: 'App name', placeholder: 'AuntieOS' },
  { key: 'brandTagline', label: 'Tagline', placeholder: 'Tribe Tails Care' },
  { key: 'homeGreeting', label: 'Home greeting' },
  { key: 'homeAccentTail', label: 'Home accent word', placeholder: 'Auntie.' },
];

export function SettingsEdit({ onDone }: SettingsEditProps) {
  const [settings, setSettings] = useState<Async<BusinessSettings>>({ status: 'loading' });

  // Hoisted so a failed load can hand AsyncRegion a real retry, the
  // FeatureFlags.tsx / Settings.tsx convention.
  const load = useCallback(() => {
    let live = true;
    setSettings({ status: 'loading' });
    getBusinessSettings()
      .then((data) => live && setSettings({ status: 'ready', data }))
      .catch(
        (err: unknown) =>
          live &&
          setSettings({
            status: 'error',
            message: `Couldn't read business settings: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: load,
          }),
      );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  // Shared write plumbing every section's Save button calls with ONLY that
  // section's own fields. Folds the confirmed stamp back onto the local
  // ready-baseline (no re-fetch): the doc IS what was just written, merged
  // onto what was already loaded, so a sibling section's un-saved edits (kept
  // in ITS OWN local state, never re-derived from this baseline after mount)
  // are untouched, and `lastSavedLabel` reflects the save immediately.
  const persist = useCallback(async (patch: Partial<BusinessSettings>) => {
    const stamp = await saveBusinessSettings(patch);
    setSettings((prev) =>
      prev.status === 'ready' ? { status: 'ready', data: { ...prev.data, ...patch, ...stamp } } : prev,
    );
  }, []);

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Admin"
        title="Edit"
        accentTail="settings."
        subtitle="Change a section, then Save it. Each section below saves on its own."
        trailing={<GhostButton label="Back to overview" onClick={onDone} />}
      />

      <Banner tone="info" dashed pillLabel="Some sections deferred">
        Business hours, time off (holidays and special hours), KinCare type rates, Google Calendar
        sync, and the MyTribe Home layout aren&rsquo;t editable here yet. Everything below saves for
        real; those stay view-only on the overview for now.
      </Banner>

      <AsyncRegion
        state={settings}
        what="business settings"
        isEmpty={() => false}
        loading={<p className="settingsEdit__hint">Loading business settings…</p>}
        empty={<p className="settingsEdit__hint">No settings found.</p>}
      >
        {(data) => (
          <>
            <p className="settingsEdit__updated">{lastSavedLabel(data.updatedAt, data.updatedBy)}</p>

            <TextFieldsSection
              title="Business profile"
              subtitle="Who kinfolk and invoices contact."
              data={data}
              fields={BUSINESS_PROFILE_FIELDS}
              onSave={persist}
            />

            <TextFieldsSection
              title="Weather area"
              subtitle="Coverage area for the Home weather widgets. A city, metro, or ZIP (e.g. &ldquo;Austin, TX&rdquo;), not a street address."
              data={data}
              fields={WEATHER_AREA_FIELDS}
              onSave={persist}
            />

            <BookingBehaviorSection data={data} onSave={persist} />

            <TextFieldsSection
              title="Payment options"
              subtitle="How kinfolk pay you; each handle prints on every invoice. Leave one blank to hide it."
              data={data}
              fields={PAYMENT_FIELDS}
              onSave={persist}
            />

            <TextFieldsSection
              title="Branding"
              subtitle="Logo, app name, and Home greeting. Leave any field blank to keep the shipped default."
              data={data}
              fields={BRANDING_FIELDS}
              onSave={persist}
            />

            <MyTribePortalSection data={data} onSave={persist} />
          </>
        )}
      </AsyncRegion>
    </div>
  );
}

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
 * (see `persist` above), so re-deriving `values` from `data` on every change
 * would silently erase an in-progress edit here whenever the operator saved a
 * DIFFERENT panel first. `dirty` compares live against `data` instead, which
 * self-heals to false the moment this section's own save lands (the trimmed
 * value the operator typed and the freshly-persisted `data` value agree),
 * without needing to know THAT is why `data` changed.
 */
function TextFieldsSection({ title, subtitle, data, fields, onSave }: TextFieldsSectionProps) {
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
function BookingBehaviorSection({ data, onSave }: BookingBehaviorSectionProps) {
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
 * surface configured.
 */
function MyTribePortalSection({ data, onSave }: MyTribePortalSectionProps) {
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
