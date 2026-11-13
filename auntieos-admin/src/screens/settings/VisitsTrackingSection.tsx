import { useState } from 'react';
import type { BusinessSettings } from '../../api/settings';
import { DenPanel } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton } from '../../components/Buttons';
import { Toggle } from '../../components/Toggle';
import { splitSettingsRefusal } from '../../lib/settingsChecks';
import {
  NUMBER_FIELDS,
  TRACKING_ACCURACIES,
  clampToOptions,
  formatOptionList,
  optionsIncluding,
  parseOptionList,
  parseWholeNumber,
} from '../../lib/businessOperations';
import { FieldError, fieldErrorAttrs } from './sections';
import '../SettingsEdit.css';

/**
 * ISSUE #519: the GPS / tracking block and the two visit defaults.
 *
 * These eleven fields were editable ONLY on Android, and five of them not even
 * there. Grouped here the way Android's own "Business operations" panel groups
 * them, so an operator moving between a phone and a desk finds one shape.
 *
 * WHAT IS AND IS NOT WIRED, stated on the panel rather than only in this
 * comment, because a switch that changes nothing is the defect this issue is
 * about:
 *
 *  LIVE   `enableGPSTrackingForAllVisits`  the master switch. Android's
 *         `LocationTrackingService` stops itself outright when it is off, and
 *         `HomeViewModel` will not start tracking on arrival.
 *  LIVE   `autoStartTrackingOnVisitStart`  whether arriving at a visit starts
 *         tracking by itself. Wired to `HomeViewModel` in this same change;
 *         before it, tracking always auto-started under the master switch.
 *  LIVE   `trackingAccuracy`               maps to the real `LocationRequest`
 *         priority, so it trades battery against precision for real.
 *  LIVE   `defaultEtaMinutes` + `etaMinuteOptions`  the value and the choices on
 *         the "On My Way" sheet.
 *  LIVE   `kinTaleRequired` (#2123): the Auntie's "Send the KinTale" task on
 *         Auntie Time. Absent reads off; it never blocks completion.
 *  LIVE   `enablePhotoLocationTagging`, `requireArrivalDepartureVerification`,
 *         `saveRoutesForDays`, `allowClientLocationSharing`,
 *         `draftRetentionDays` + `draftRetentionOptions`. These five were
 *         STORED-and-unread when this panel was written; the operator ruled
 *         that a control must turn on a working feature, and all five got
 *         consumers in the same change. The "no behaviour behind them yet"
 *         note that stood here was already false, and both Kotlin panels had
 *         been corrected; this is the third.
 *
 * ISSUE #582 adds `arrivalRadiusMeters` under the arrival switch. It is that
 * switch's THRESHOLD, not a second switch: with verification on, a visit whose
 * arrival was recorded confidently further than this from the household cannot
 * be marked complete. An arrival with no usable location — no fix, offline, a
 * household whose address will not geocode, the desktop console, which has no
 * GPS at all — is allowed through and recorded as unverified, which is why the
 * hint under the field says so rather than promising a check that will not
 * always run.
 */

interface VisitsTrackingSectionProps {
  data: BusinessSettings;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}

interface Draft {
  enableGPSTrackingForAllVisits: boolean;
  autoStartTrackingOnVisitStart: boolean;
  trackingAccuracy: string;
  enablePhotoLocationTagging: boolean;
  requireArrivalDepartureVerification: boolean;
  kinTaleRequired: boolean;
  arrivalRadiusMeters: string;
  allowClientLocationSharing: boolean;
  saveRoutesForDays: string;
  defaultEtaMinutes: number;
  etaMinuteOptions: string;
  draftRetentionDays: number;
  draftRetentionOptions: string;
}

function seed(data: BusinessSettings): Draft {
  return {
    enableGPSTrackingForAllVisits: data.enableGPSTrackingForAllVisits,
    autoStartTrackingOnVisitStart: data.autoStartTrackingOnVisitStart,
    trackingAccuracy: data.trackingAccuracy,
    enablePhotoLocationTagging: data.enablePhotoLocationTagging,
    requireArrivalDepartureVerification: data.requireArrivalDepartureVerification,
    kinTaleRequired: data.kinTaleRequired,
    arrivalRadiusMeters: String(data.arrivalRadiusMeters),
    allowClientLocationSharing: data.allowClientLocationSharing,
    saveRoutesForDays: String(data.saveRoutesForDays),
    defaultEtaMinutes: data.defaultEtaMinutes,
    etaMinuteOptions: formatOptionList(data.etaMinuteOptions),
    draftRetentionDays: data.draftRetentionDays,
    draftRetentionOptions: formatOptionList(data.draftRetentionOptions),
  };
}

