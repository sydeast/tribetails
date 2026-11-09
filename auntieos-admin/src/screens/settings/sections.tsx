import { useState } from 'react';
import {
  formatFeeSchedule,
  isPaymentMethodEnabled,
  MAX_PAYMENT_INSTRUCTIONS_LENGTH,
  PAYMENT_METHOD_CATALOGUE,
  PAYMENT_METHOD_FEE_SCHEDULE,
  type BusinessSettings,
  type HomeSectionCfg,
  type MyTribePortalConfig,
  type PaymentMethodRow,
  type PaymentOptionSetting,
  type PortalHome,
  type StringSettingKey,
} from '../../api/settings';
import { DenPanel } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton, IconButton } from '../../components/Buttons';
import { Toggle } from '../../components/Toggle';
import {
  effectiveHomeSections,
  homeLayoutModeLabel,
  homeSectionLabel,
  moveHomeSectionDown,
  moveHomeSectionUp,
  portalHomeSummary,
  RESET_HOME_SECTIONS,
} from '../../lib/settingsFormat';
import { type ImageDecoder } from '../../lib/brandAssetFile';
import { privacyPolicyUrlError } from '../../lib/privacyPolicyUrl';
import { businessNameError } from '../../lib/businessName';
import {
  businessEmailError,
  businessPhoneError,
  cashappHandleError,
  PORTAL_LIMIT_INVALID,
  parsePortalLimit,
  paypalHandleError,
  PORTAL_THEMES,
  splitSettingsRefusal,
  themeError,
  venmoHandleError,
} from '../../lib/settingsChecks';
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
 * Every section saves through the shared `persist` the shell hands down as
 * `onSave`, which calls the `saveBusinessSettings` callable
 * (`api/settingsWrite.ts`, #1593). The server checks every field with the
 * rules in `lib/settingsChecks.ts`; each section runs the same checks first
 * and shows the sentence beside the field, and a refusal the server still
 * sends is shown beside its field when the section draws it
 * (`splitSettingsRefusal`), else in the section's banner.
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
  | 'privacyPolicyUrl'
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
  type?: 'text' | 'email' | 'tel' | 'url';
  /** Small caption under the input. PR30: the Payments fields use it for the processor's fee schedule. */
  hint?: string;
  /**
   * #1409: the field may not be saved blank. Marks the label (a stylesheet
   * asterisk, so the control's accessible name stays the label's own words)
   * and sets `aria-required`. The refusal itself comes from `validate`.
   */
  required?: boolean;
  /**
   * #1410: what to say beside the field for a value that must not be saved, or
   * null when it may be. Run on the live value; a field with a message keeps
   * the panel's Save disabled, so the operator sees the refusal where she is
   * typing instead of as a rules error after the click.
   */
  validate?: (value: string) => string | null;
  /**
   * #1564: a warning beside the field for a value that may be saved but leaves
   * something not working, or null. Never blocks Save.
   */
  notice?: (value: string) => string | null;
}

/**
 * The message for every field whose current value its `validate` refuses,
 * keyed by field. Empty when the panel may save. Shared by the two renderers
 * of a field list (`TextFieldsSection`, `BusinessProfileSection`) so the gate
 * and the text beside the field cannot drift between the Account and Settings
 * copies of the same panel.
 */
export function textFieldErrors(
  fields: readonly TextFieldSpec[],
  values: Record<string, string>,
): Partial<Record<StringFieldKey, string>> {
  const errors: Partial<Record<StringFieldKey, string>> = {};
  for (const f of fields) {
    const message = f.validate?.(values[f.key] ?? '') ?? null;
    if (message !== null) errors[f.key] = message;
  }
  return errors;
}

/**
 * Fields the server checks on every save, edited or not. `saveBusinessSettings`
 * refuses any save that would leave the business with no name, so a stored blank
 * name blocks a save from any panel until it is filled in.
 */
