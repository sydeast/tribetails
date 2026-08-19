import { useState } from 'react';
import {
  formatFeeSchedule,
  isPaymentMethodEnabled,
  MAX_PAYMENT_INSTRUCTIONS_LENGTH,
  PAYMENT_METHOD_CATALOGUE,
  PAYMENT_METHOD_FEE_SCHEDULE,
  type BusinessSettings,
  type MyTribePortalConfig,
  type PaymentMethodRow,
  type PaymentOptionSetting,
} from '../../api/settings';
import { DenPanel } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton } from '../../components/Buttons';
import { Toggle } from '../../components/Toggle';
import { portalHomeSummary } from '../../lib/settingsFormat';
import { type ImageDecoder } from '../../lib/brandAssetFile';
import { LogoUploadField } from './LogoUploadField';
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
  | 'brandWordmark'
  | 'brandTagline'
  | 'homeGreeting'
  | 'homeAccentTail';

export interface TextFieldSpec {
  key: StringFieldKey;
  label: string;
  placeholder?: string;
  type?: 'text' | 'email' | 'tel';
  /** Small caption under the input. PR30: the Payments fields use it for the processor's fee schedule. */
  hint?: string;
}

/**
 * `weatherLocation` joins this list rather than keeping the nav entry it had.
 * Mark 16 of the 2026-08-17 walk: one text box does not need its own settings
 * page, and the operator put it here. Its label and hint carry the whole of
 * what the retired "Weather area" panel's subtitle used to say, because the
 * distinction that copy was drawing (a coverage AREA, not the street address
 * two fields above) matters more now that both live in one panel.
 */
export const BUSINESS_PROFILE_FIELDS: readonly TextFieldSpec[] = [
  { key: 'businessName', label: 'Business name' },
  { key: 'businessEmail', label: 'Email', type: 'email' },
  { key: 'businessPhone', label: 'Phone', type: 'tel' },
  { key: 'businessAddress', label: 'Address' },
  {
    key: 'weatherLocation',
    label: 'Weather area',
    placeholder: 'Austin, TX',
    hint: 'The area the Home weather widgets cover. A city, metro, or ZIP, not a street address.',
  },
];

// PR30: each hint is the processor's fee schedule (PAYMENT_METHOD_FEE_SCHEDULE
// — display only, never the charged fee; see that constant's header). The
// portal now offers each handle here as a "Pay with ___" button, which is
// also why the PayPal placeholder no longer suggests an email address: the
// portal's registry (paymentMethods.ts) can't turn an email into a working
// paypal.me link and omits the button rather than shipping a dead one, so a
// placeholder inviting that exact input would set the operator up to type a
// handle that quietly never appears to a kinfolk.
//
// ISSUE #409: still exported and still used. `PaymentOptionRow` reads its
// placeholders from this list, so the guidance an operator sees while typing
// a handle is written down in exactly one place. The three handles
// themselves have not moved: they are the same top-level `BusinessSettings`
// fields the PDF and the portal have always read.
export const PAYMENT_FIELDS: readonly TextFieldSpec[] = [
  { key: 'venmoHandle', label: 'Venmo handle', placeholder: '@tribetails', hint: `Venmo charges about ${formatFeeSchedule(PAYMENT_METHOD_FEE_SCHEDULE.venmo)} per payment.` },
  { key: 'paypalHandle', label: 'PayPal', placeholder: 'paypal.me/tribetails', hint: `PayPal charges about ${formatFeeSchedule(PAYMENT_METHOD_FEE_SCHEDULE.paypal)} per payment.` },
  { key: 'cashappHandle', label: 'Cash App', placeholder: '$tribetails', hint: `Cash App charges about ${formatFeeSchedule(PAYMENT_METHOD_FEE_SCHEDULE.cashapp)} per payment.` },
];

/**
 * `logoUrl` is NOT here any more. It was a free-text "Logo URL" box, which is
 * the placeholder this task replaced: it asked an operator to produce a hosted
 * image address by themselves, accepted any string including one pointing at
 * somebody else's server, and offered no way to see the result before saving.
 * The logo is now a real upload (`LogoUploadField`), and it saves through
 * `confirmBrandAssetUpload` rather than through this panel's Save bar, because
 * by the time Save could be pressed the file is already in Cloudinary.
 */