/** The settings this panel writes, by the name each one has on the document. */
type VisitsField = keyof Draft;
/**
 * #1783: which fields the operator changed from what is stored. Only these are
 * written and only these can stop a Save: `saveBusinessSettings` checks the
 * fields in the save, so a stored value this panel would refuse (an option list
 * with a repeat, a radius out of range) shows its sentence and leaves a
 * different edit alone.
 */
export function editedVisitsFields(draft: Draft, data: BusinessSettings): ReadonlySet<VisitsField> {
  const out = new Set<VisitsField>();
  const base = seed(data);
  for (const key of [
    'enableGPSTrackingForAllVisits',
    'autoStartTrackingOnVisitStart',
    'trackingAccuracy',
    'enablePhotoLocationTagging',
    'requireArrivalDepartureVerification',
    'kinTaleRequired',
    'allowClientLocationSharing',
    'defaultEtaMinutes',
    'draftRetentionDays',
  ] as const) {
    if (draft[key] !== base[key]) out.add(key);
  }
  for (const key of ['saveRoutesForDays', 'arrivalRadiusMeters'] as const) {
    const parsed = parseWholeNumber(draft[key], NUMBER_FIELDS[key]);
    if ('value' in parsed ? parsed.value !== data[key] : draft[key].trim() !== base[key]) out.add(key);
  }
  const eta = parseOptionList(draft.etaMinuteOptions, 'minutes');
  if ('value' in eta ? !sameNumbers(eta.value, data.etaMinuteOptions) : draft.etaMinuteOptions.trim() !== base.etaMinuteOptions) {
    out.add('etaMinuteOptions');
    // Editing the list can move the selected default onto a remaining option.
    if ('value' in eta && clampToOptions(draft.defaultEtaMinutes, eta.value) !== data.defaultEtaMinutes) {
      out.add('defaultEtaMinutes');
    }
  }
  const drafts = parseOptionList(draft.draftRetentionOptions, 'days');
  if ('value' in drafts ? !sameNumbers(drafts.value, data.draftRetentionOptions) : draft.draftRetentionOptions.trim() !== base.draftRetentionOptions) {
    out.add('draftRetentionOptions');
    if ('value' in drafts && clampToOptions(draft.draftRetentionDays, drafts.value) !== data.draftRetentionDays) {
      out.add('draftRetentionDays');
    }
  }
  return out;
}
/**
 * The patch this draft would write, or the first thing to fix. With [only]
 * (#1783) it checks and writes just those fields; without it, all of them.
 *
 * The two defaults are CLAMPED to their own option lists rather than refused:
 * deleting the entry that happens to be selected is a normal edit, and stopping
 * the save on it would mean the operator has to fix a field they were not
 * editing. `clampToOptions` moves to the nearest remaining option, ties going
 * to the shorter wait.
 */
export function visitsTrackingPatch(
  draft: Draft,
  only?: ReadonlySet<VisitsField>,
): { patch: Partial<BusinessSettings> } | { error: string } {
  const has = (field: VisitsField) => only === undefined || only.has(field);
  const patch: Partial<BusinessSettings> = {};
  if (has('saveRoutesForDays')) {
    const routeDays = parseWholeNumber(draft.saveRoutesForDays, NUMBER_FIELDS.saveRoutesForDays);
    if ('error' in routeDays) return { error: `Keep routes for: ${routeDays.error}` };
    patch.saveRoutesForDays = routeDays.value;
  }
  // #582. Validated even while the switch above is off, because the value is
  // still saved and would otherwise become an unfixable problem the first time
  // somebody turns verification on.
  if (has('arrivalRadiusMeters')) {
    const radius = parseWholeNumber(draft.arrivalRadiusMeters, NUMBER_FIELDS.arrivalRadiusMeters);
    if ('error' in radius) return { error: `Arrival must be within: ${radius.error}` };
    patch.arrivalRadiusMeters = radius.value;
  }
  // The default is clamped against the list, so a list edit needs the list parsed
  // whether or not the list itself is in the save.
  const eta = parseOptionList(draft.etaMinuteOptions, 'minutes');
  if (has('etaMinuteOptions') || has('defaultEtaMinutes')) {
    if ('error' in eta) return { error: `On-my-way choices: ${eta.error}` };
    if (has('etaMinuteOptions')) patch.etaMinuteOptions = eta.value;
    if (has('defaultEtaMinutes')) patch.defaultEtaMinutes = clampToOptions(draft.defaultEtaMinutes, eta.value);
  }
  const drafts = parseOptionList(draft.draftRetentionOptions, 'days');
  if (has('draftRetentionOptions') || has('draftRetentionDays')) {
    if ('error' in drafts) return { error: `Draft-retention choices: ${drafts.error}` };
    if (has('draftRetentionOptions')) patch.draftRetentionOptions = drafts.value;
    if (has('draftRetentionDays')) patch.draftRetentionDays = clampToOptions(draft.draftRetentionDays, drafts.value);
  }
  if (has('enableGPSTrackingForAllVisits')) patch.enableGPSTrackingForAllVisits = draft.enableGPSTrackingForAllVisits;
  if (has('autoStartTrackingOnVisitStart')) patch.autoStartTrackingOnVisitStart = draft.autoStartTrackingOnVisitStart;
  if (has('trackingAccuracy')) patch.trackingAccuracy = draft.trackingAccuracy;
  if (has('enablePhotoLocationTagging')) patch.enablePhotoLocationTagging = draft.enablePhotoLocationTagging;
  if (has('kinTaleRequired')) patch.kinTaleRequired = draft.kinTaleRequired;
  if (has('requireArrivalDepartureVerification')) {
    patch.requireArrivalDepartureVerification = draft.requireArrivalDepartureVerification;
  }
  if (has('allowClientLocationSharing')) patch.allowClientLocationSharing = draft.allowClientLocationSharing;
  return { patch };
}
/** The four typed fields of this panel, by the setting each one writes. */
type TypedField = 'saveRoutesForDays' | 'arrivalRadiusMeters' | 'etaMinuteOptions' | 'draftRetentionOptions';