const CHECKED_ON_EVERY_SAVE: readonly string[] = ['businessName'];
/**
 * #1783: the refusals that stop a Save. A stored bad value shows its sentence
 * beside its field as soon as the screen opens (that is `errors`, over every
 * field), but it blocks Save only when its field is part of the save, which is
 * what `saveBusinessSettings` does: it checks only the fields in `changes`,
 * plus the business name (above).
 */
export function blockingErrors<K extends string>(
  errors: Partial<Record<K, string>>,
  edited: readonly string[],
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const key of Object.keys(errors) as K[]) {
    if (edited.includes(key) || CHECKED_ON_EVERY_SAVE.includes(key)) out[key] = errors[key] as string;
  }
  return out;
}

/**
 * #1564. Operator ruling, 2026-11-05 docket: every business email goes to the
 * business contact email, and while it is blank each one is skipped. Shown
 * beside the field so the operator learns it here, not from a missing email.
 */
export function businessEmailNotice(value: string): string | null {
  return value.trim() === ''
    ? 'Business emails have nowhere to go until this is filled. Every business notification email goes to this address.'
    : null;
}

/** The warning line under a field, when its `notice` has one for the value. */
export function FieldNotice({ spec, value }: { spec: TextFieldSpec; value: string }) {
  const message = spec.notice?.(value) ?? null;
  if (message === null) return null;
  return (
    <span id={`${spec.key}-notice`} className="settingsEdit__hint settingsEdit__hint--warn" role="status">
      {message}
    </span>
  );
}
/**
 * #1593: the ARIA a field carries for the refusal line under it. `id` is the
 * field's base id: the line is `${id}-error`, and a hint, when the field has
 * one, keeps its place first in the description.
 */
export function fieldErrorAttrs(
  id: string,
  message: string | null | undefined,
  hintId?: string,
): { 'aria-describedby'?: string; 'aria-invalid'?: true; 'aria-errormessage'?: string } {
  const invalid = message !== null && message !== undefined;
  const describedBy = [hintId, invalid ? `${id}-error` : undefined].filter((x) => x !== undefined).join(' ');
  return {
    ...(describedBy !== '' ? { 'aria-describedby': describedBy } : {}),
    ...(invalid ? { 'aria-invalid': true as const, 'aria-errormessage': `${id}-error` } : {}),
  };
}

/** #1593: the refusal line under any field, by the field's base id (see `fieldErrorAttrs`). */
export function FieldError({ id, message }: { id: string; message: string | null | undefined }) {
  if (message === null || message === undefined) return null;
  return (
    <span id={`${id}-error`} className="settingsEdit__fieldError" role="alert">
      {message}
    </span>
  );
}