export const BRANDING_FIELDS: readonly TextFieldSpec[] = [
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
          <div key={f.key} className="settingsEdit__fieldGroup">
            <label className="settingsEdit__field">
              <span className="settingsEdit__fieldLabel">{f.label}</span>
              <input
                type={f.type ?? 'text'}
                className="settingsEdit__input"
                value={values[f.key] ?? ''}
                {...(f.placeholder !== undefined ? { placeholder: f.placeholder } : {})}
                disabled={busy}
                onChange={(e) => update(f.key, e.target.value)}
                {...(f.hint ? { 'aria-describedby': `${f.key}-hint` } : {})}
              />
            </label>
            {f.hint ? (
              // OUTSIDE the <label>, deliberately: text nested inside a <label>
              // is folded into the wrapped input's accessible NAME, which would
              // turn "Venmo handle" into "Venmo handle Venmo charges about
              // 1.9% + $0.10 per payment." `aria-describedby` (above) is the
              // correct role for this text — a description, not the name.
              <span id={`${f.key}-hint`} className="settingsEdit__hint">
                {f.hint}
              </span>
            ) : null}
          </div>
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

// ── Payment options (issue #409) ────────────────────────────────────────────

/**
 * Narrowed to the four fields this panel reads, the same call
 * `KinCareRatesEditor` makes: a test can then state a payment configuration
 * without building a fifty-field settings document that says nothing about
 * what is being tested.
 */
export type PaymentSettings = Pick<
  BusinessSettings,
  'paymentOptions' | 'venmoHandle' | 'paypalHandle' | 'cashappHandle'
>;

interface PaymentOptionsSectionProps {
  data: PaymentSettings;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}

/** The full draft this panel stages: one row per method, plus the three handles. */
interface PaymentDraft {
  options: Record<string, PaymentOptionSetting>;
  handles: Record<string, string>;
}

function seedDraft(data: PaymentSettings): PaymentDraft {
  const options: Record<string, PaymentOptionSetting> = {};
  const handles: Record<string, string> = {};
  for (const method of PAYMENT_METHOD_CATALOGUE) {
    options[method.id] = {
      enabled: isPaymentMethodEnabled(data.paymentOptions, method),
      instructions: data.paymentOptions[method.id]?.instructions ?? '',
    };
    if (method.handleField) handles[method.handleField] = data[method.handleField];
  }
  return { options, handles };
}

/**
 * ISSUE #409: Payment Options, a real toggle per method.
 *
 * This panel replaces three free-text boxes whose only off switch was
 * deleting the handle. Operator, 2026-08-17 walk mark 17: "make it a true
 * toggle for different payment option". Every method in the catalogue gets a
 * switch; the ones that need a handle keep the same box they always had, now
 * next to its switch, and the ones that are a sentence rather than a link get
 * a place to write it.
 *
 * ONE SAVE BUTTON, not per-flip saves like Booking behavior. A toggle and the
 * handle beside it are one decision ("offer Venmo, at this handle"), and
 * saving the switch the instant it moves would persist "Venmo is on" before
 * the operator has typed where to send the money.
 *
 * Turning a method off does NOT clear its handle or its instructions. That is
 * the point of having a toggle at all: the operator can stop offering Cash
 * App this month and turn it back on next month without going to find the
 * handle again.
 */
export function PaymentOptionsSection({ data, onSave }: PaymentOptionsSectionProps) {
  // Seeded ONCE at mount, same call and same reasoning as `TextFieldsSection`
  // above: a sibling section's save round-trips through the same `data` prop,
  // and re-deriving from it would wipe an edit in progress here.
  const [draft, setDraft] = useState<PaymentDraft>(() => seedDraft(data));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const saved = seedDraft(data);
  const dirty =
    PAYMENT_METHOD_CATALOGUE.some(
      (m) =>
        draft.options[m.id]?.enabled !== saved.options[m.id]?.enabled ||
        (draft.options[m.id]?.instructions ?? '').trim() !== (saved.options[m.id]?.instructions ?? '').trim(),
    ) ||
    Object.keys(saved.handles).some(
      (field) => (draft.handles[field] ?? '').trim() !== (saved.handles[field] ?? '').trim(),
    );

  function setEnabled(id: string, next: boolean) {
    setDraft((d) => ({ ...d, options: { ...d.options, [id]: { ...d.options[id], enabled: next } } }));
    setJustSaved(false);
  }

  function setInstructions(id: string, next: string) {
    setDraft((d) => ({ ...d, options: { ...d.options, [id]: { ...d.options[id], instructions: next } } }));
    setJustSaved(false);
  }

  function setHandle(field: string, next: string) {
    setDraft((d) => ({ ...d, handles: { ...d.handles, [field]: next } }));
    setJustSaved(false);
  }

  async function handleSave() {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    const options: Record<string, PaymentOptionSetting> = {};
    const patch: Partial<BusinessSettings> = {};
    for (const method of PAYMENT_METHOD_CATALOGUE) {
      // Written for EVERY method, including the ones left at their default.
      // An explicit flag is what lets a later change to a default stop
      // silently rewriting a decision the operator already made.
      options[method.id] = {
        enabled: draft.options[method.id]?.enabled ?? method.defaultEnabled,
        instructions: (draft.options[method.id]?.instructions ?? '').trim(),
      };
      // The handle keeps its own top-level field, untouched by the map. The
      // invoice PDF and the portal both still read it from there.
      if (method.handleField) {
        patch[method.handleField] = (draft.handles[method.handleField] ?? '').trim();
      }
    }
    patch.paymentOptions = options;
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
    <DenPanel
      title="Payment options"
      subtitle="Turn on the ways kinfolk can pay you. What is on here shows up on new invoices and prints on the PDF. Invoices already sent keep the options they were sent with."
    >
      {error ? (
        <Banner tone="error" title="Save failed" className="settingsEdit__sectionBanner">
          {error}
        </Banner>
      ) : null}
      <ul className="settingsEdit__toggleList">
        {PAYMENT_METHOD_CATALOGUE.map((method) => (
          <PaymentOptionRow
            key={method.id}
            method={method}
            enabled={draft.options[method.id]?.enabled ?? method.defaultEnabled}
            handle={method.handleField ? draft.handles[method.handleField] ?? '' : ''}
            instructions={draft.options[method.id]?.instructions ?? ''}
            busy={busy}
            onEnabledChange={(next) => setEnabled(method.id, next)}
            onHandleChange={(next) => method.handleField && setHandle(method.handleField, next)}
            onInstructionsChange={(next) => setInstructions(method.id, next)}
          />
        ))}
      </ul>
      <div className="settingsEdit__saveRow">
        <PrimaryButton
          label={busy ? 'Saving…' : 'Save payment options'}
          onClick={() => void handleSave()}
          disabled={!dirty || busy}
          busy={busy}
        />
        {justSaved && !dirty ? <span className="settingsEdit__savedNote">Saved</span> : null}
      </div>
    </DenPanel>
  );
}

interface PaymentOptionRowProps {
  method: PaymentMethodRow;
  enabled: boolean;
  handle: string;
  instructions: string;
  busy: boolean;
  onEnabledChange: (next: boolean) => void;
  onHandleChange: (next: string) => void;
  onInstructionsChange: (next: string) => void;
}

/**
 * One method: a switch, and whatever that method needs typed beside it.
 *
 * The handle and instructions boxes appear only while the method is ON.
 * Turning it off hides them rather than clearing them, so the values survive
 * and come back with the switch.
 *
 * The warning under an on-but-blank method is the one piece of copy that
 * earns its place: the portal omits a method it cannot render rather than
 * shipping a dead link, so an operator who flips Zelle on and types nothing
 * would otherwise get silence with no way to tell it from success.
 */
function PaymentOptionRow({
  method,
  enabled,
  handle,
  instructions,
  busy,
  onEnabledChange,
  onHandleChange,
  onInstructionsChange,
}: PaymentOptionRowProps) {
  const needsHandle = method.kind === 'link';
  const needsInstructions = method.kind === 'instructions';
  const blank =
    enabled &&
    ((needsHandle && handle.trim().length === 0) ||
      (needsInstructions && instructions.trim().length === 0));

  return (
    <li className="settingsEdit__toggleRow settingsEdit__paymentRow">
      <div className="settingsEdit__paymentHead">
        <span className="settingsEdit__toggleLabel">{method.label}</span>
        <Toggle
          label={`Offer ${method.label}`}
          checked={enabled}
          disabled={busy}
          onChange={onEnabledChange}
        />
      </div>
      {method.note ? <p className="settingsEdit__hint">{method.note}</p> : null}
      {method.fee ? (
        <p className="settingsEdit__hint">
          {method.label} charges about {formatFeeSchedule(method.fee)} per payment.
        </p>
      ) : null}
      {enabled && needsHandle && method.handleField ? (
        <label className="settingsEdit__field">
          <span className="settingsEdit__fieldLabel">{method.label} handle</span>
          <input
            type="text"
            className="settingsEdit__input"
            value={handle}
            placeholder={PAYMENT_FIELDS.find((f) => f.key === method.handleField)?.placeholder ?? ''}
            disabled={busy}
            onChange={(e) => onHandleChange(e.target.value)}
          />
        </label>
      ) : null}
      {enabled && needsInstructions ? (
        <label className="settingsEdit__field">
          <span className="settingsEdit__fieldLabel">What kinfolk should do</span>
          <textarea
            className="settingsEdit__input settingsEdit__textarea"
            rows={2}
            maxLength={MAX_PAYMENT_INSTRUCTIONS_LENGTH}
            value={instructions}
            placeholder={method.instructionsPlaceholder ?? ''}
            disabled={busy}
            onChange={(e) => onInstructionsChange(e.target.value)}
          />
        </label>
      ) : null}
      {blank ? (
        <p className="settingsEdit__hint settingsEdit__hint--warn">
          {needsHandle
            ? `Add your ${method.label} handle. Until then this stays off invoices, because a button with no handle behind it opens nothing.`
            : `Write what kinfolk should do. Until then this stays off invoices, because a heading with nothing under it tells them nothing.`}
        </p>
      ) : null}
    </li>
  );
}

// ── MyTribe portal (theme id, banner, chat; Home layout stays deferred) ─────

interface MyTribePortalSectionProps {
  data: BusinessSettings;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
  /** Folds an already-persisted server write (the logo) into the loaded settings without writing again. */
  onServerChanged: (patch: Partial<BusinessSettings>) => void;
  /** Test seam for the pre-upload dimension check. */
  decode?: ImageDecoder;
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
export function MyTribePortalSection({ data, onSave, onServerChanged, decode }: MyTribePortalSectionProps) {
  const [portal, setPortal] = useState<MyTribePortalConfig>(() => data.mytribePortal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const dirty = JSON.stringify(portal) !== JSON.stringify(data.mytribePortal);

  function edit(next: MyTribePortalConfig) {
    setPortal(next);
    setJustSaved(false);
  }

  /**
   * The logo is written by `confirmBrandAssetUpload`, not by this panel's Save.
   * Both copies have to learn about it, and MISSING THE SECOND ONE IS A REAL
   * BUG, not tidiness: `portal` is seeded once at mount and this panel saves the
   * WHOLE `mytribePortal` object, so an operator who uploaded a logo and then
   * changed the theme would write the stale, pre-upload `logoUrl` straight back
   * over the one the server had just stored, silently undoing the upload.
   */
  function applyLogo(result: { logoUrl: string; logoRemovedAt: string }) {
    setPortal((p) => ({ ...p, logoUrl: result.logoUrl, logoRemovedAt: result.logoRemovedAt }));
    onServerChanged({
      mytribePortal: { ...data.mytribePortal, logoUrl: result.logoUrl, logoRemovedAt: result.logoRemovedAt },
    });
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

      <LogoUploadField
        kind="portalLogo"
        label="Portal logo"
        help="THIS is the logo kinfolk see, in the portal header beside the MyTribe wordmark. It is separate from your admin logo, and leaving it empty is fine: the header just shows the wordmark on its own."
        logoUrl={portal.logoUrl}
        logoRemovedAt={portal.logoRemovedAt}
        onChanged={applyLogo}
        preview="portal"
        {...(decode ? { decode } : {})}
      />

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
