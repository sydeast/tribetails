import { useState } from 'react';
import type { BusinessSettings } from '../../api/settings';
import { DenPanel } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton } from '../../components/Buttons';
import { Toggle } from '../../components/Toggle';
import {
  NUMBER_FIELDS,
  TRACKING_ACCURACIES,
  clampToOptions,
  formatOptionList,
  optionsIncluding,
  parseOptionList,
  parseWholeNumber,
} from '../../lib/businessOperations';
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
    arrivalRadiusMeters: String(data.arrivalRadiusMeters),
    allowClientLocationSharing: data.allowClientLocationSharing,
    saveRoutesForDays: String(data.saveRoutesForDays),
    defaultEtaMinutes: data.defaultEtaMinutes,
    etaMinuteOptions: formatOptionList(data.etaMinuteOptions),
    draftRetentionDays: data.draftRetentionDays,
    draftRetentionOptions: formatOptionList(data.draftRetentionOptions),
  };
}

/**
 * The patch this draft would write, or the first thing to fix.
 *
 * The two defaults are CLAMPED to their own option lists rather than refused:
 * deleting the entry that happens to be selected is a normal edit, and stopping
 * the save on it would mean the operator has to fix a field they were not
 * editing. `clampToOptions` moves to the nearest remaining option, ties going
 * to the shorter wait.
 */
export function visitsTrackingPatch(
  draft: Draft,
): { patch: Partial<BusinessSettings> } | { error: string } {
  const routeDays = parseWholeNumber(draft.saveRoutesForDays, NUMBER_FIELDS.saveRoutesForDays);
  if ('error' in routeDays) return { error: `Keep routes for: ${routeDays.error}` };
  // #582. Validated even while the switch above is off, because the value is
  // still saved and would otherwise become an unfixable problem the first time
  // somebody turns verification on.
  const radius = parseWholeNumber(draft.arrivalRadiusMeters, NUMBER_FIELDS.arrivalRadiusMeters);
  if ('error' in radius) return { error: `Arrival must be within: ${radius.error}` };
  const eta = parseOptionList(draft.etaMinuteOptions, 'minutes');
  if ('error' in eta) return { error: `On-my-way choices: ${eta.error}` };
  const drafts = parseOptionList(draft.draftRetentionOptions, 'days');
  if ('error' in drafts) return { error: `Draft-retention choices: ${drafts.error}` };
  return {
    patch: {
      enableGPSTrackingForAllVisits: draft.enableGPSTrackingForAllVisits,
      autoStartTrackingOnVisitStart: draft.autoStartTrackingOnVisitStart,
      trackingAccuracy: draft.trackingAccuracy,
      enablePhotoLocationTagging: draft.enablePhotoLocationTagging,
      requireArrivalDepartureVerification: draft.requireArrivalDepartureVerification,
      arrivalRadiusMeters: radius.value,
      allowClientLocationSharing: draft.allowClientLocationSharing,
      saveRoutesForDays: routeDays.value,
      defaultEtaMinutes: clampToOptions(draft.defaultEtaMinutes, eta.value),
      etaMinuteOptions: eta.value,
      draftRetentionDays: clampToOptions(draft.draftRetentionDays, drafts.value),
      draftRetentionOptions: drafts.value,
    },
  };
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

function isDirty(draft: Draft, data: BusinessSettings): boolean {
  const built = visitsTrackingPatch(draft);
  if ('error' in built) return true;
  const p = built.patch;
  return (
    p.enableGPSTrackingForAllVisits !== data.enableGPSTrackingForAllVisits ||
    p.autoStartTrackingOnVisitStart !== data.autoStartTrackingOnVisitStart ||
    p.trackingAccuracy !== data.trackingAccuracy ||
    p.enablePhotoLocationTagging !== data.enablePhotoLocationTagging ||
    p.requireArrivalDepartureVerification !== data.requireArrivalDepartureVerification ||
    p.arrivalRadiusMeters !== data.arrivalRadiusMeters ||
    p.allowClientLocationSharing !== data.allowClientLocationSharing ||
    p.saveRoutesForDays !== data.saveRoutesForDays ||
    p.defaultEtaMinutes !== data.defaultEtaMinutes ||
    !sameNumbers(p.etaMinuteOptions ?? [], data.etaMinuteOptions) ||
    p.draftRetentionDays !== data.draftRetentionDays ||
    !sameNumbers(p.draftRetentionOptions ?? [], data.draftRetentionOptions)
  );
}

export function VisitsTrackingSection({ data, onSave }: VisitsTrackingSectionProps) {
  const [draft, setDraft] = useState<Draft>(() => seed(data));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const built = visitsTrackingPatch(draft);
  const problem = 'error' in built ? built.error : null;
  const dirty = isDirty(draft, data);
  const tracking = draft.enableGPSTrackingForAllVisits;

  // The two dropdowns offer whatever the operator has typed into the list beside
  // them, so editing the list and re-picking the default are one continuous act
  // rather than a save-and-reopen.
  const etaOptions = parseOptionList(draft.etaMinuteOptions, 'minutes');
  const draftOptions = parseOptionList(draft.draftRetentionOptions, 'days');

  function edit(next: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...next }));
    setJustSaved(false);
  }

  async function handleSave() {
    if (!dirty || busy || 'error' in built) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(built.patch);
      setJustSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
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
      {problem ? (
        <Banner tone="warning" title="Not ready to save" className="settingsEdit__sectionBanner">
          {problem}
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
                aria-describedby="etaOptions-hint"
                onChange={(e) => edit({ etaMinuteOptions: e.target.value })}
              />
            </label>
            <span id="etaOptions-hint" className="settingsEdit__hint">
              Separate with commas. These are the waits the On My Way sheet offers.
            </span>
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
                aria-describedby="draftOptions-hint"
                onChange={(e) => edit({ draftRetentionOptions: e.target.value })}
              />
            </label>
            <span id="draftOptions-hint" className="settingsEdit__hint">
              Separate with commas.
            </span>
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
                aria-describedby="arrivalRadius-hint"
                onChange={(e) => edit({ arrivalRadiusMeters: e.target.value })}
              />
            </label>
            <span id="arrivalRadius-hint" className="settingsEdit__hint">
              Only applies while the switch above is on. An arrival recorded further than this from
              the household stops the visit being marked complete. An arrival with no usable
              location still goes through, and is recorded as unverified: no signal, location
              turned off, an address we cannot place on the map, or the desktop console, which has
              no GPS.
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
              />
            </label>
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