/** The refusal line under a field, when `textFieldErrors` has one for it. */
export function FieldErrorNote({ fieldKey, message }: { fieldKey: StringFieldKey; message: string | undefined }) {
  return <FieldError id={fieldKey} message={message} />;
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
  // #1409: required (ruling 2026-11-01 on #1369). A blank name keeps Save off
  // and says "Enter the business name." beside the field, on open too when the
  // stored value is blank; `firestore.rules` refuses the write regardless.
  { key: 'businessName', label: 'Business name', required: true, validate: businessNameError },
  // #1564: every business email goes here; blank means they go nowhere.
  // #1593: blank may be saved (the notice says what that costs); anything else
  // has to read as an address, the server's own check.
  { key: 'businessEmail', label: 'Email', type: 'email', validate: businessEmailError, notice: businessEmailNotice },
  { key: 'businessPhone', label: 'Phone', type: 'tel', validate: businessPhoneError },
  { key: 'businessAddress', label: 'Address' },
  // #1410: blank until the operator publishes a policy; the email footer and
  // the portal About screen omit the link while it is blank. No hint, by the
  // 2026-09-11 subtitle ruling: the label and the placeholder carry it.
  { key: 'privacyPolicyUrl', label: 'Privacy policy link', type: 'url', placeholder: 'https://', validate: privacyPolicyUrlError },
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
  { key: 'paypalHandle', label: 'PayPal', placeholder: 'tribetails', hint: `PayPal charges about ${formatFeeSchedule(PAYMENT_METHOD_FEE_SCHEDULE.paypal)} per payment.` },
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
  // #1593: a server refusal for one of these fields, shown beside it until
  // that field is edited again.
  const [serverErrors, setServerErrors] = useState<Partial<Record<string, string>>>({});

  const editedKeys = fields.filter((f) => (values[f.key] ?? '') !== data[f.key]).map((f) => f.key);
  const dirty = editedKeys.length > 0;
  const fieldErrors = textFieldErrors(fields, values);
  // #1783: only an edited field blocks Save; a stored bad one just shows.
  const invalid = Object.keys(blockingErrors(fieldErrors, editedKeys)).length > 0;

  function update(key: StringFieldKey, next: string) {
    setValues((v) => ({ ...v, [key]: next }));
    setServerErrors((e) => ({ ...e, [key]: undefined }));
    setJustSaved(false);
  }

  async function handleSave() {
    if (!dirty || busy || invalid) return;
    setBusy(true);
    setError(null);
    setServerErrors({});
    const patch: Partial<Pick<BusinessSettings, StringFieldKey>> = {};
    for (const key of editedKeys) patch[key] = (values[key] ?? '').trim();
    try {
      await onSave(patch);
      setJustSaved(true);
    } catch (err) {
      const split = splitSettingsRefusal(err, fields.map((f) => f.key));
      setServerErrors(split.byField);
      setError(split.banner);
    } finally {
      setBusy(false);
    }
  }

  function handleCancel() {
    const seed: Record<string, string> = {};
    for (const f of fields) seed[f.key] = data[f.key];
    setValues(seed);
    setServerErrors({});
    setError(null);
    setJustSaved(false);
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
              <span className={f.required ? 'settingsEdit__fieldLabel settingsEdit__fieldLabel--required' : 'settingsEdit__fieldLabel'}>
                {f.label}
              </span>
              <input
                type={f.type ?? 'text'}
                className="settingsEdit__input"
                value={values[f.key] ?? ''}
                {...(f.placeholder !== undefined ? { placeholder: f.placeholder } : {})}
                disabled={busy}
                onChange={(e) => update(f.key, e.target.value)}
                {...(f.required ? { 'aria-required': true } : {})}
                {...fieldErrorAttrs(
                  f.key,
                  fieldErrors[f.key] ?? serverErrors[f.key],
                  f.hint ? `${f.key}-hint` : undefined,
                )}
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
            <FieldErrorNote fieldKey={f.key} message={fieldErrors[f.key] ?? serverErrors[f.key]} />
            <FieldNotice spec={f} value={values[f.key] ?? ''} />
          </div>
        ))}
      </div>
      <div className="settingsEdit__saveRow">
        <GhostButton label="Cancel" onClick={handleCancel} disabled={!dirty || busy} />
        <PrimaryButton
          label={busy ? 'Saving…' : 'Save'}
          onClick={() => void handleSave()}
          disabled={!dirty || busy || invalid}
          busy={busy}
        />
        {justSaved && !dirty ? <span className="settingsEdit__savedNote">Saved</span> : null}
      </div>
    </DenPanel>
  );
}

// ── Scheduling (the booking toggles) ─────────────────────────────────────────────────────────

type BookingToggleKey =
  | 'autoConfirmRepeatKinfolk'
  | 'snapRescheduleTo15Min'
  | 'enableConflictDetection';

interface BookingBehaviorSectionProps {
  data: BusinessSettings;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}

