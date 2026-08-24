import { useState } from 'react';
import type { BusinessSettings } from '../../api/settings';
import { DenPanel } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton } from '../../components/Buttons';
import { deviceTimeZone, isUsableTimeZone, timeZoneOptions } from '../../lib/businessOperations';
import '../SettingsEdit.css';

/**
 * ISSUE #519: `business_settings.timeZone`, editable at last.
 *
 * It is the highest-consequence field the issue found, and it had no editor on
 * any of the three admin surfaces while five separate behaviors read it:
 *   - `mytribe/functions/src/lib/businessHours.ts#resolveBusinessOpen` decides
 *     whether the phone line answers as open or closed;
 *   - `lib/quoteDecision.ts` computes the business-local day a quote expires on;
 *   - `notifications/visitDates.ts` formats the dates in every visit message;
 *   - `notifications/enrichTemplateData.ts` formats template time tokens;
 *   - `components/NewBookingDialog.tsx` discloses a device/business mismatch.
 * The last one is what made the gap visible: the operator was shown a timezone
 * conflict and given nowhere to resolve it.
 *
 * ITS OWN PANEL, under Business profile, rather than a row in
 * `TextFieldsSection`: that section is a plain-text list with one Save, and this
 * is a validated picker whose wrong value has consequences the operator should
 * read about before saving, not after a caller reaches a closed line.
 *
 * BOOKINGS STILL DO NOT CONVERT THROUGH IT, and that stays a decision rather
 * than a gap. `lib/bookingAvailability.ts`'s header states it: the booking wire
 * contract is the operator's device wall clock on BOTH admin clients, and
 * `booking_time_slots` carries no zone at all, so there is no offset to convert
 * from. Making this field editable does not change that; what it changes is that
 * the mismatch note in `NewBookingDialog` now points at something the operator
 * can act on.
 */

interface TimeZoneSectionProps {
  data: Pick<BusinessSettings, 'timeZone'>;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}

export function TimeZoneSection({ data, onSave }: TimeZoneSectionProps) {
  // Seeded ONCE at mount, the `TextFieldsSection` non-clobbering convention: a
  // sibling section's save round-trips through the same `data` prop.
  const [zone, setZone] = useState<string>(() => data.timeZone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const options = timeZoneOptions(data.timeZone);
  const device = deviceTimeZone();
  const usable = isUsableTimeZone(zone);
  const dirty = zone !== data.timeZone;

  async function handleSave() {
    if (!dirty || busy || !usable) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ timeZone: zone });
      setJustSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <DenPanel
      title="Time zone"
      subtitle="The clock the business runs on. Your phone line's open and closed hours, quote expiry dates, and the visit dates in every message are all read in this zone."
    >
      {error ? (
        <Banner tone="error" title="Save failed" className="settingsEdit__sectionBanner">
          {error}
        </Banner>
      ) : null}

      <label className="settingsEdit__field">
        <span className="settingsEdit__fieldLabel">Business time zone</span>
        <select
          className="settingsEdit__input"
          value={zone}
          disabled={busy}
          aria-describedby="timeZone-hint"
          onChange={(e) => {
            setZone(e.target.value);
            setJustSaved(false);
          }}
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <span id="timeZone-hint" className="settingsEdit__hint">
        {device && device !== zone
          ? `This computer is on ${device}. Times you type into the booking dialog stay on this computer's clock; the zone above is what the phone line and outgoing messages read.`
          : 'Times you type into the booking dialog use this computer’s clock. The zone above is what the phone line and outgoing messages read.'}
      </span>

      {!usable ? (
        <Banner tone="warning" title="This zone will not work" className="settingsEdit__sectionBanner">
          Nothing on this computer can read a time in &ldquo;{zone}&rdquo;. Saved as it is, the phone
          line answers as open around the clock. Pick a zone from the list.
        </Banner>
      ) : null}

      <div className="settingsEdit__saveRow">
        <GhostButton
          label="Cancel"
          onClick={() => {
            setZone(data.timeZone);
            setError(null);
            setJustSaved(false);
          }}
          disabled={!dirty || busy}
        />
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