/**
 * #1593: what is wrong with each typed field, keyed by the setting it writes,
 * for the line under that field. The same parsers `visitsTrackingPatch` runs,
 * without the field-name lead its single message needs: here the field's own
 * label already says which one it is.
 */
export function visitsTrackingFieldErrors(draft: Draft): Partial<Record<TypedField, string>> {
  const out: Partial<Record<TypedField, string>> = {};
  const routeDays = parseWholeNumber(draft.saveRoutesForDays, NUMBER_FIELDS.saveRoutesForDays);
  if ('error' in routeDays) out.saveRoutesForDays = routeDays.error;
  const radius = parseWholeNumber(draft.arrivalRadiusMeters, NUMBER_FIELDS.arrivalRadiusMeters);
  if ('error' in radius) out.arrivalRadiusMeters = radius.error;
  const eta = parseOptionList(draft.etaMinuteOptions, 'minutes');
  if ('error' in eta) out.etaMinuteOptions = eta.error;
  const drafts = parseOptionList(draft.draftRetentionOptions, 'days');
  if ('error' in drafts) out.draftRetentionOptions = drafts.error;
  return out;
}

const TYPED_FIELDS: readonly string[] = ['saveRoutesForDays', 'arrivalRadiusMeters', 'etaMinuteOptions', 'draftRetentionOptions'];

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