/**
 * Three instant-save toggles, no separate Save button, matching the wasm
 * `BookingBehaviorPanel`'s `AuntieToggle(checked = s?.field == true, onCheckedChange
 * = { vm.saveSettings(s.copy(field = next)) })`: the switch reads straight off the
 * loaded doc and saves on every flip, rather than staging a draft. `data` (not a
 * local optimistic copy) drives `checked`, so a failed save leaves the switch
 * exactly where it was (the fail-loud error banner explains why) instead of
 * showing a flip that never actually persisted.
 *
 * "Block bookings during busy events" (#517) is the one whose default is ON:
 * it writes `enableConflictDetection`, which
 * `mytribe/functions/src/lib/bookingBusyConflict.ts` reads before every booking
 * write, so turning it off really does let a visit land on a Google-imported
 * busy block. It reads `!== false` rather than `=== true` for the same reason
 * the server does: a settings doc written before the field existed must decode
 * as ON, not as an open gate.
 *
 * THE MOCK'S "SCHEDULING" PANEL (issue #755 pass). The settings mock draws
 * these three switches as its `.trow` rows under the title "Scheduling", in
 * this order, each with a one-line note under the bold label; the title, the
 * order and the notes are the mock's. The mock's fourth row, "Sync Google
 * Calendar busy events", is not here: that switch is the free/busy import,
 * which lives with the Calendar panels under Integrations (#715). The panel
 * itself still sits under Business profile (walk 2026-08-17, mark 16), which
 * the mock's nav predates.
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
      title="Scheduling"
      subtitle="How new bookings are confirmed and adjusted. Each switch saves the moment it is flipped."
    >
      {error ? (
        <Banner tone="error" title="Save failed" className="settingsEdit__sectionBanner">
          {error}
        </Banner>
      ) : null}
      <ul className="settingsEdit__toggleList settingsEdit__toggleList--ruled">
        <li className="settingsEdit__toggleRow settingsEdit__toggleRow--ruled">
          <span className="settingsEdit__toggleText">
            <span className="settingsEdit__toggleLabel">Block bookings during busy events</span>
            <span className="settingsEdit__toggleNote">
              Stop new visits from landing on top of a Google Calendar block.
            </span>
          </span>
          <Toggle
            label="Toggle block bookings during busy events"
            checked={data.enableConflictDetection !== false}
            disabled={savingKey !== null}
            onChange={(next) => void toggle('enableConflictDetection', next)}
          />
        </li>
        <li className="settingsEdit__toggleRow settingsEdit__toggleRow--ruled">
          <span className="settingsEdit__toggleText">
            <span className="settingsEdit__toggleLabel">Snap drag-to-reschedule to 15 min</span>
            <span className="settingsEdit__toggleNote">Visits align to quarter-hour slots when dragged.</span>
          </span>
          <Toggle
            label="Toggle snap drag-to-reschedule to 15 min"
            checked={data.snapRescheduleTo15Min}
            disabled={savingKey !== null}
            onChange={(next) => void toggle('snapRescheduleTo15Min', next)}
          />
        </li>
        <li className="settingsEdit__toggleRow settingsEdit__toggleRow--ruled">
          <span className="settingsEdit__toggleText">
            <span className="settingsEdit__toggleLabel">Auto-confirm repeat kinfolk</span>
            <span className="settingsEdit__toggleNote">Trusted kinfolk bookings skip manual approval.</span>
          </span>
          <Toggle
            label="Toggle auto-confirm repeat kinfolk"
            checked={data.autoConfirmRepeatKinfolk}
            disabled={savingKey !== null}
            onChange={(next) => void toggle('autoConfirmRepeatKinfolk', next)}
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

/** #1593: each handle's check, the same one `saveBusinessSettings` runs. */
const HANDLE_CHECKS: Record<StringSettingKey, (raw: string) => string | null> = {
  venmoHandle: venmoHandleError,
  paypalHandle: paypalHandleError,
  cashappHandle: cashappHandleError,
};
const HANDLE_FIELDS: readonly string[] = Object.keys(HANDLE_CHECKS);

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
 * ONE SAVE BUTTON, not per-flip saves like the Scheduling toggles. A toggle and the
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
  const [serverErrors, setServerErrors] = useState<Partial<Record<string, string>>>({});

  const saved = seedDraft(data);
  const optionsDirty = PAYMENT_METHOD_CATALOGUE.some(
    (m) =>
      draft.options[m.id]?.enabled !== saved.options[m.id]?.enabled ||
      (draft.options[m.id]?.instructions ?? '').trim() !== (saved.options[m.id]?.instructions ?? '').trim(),
  );
  const editedHandles = Object.keys(saved.handles).filter(
    (field) => (draft.handles[field] ?? '').trim() !== (saved.handles[field] ?? '').trim(),
  );
  const dirty = optionsDirty || editedHandles.length > 0;

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
    setServerErrors((e) => ({ ...e, [field]: undefined }));
    setJustSaved(false);
  }

  // #1593: each handle's own check, the server's. Run whether or not the
  // method is on, because every handle is saved either way; the row shows the
  // sentence even while its box is hidden (see `PaymentOptionRow`).
  const handleErrors: Partial<Record<string, string>> = {};
  for (const method of PAYMENT_METHOD_CATALOGUE) {
    if (!method.handleField) continue;
    const message = HANDLE_CHECKS[method.handleField](draft.handles[method.handleField] ?? '');
    if (message !== null) handleErrors[method.handleField] = message;
  }
  // #1783: a stored bad handle shows its sentence but blocks Save only once it
  // is edited: the server checks only the handles in the save.
  const invalid = Object.keys(blockingErrors(handleErrors, editedHandles)).length > 0;

  async function handleSave() {
    if (!dirty || busy || invalid) return;
    setBusy(true);
    setError(null);
    setServerErrors({});
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
      // invoice PDF and the portal both still read it from there. #1783: only a
      // handle the operator edited travels.
      if (method.handleField && editedHandles.includes(method.handleField)) {
        patch[method.handleField] = (draft.handles[method.handleField] ?? '').trim();
      }
    }
    if (optionsDirty) patch.paymentOptions = options;
    try {
      await onSave(patch);
      setJustSaved(true);
    } catch (err) {
      const split = splitSettingsRefusal(err, HANDLE_FIELDS);
      setServerErrors(split.byField);
      setError(split.banner);
    } finally {
      setBusy(false);
    }
  }

  function handleCancel() {
    setDraft(seedDraft(data));
    setServerErrors({});
    setError(null);
    setJustSaved(false);
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
            handleError={method.handleField ? handleErrors[method.handleField] ?? serverErrors[method.handleField] : undefined}
            handleChanged={
              method.handleField !== undefined &&
              (draft.handles[method.handleField] ?? '').trim() !== (saved.handles[method.handleField] ?? '').trim()
            }
            onEnabledChange={(next) => setEnabled(method.id, next)}
            onHandleChange={(next) => method.handleField && setHandle(method.handleField, next)}
            onInstructionsChange={(next) => setInstructions(method.id, next)}
          />
        ))}
      </ul>
      <div className="settingsEdit__saveRow">
        <GhostButton label="Cancel" onClick={handleCancel} disabled={!dirty || busy} />
        <PrimaryButton
          label={busy ? 'Saving…' : 'Save payment options'}
          onClick={() => void handleSave()}
          disabled={!dirty || busy || invalid}
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
  /** #1593: why the handle cannot be saved, or undefined. */
  handleError?: string | undefined;
  /** The handle differs from the saved one. */
  handleChanged?: boolean;
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
  handleError,
  handleChanged = false,
  onEnabledChange,
  onHandleChange,
  onInstructionsChange,
}: PaymentOptionRowProps) {
  const needsHandle = method.kind === 'link';
  // A refused or edited handle keeps its box open even while the method is
  // off: the handle is saved either way, and a refusal needs a box to fix it
  // in (one that does not vanish mid-word the moment the value passes).
  const showHandle =
    needsHandle && method.handleField !== undefined && (enabled || handleError !== undefined || handleChanged);
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
      {showHandle && method.handleField ? (
        <>
          <label className="settingsEdit__field">
            <span className="settingsEdit__fieldLabel">{method.label} handle</span>
            <input
              type="text"
              className="settingsEdit__input"
              value={handle}
              placeholder={PAYMENT_FIELDS.find((f) => f.key === method.handleField)?.placeholder ?? ''}
              disabled={busy}
              onChange={(e) => onHandleChange(e.target.value)}
              {...fieldErrorAttrs(method.handleField, handleError)}
            />
          </label>
          <FieldError id={method.handleField} message={handleError} />
        </>
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

// ── MyTribe portal (theme id, banner, chat, Home layout) ────────────────────

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
 * it deep-merges the nested map.
 *
 * ISSUE #397 M10: the Home layout is a REAL editor now (`HomeLayoutEditor`
 * below), reordering and editing `portal.home.sections` through this same
 * `edit()` — it is one more field on `portal`, not a second save path. Order
 * IS the array order (see `HomeSectionCfg`), so a reorder is written as a
 * reordered array, nothing more exotic.
 */
export function MyTribePortalSection({ data, onSave, onServerChanged, decode }: MyTribePortalSectionProps) {
  const [portal, setPortal] = useState<MyTribePortalConfig>(() => data.mytribePortal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  // #1593: each home section's Limit box exactly as typed, keyed by row. A
  // value that parses goes into `portal`; one that does not stays here with
  // its sentence beside the box, never coerced to a number nobody typed.
  const [limitText, setLimitText] = useState<Record<string, string>>({});

  const dirty = JSON.stringify(portal) !== JSON.stringify(data.mytribePortal);
  // #1783: the parts of the portal config the operator changed. Only those
  // travel, and only those can block Save: the server merges the portal key by
  // key and checks the keys it is sent. `home` is an array, so it is checked and
  // written whole when any row changes.
  const changedParts = (Object.keys(portal) as Array<keyof MyTribePortalConfig>).filter(
    (k) => JSON.stringify(portal[k]) !== JSON.stringify(data.mytribePortal[k]),
  );
  const typedLimitErrors: Record<string, string> = {};
  for (const [key, text] of Object.entries(limitText)) {
    const parsed = parsePortalLimit(text);
    if ('error' in parsed) typedLimitErrors[key] = parsed.error;
  }
  // A stored limit the portal cannot use shows its sentence on open, in the
  // box that holds it.
  const storedLimitErrors: Record<string, string> = {};
  effectiveHomeSections(portal.home.sections).forEach((row, index) => {
    const key = homeRowKey(row, index);
    if (limitText[key] === undefined && !(Number.isInteger(row.limit) && row.limit >= 0)) {
      storedLimitErrors[key] = PORTAL_LIMIT_INVALID;
    }
  });
  const limitErrors: Record<string, string> = { ...storedLimitErrors, ...typedLimitErrors };
  const themeProblem = themeError(portal.themeId);
  const invalid =
    Object.keys(typedLimitErrors).length > 0 ||
    (changedParts.includes('home') && Object.keys(storedLimitErrors).length > 0) ||
    (changedParts.includes('themeId') && themeProblem !== null);
  function edit(next: MyTribePortalConfig) {
    setPortal(next);
    setJustSaved(false);
  }

  function editLimitText(key: string, text: string) {
    setLimitText((t) => ({ ...t, [key]: text }));
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
    if (!dirty || busy || invalid) return;
    setBusy(true);
    setError(null);
    try {
      const sent: Partial<MyTribePortalConfig> = {};
      for (const k of changedParts) (sent as Record<string, unknown>)[k] = portal[k];
      await onSave({ mytribePortal: sent as MyTribePortalConfig });
      setLimitText({});
      setJustSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  function handleCancel() {
    setPortal(data.mytribePortal);
    setLimitText({});
    setError(null);
    setJustSaved(false);
  }

  // A stored theme the list does not know stays selectable under its raw id,
  // so the box shows what is saved, with the refusal beside it.
  const themeOptions = PORTAL_THEMES.some((t) => t.id === portal.themeId)
    ? PORTAL_THEMES
    : [...PORTAL_THEMES, { id: portal.themeId, label: portal.themeId === '' ? 'Not set' : portal.themeId }];

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

      <div className="settingsEdit__fieldGroup">
        <label className="settingsEdit__field">
          <span className="settingsEdit__fieldLabel">Theme</span>
          <select
            className="settingsEdit__input"
            value={portal.themeId}
            disabled={busy}
            onChange={(e) => edit({ ...portal, themeId: e.target.value })}
            {...fieldErrorAttrs('portalTheme', themeProblem)}
          >
            {themeOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <FieldError id="portalTheme" message={themeProblem} />
      </div>

      <div className="settingsEdit__subsection">
        <span className="settingsEdit__groupHeading">Top banner</span>
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
        <span className="settingsEdit__groupHeading">Message Auntie chat</span>
        <div className="settingsEdit__toggleRow">
          <span className="settingsEdit__toggleLabel">Show Message Auntie chat</span>
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
        <span className="settingsEdit__groupHeading">Home layout</span>
        <p className="settingsEdit__readonlyValue">{portalHomeSummary(portal.home)}</p>
        <HomeLayoutEditor
          home={portal.home}
          busy={busy}
          limitText={limitText}
          limitErrors={limitErrors}
          onLimitText={editLimitText}
          onChange={(home) => edit({ ...portal, home })}
          onReset={() => {
            setLimitText({});
            edit({ ...portal, home: { sections: [...RESET_HOME_SECTIONS] } });
          }}
        />
        <p className="settingsEdit__hint">
          Use the arrows to reorder. Turning a section off removes it from the kinfolk portal&rsquo;s
          Home screen; the limit caps how many items it lists there, and 0 means unlimited.
        </p>
      </div>

      <div className="settingsEdit__saveRow">
        <GhostButton
          label="Cancel"
          onClick={handleCancel}
          disabled={(!dirty && Object.keys(limitText).length === 0) || busy}
        />
        <PrimaryButton
          label={busy ? 'Saving…' : 'Save'}
          onClick={() => void handleSave()}
          disabled={!dirty || busy || invalid}
          busy={busy}
        />
        {justSaved && !dirty ? <span className="settingsEdit__savedNote">Saved</span> : null}
      </div>
    </DenPanel>
  );
}

interface HomeLayoutEditorProps {
  home: PortalHome;
  busy: boolean;
  /** #1593: the Limit boxes as typed, by row key; a row not here shows its stored limit. */
  limitText: Record<string, string>;
  limitErrors: Record<string, string>;
  onLimitText: (key: string, text: string) => void;
  onChange: (home: PortalHome) => void;
  onReset: () => void;
}

/** A home row's key, the same one its list item uses. */
function homeRowKey(row: HomeSectionCfg, index: number): string {
  return row.id ?? `unnamed-${index}`;
}

/**
 * ISSUE #397 M10: the Home layout editor. Reorder (up/down, no drag-and-drop
 * library), show/hide, and per-section limit, over `effectiveHomeSections` —
 * which materializes the implicit "empty = canonical order, everything on"
 * default into real DISPLAY rows so there is always something on screen to
 * edit, and appends any catalogue section a partial saved array had dropped,
 * disabled, so it stays reachable. `effectiveHomeSections` is read-only here:
 * it never becomes the value written back, only what each row shows.
 *
 * ONE-WAY-DOOR GUARD. A real edit (toggle/limit/reorder) writes the WHOLE
 * materialized row list back through `onChange`, converting the implicit
 * default into an explicit array the moment an operator touches anything —
 * never merely by opening the panel, so opening and pressing Save with
 * nothing touched stays a no-op for `dirty` (see `MyTribePortalSection`, which
 * compares `JSON.stringify(portal)` against the loaded value untouched: `home`
 * is only ever replaced by an `onChange` call, and none of the row handlers
 * below fire on render). "Reset to default layout" is the way back out of
 * that explicit state: it writes `RESET_HOME_SECTIONS` (`[]`), the same empty
 * array the portal reads as "no config at all", not a full canonical list that
 * merely looks the same today.
 */
function HomeLayoutEditor({ home, busy, limitText, limitErrors, onLimitText, onChange, onReset }: HomeLayoutEditorProps) {
  const rows = effectiveHomeSections(home.sections);
  const isDefault = home.sections.length === 0;

  function updateRow(index: number, patch: Partial<HomeSectionCfg>) {
    onChange({ sections: rows.map((r, i) => (i === index ? { ...r, ...patch } : r)) });
  }

  return (
    <>
      <div className="settingsEdit__homeModeRow">
        <span
          className={[
            'settingsEdit__homeModeBadge',
            isDefault ? 'settingsEdit__homeModeBadge--default' : 'settingsEdit__homeModeBadge--custom',
          ].join(' ')}
        >
          {homeLayoutModeLabel(home)}
        </span>
        <GhostButton
          label="Reset to default layout"
          onClick={onReset}
          disabled={busy || isDefault}
        />
      </div>
      <ul className="settingsEdit__homeList">
        {rows.map((row, index) => {
          const label = homeSectionLabel(row.id);
          const key = homeRowKey(row, index);
          const limitId = `homeLimit-${key}`;
          return (
            <li key={key} className="settingsEdit__homeRow">
              <div className="settingsEdit__homeMove">
                <IconButton
                  icon={<UpGlyph />}
                  label={`Move ${label} up`}
                  onClick={() => onChange({ sections: moveHomeSectionUp(rows, index) })}
                  disabled={busy || index === 0}
                  size={28}
                />
                <IconButton
                  icon={<DownGlyph />}
                  label={`Move ${label} down`}
                  onClick={() => onChange({ sections: moveHomeSectionDown(rows, index) })}
                  disabled={busy || index === rows.length - 1}
                  size={28}
                />
              </div>
              <span className="settingsEdit__homeRowLabel">{label}</span>
              <Toggle
                label={`Show ${label} on Home`}
                checked={row.enabled}
                disabled={busy}
                onChange={(next) => updateRow(index, { enabled: next })}
              />
              {/* #1593: text, not type="number", so "abc" or "-3" stays in the
                  box with its sentence instead of being read as 0. */}
              <label className="settingsEdit__homeLimit">
                <span className="settingsEdit__fieldLabel">Limit</span>
                <input
                  type="text"
                  inputMode="numeric"
                  className="settingsEdit__input settingsEdit__input--narrow"
                  value={limitText[key] ?? String(row.limit)}
                  disabled={busy}
                  onChange={(e) => {
                    onLimitText(key, e.target.value);
                    const parsed = parsePortalLimit(e.target.value);
                    if ('value' in parsed) updateRow(index, { limit: parsed.value });
                  }}
                  {...fieldErrorAttrs(limitId, limitErrors[key])}
                />
              </label>
              <FieldError id={limitId} message={limitErrors[key]} />
            </li>
          );
        })}
      </ul>
    </>
  );
}

function UpGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 15l6-6 6 6" />
    </svg>
  );
}

function DownGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

// Google Calendar sync used to live here as a read-only panel whose hint said
// syncing "needs a Google sign-in that isn't wired into this admin yet". That
// was wrong: the free/busy import runs as a service account inside the Cloud
// Function and needs no sign-in from any client. It is now a real editor with a
// Run Sync action, in its own file, `./CalendarSyncSection.tsx`.