export function VisitsTrackingSection({ data, onSave }: VisitsTrackingSectionProps) {
  const [draft, setDraft] = useState<Draft>(() => seed(data));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  // #1593: a server refusal for one of the typed fields, under that field
  // until it is edited again.
  const [serverErrors, setServerErrors] = useState<Partial<Record<string, string>>>({});

  const edited = editedVisitsFields(draft, data);
  const built = visitsTrackingPatch(draft, edited);
  const problem = 'error' in built ? built.error : null;
  const dirty = edited.size > 0;
  const typed = visitsTrackingFieldErrors(draft);
  const fieldError = (key: TypedField): string | undefined => typed[key] ?? serverErrors[key];
  const tracking = draft.enableGPSTrackingForAllVisits;

  // The two dropdowns offer whatever the operator has typed into the list beside
  // them, so editing the list and re-picking the default are one continuous act
  // rather than a save-and-reopen.
  const etaOptions = parseOptionList(draft.etaMinuteOptions, 'minutes');
  const draftOptions = parseOptionList(draft.draftRetentionOptions, 'days');

  function edit(next: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...next }));
    setServerErrors((e) => {
      const kept = { ...e };
      for (const key of Object.keys(next)) delete kept[key];
      return kept;
    });
    setJustSaved(false);
  }

  async function handleSave() {
    if (!dirty || busy || 'error' in built) return;
    setBusy(true);
    setError(null);
    setServerErrors({});
    try {
      await onSave(built.patch);
      setJustSaved(true);
    } catch (err) {
      const split = splitSettingsRefusal(err, TYPED_FIELDS);
      setServerErrors(split.byField);
      setError(split.banner);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DenPanel
      title="Visits and tracking"
      subtitle="GPS while you are out on a visit, and the defaults the visit card starts with."
    >
      {error ? (
        <Banner tone="error" title="Save failed" className="settingsEdit__sectionBanner">
          {error}
        </Banner>
      ) : null}
      <ul className="settingsEdit__toggleList">
        <li className="settingsEdit__toggleRow">
          <span className="settingsEdit__toggleLabel">Track visits by GPS</span>
          <Toggle
            label="Toggle GPS tracking for all visits"
            checked={tracking}
            disabled={busy}
            onChange={(next) => edit({ enableGPSTrackingForAllVisits: next })}
          />
        </li>
        <li className="settingsEdit__toggleRow">
          <span className="settingsEdit__toggleLabel">Start tracking when a visit starts</span>
          <Toggle
            label="Toggle auto-start tracking on visit start"
            checked={draft.autoStartTrackingOnVisitStart}
            disabled={busy || !tracking}
            onChange={(next) => edit({ autoStartTrackingOnVisitStart: next })}
          />
        </li>
      </ul>
      {!tracking ? (
        <p className="settingsEdit__hint">
          GPS is off, so nothing below it runs. The tracking service stops itself on the phone.
        </p>
      ) : null}

      <div className="settingsEdit__fields">
        <div className="settingsEdit__fieldGroup">
          <label className="settingsEdit__field">
            <span className="settingsEdit__fieldLabel">Tracking accuracy</span>
            <select
              className="settingsEdit__input"
              value={draft.trackingAccuracy}
              disabled={busy || !tracking}
              onChange={(e) => edit({ trackingAccuracy: e.target.value })}
            >
              {optionsIncluding(TRACKING_ACCURACIES, draft.trackingAccuracy).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="settingsEdit__subsection">
        <span className="settingsEdit__fieldLabel">On My Way</span>
        <div className="settingsEdit__fields">
          <div className="settingsEdit__fieldGroup">
            <label className="settingsEdit__field">
              <span className="settingsEdit__fieldLabel">Default ETA</span>
              <select
                className="settingsEdit__input"
                value={String(draft.defaultEtaMinutes)}
                disabled={busy}
                onChange={(e) => edit({ defaultEtaMinutes: Number(e.target.value) })}
              >
                {('value' in etaOptions ? etaOptions.value : [draft.defaultEtaMinutes]).map((n) => (
                  <option key={n} value={String(n)}>
                    {n} min
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="settingsEdit__fieldGroup">
            <label className="settingsEdit__field">
              <span className="settingsEdit__fieldLabel">Choices offered (minutes)</span>
              <input
                type="text"
                className="settingsEdit__input"
                value={draft.etaMinuteOptions}
                placeholder="5, 10, 15, 20, 30"
                disabled={busy}
                onChange={(e) => edit({ etaMinuteOptions: e.target.value })}
                {...fieldErrorAttrs('etaOptions', fieldError('etaMinuteOptions'), 'etaOptions-hint')}
              />
            </label>
            <span id="etaOptions-hint" className="settingsEdit__hint">
              Separate with commas. These are the waits the On My Way sheet offers.
            </span>
            <FieldError id="etaOptions" message={fieldError('etaMinuteOptions')} />
          </div>
        </div>
      </div>

      <div className="settingsEdit__subsection">
        <span className="settingsEdit__fieldLabel">Unsent KinTale drafts</span>
        <div className="settingsEdit__fields">
          <div className="settingsEdit__fieldGroup">
            <label className="settingsEdit__field">
              <span className="settingsEdit__fieldLabel">Keep drafts for</span>
              <select
                className="settingsEdit__input"
                value={String(draft.draftRetentionDays)}
                disabled={busy}
                onChange={(e) => edit({ draftRetentionDays: Number(e.target.value) })}
              >
                {('value' in draftOptions ? draftOptions.value : [draft.draftRetentionDays]).map((n) => (
                  <option key={n} value={String(n)}>
                    {n} days
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="settingsEdit__fieldGroup">
            <label className="settingsEdit__field">
              <span className="settingsEdit__fieldLabel">Choices offered (days)</span>
              <input
                type="text"
                className="settingsEdit__input"
                value={draft.draftRetentionOptions}
                placeholder="30, 60, 90"
                disabled={busy}
                onChange={(e) => edit({ draftRetentionOptions: e.target.value })}
                {...fieldErrorAttrs('draftOptions', fieldError('draftRetentionOptions'), 'draftOptions-hint')}
              />
            </label>
            <span id="draftOptions-hint" className="settingsEdit__hint">
              Separate with commas.
            </span>
            <FieldError id="draftOptions" message={fieldError('draftRetentionOptions')} />
          </div>
        </div>
        <p className="settingsEdit__hint">
          Unsent drafts older than this are deleted nightly. A draft you edited stays for this long
          from the edit, not from when you started it. Nothing that has been sent is ever touched.
        </p>
      </div>

      <div className="settingsEdit__subsection">
        <span className="settingsEdit__fieldLabel">Records and sharing</span>
        <ul className="settingsEdit__toggleList">
          <li className="settingsEdit__toggleRow">
            <span className="settingsEdit__toggleLabel">Tag visit photos with where they were taken</span>
            <Toggle
              label="Toggle photo location tagging"
              checked={draft.enablePhotoLocationTagging}
              disabled={busy}
              onChange={(next) => edit({ enablePhotoLocationTagging: next })}
            />
          </li>
          <li className="settingsEdit__toggleRow">
            <span className="settingsEdit__toggleLabel">Verify arrival and departure by location</span>
            <Toggle
              label="Toggle arrival and departure verification"
              checked={draft.requireArrivalDepartureVerification}
              disabled={busy}
              onChange={(next) => edit({ requireArrivalDepartureVerification: next })}
            />
          </li>
          {/* #2123: never blocks completion. With it on, a visit completed with
              no KinTale sent stays under "KinTales to send" on Auntie Time
              until one is. */}
          <li className="settingsEdit__toggleRow">
            <span className="settingsEdit__toggleLabel">KinTale required</span>
            <Toggle
              label="Toggle KinTale required"
              checked={draft.kinTaleRequired}
              disabled={busy}
              onChange={(next) => edit({ kinTaleRequired: next })}
            />
          </li>
          <li className="settingsEdit__toggleRow">
            <span className="settingsEdit__toggleLabel">Let kinfolk see visit locations</span>
            <Toggle
              label="Toggle kinfolk location sharing"
              checked={draft.allowClientLocationSharing}
              disabled={busy}
              onChange={(next) => edit({ allowClientLocationSharing: next })}
            />
          </li>
        </ul>
        <div className="settingsEdit__fields">
          <div className="settingsEdit__fieldGroup">
            <label className="settingsEdit__field">
              <span className="settingsEdit__fieldLabel">Arrival must be within (metres)</span>
              <input
                type="text"
                inputMode="numeric"
                className="settingsEdit__input"
                value={draft.arrivalRadiusMeters}
                disabled={busy}
                onChange={(e) => edit({ arrivalRadiusMeters: e.target.value })}
                {...fieldErrorAttrs('arrivalRadius', fieldError('arrivalRadiusMeters'), 'arrivalRadius-hint')}
              />
            </label>
            <FieldError id="arrivalRadius" message={fieldError('arrivalRadiusMeters')} />
            <span id="arrivalRadius-hint" className="settingsEdit__hint">
              Only applies while Verify arrival and departure by location is on. An arrival
              recorded further than this from the household stops the visit being marked complete.
              An arrival with no usable location still goes through, and is recorded as
              unverified: no signal, location turned off, an address we cannot place on the map, or
              the desktop console, which has no GPS.
            </span>
          </div>
          <div className="settingsEdit__fieldGroup">
            <label className="settingsEdit__field">
              <span className="settingsEdit__fieldLabel">Keep visit routes for (days)</span>
              <input
                type="text"
                inputMode="numeric"
                className="settingsEdit__input"
                value={draft.saveRoutesForDays}
                disabled={busy}
                onChange={(e) => edit({ saveRoutesForDays: e.target.value })}
                {...fieldErrorAttrs('saveRoutes', fieldError('saveRoutesForDays'))}
              />
            </label>
            <FieldError id="saveRoutes" message={fieldError('saveRoutesForDays')} />
          </div>
        </div>
        <p className="settingsEdit__hint">
          Route pings older than this are deleted nightly; the visit and its summary map stay.
          Photo tagging happens on the phone, where visits are worked. The arrival check is made on
          the server when a visit is marked complete, so it applies wherever the visit is closed.
        </p>
      </div>

      <div className="settingsEdit__saveRow">
        <GhostButton
          label="Cancel"
          onClick={() => {
            setDraft(seed(data));
            setServerErrors({});
            setError(null);
            setJustSaved(false);
          }}
          disabled={!dirty || busy}
        />
        <PrimaryButton
          label={busy ? 'Saving…' : 'Save'}
          onClick={() => void handleSave()}
          disabled={!dirty || busy || problem !== null}
          busy={busy}
        />
        {justSaved && !dirty ? <span className="settingsEdit__savedNote">Saved</span> : null}
      </div>
    </DenPanel>
  );
}
