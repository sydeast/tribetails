import { useState } from 'react';
import { type BusinessSettings } from '../../api/settings';
import { DenPanel } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { Toggle } from '../../components/Toggle';
import '../SettingsEdit.css';

/**
 * ISSUE #397: the operator's switch for "press 3 to talk to me right now".
 *
 * ── WHY THIS IS A TOGGLE AND NOT A DESTINATION PICKER ─────────────────────────
 *
 * The obvious shape for "who is the live person" is a text box holding a phone
 * number. It is not built, and its absence is the point rather than an omission.
 *
 * The transfer rings `client:auntie`, a Twilio Voice SDK identity that every
 * signed-in admin device registers as (`mintVoiceAccessToken` derives it
 * server-side and never reads it from the caller). So "who answers" is already
 * answered by who is signed in, and it updates itself when the roster does. A
 * free-text number would add a second, contradictory answer, and it would add
 * one specific hazard: a field on this screen that can point the business line
 * at somebody's personal phone. There is no such field anywhere in the voice
 * path, and that is deliberate.
 *
 * What the operator actually needs to decide is whether she is taking live
 * calls at all. That is this switch, and nothing else.
 *
 * ── WHY THE PANEL DISCLOSES INSTEAD OF PROMISING ──────────────────────────────
 *
 * This switch decides what the greeting OFFERS. It cannot decide whether a
 * caller gets through, because two of the three things that have to be true
 * live outside this repo: the Twilio Voice credentials have to be real, and the
 * business number's "A call comes in" webhook has to point at the twilioVoice
 * function. As of this writing the four Voice secrets in Secret Manager are
 * placeholders and the number's forwarding has not been set up, so the transfer
 * has never been proved against a real call.
 *
 * The panel therefore says so, in a banner that does not go away. It is not a
 * status check dressed up as one: a browser cannot see a Cloud Functions secret,
 * and even a server check would come back green on a placeholder that happens to
 * be the right shape, while telling nobody that the phone number still forwards
 * somewhere else. Both halves of that are unknowable from here, so the honest
 * thing to render is the unknowing, next to the one place that can check the
 * half a server can: Settings, Integrations.
 *
 * If the switch is off, the banner is not shown. Nothing is being promised when
 * nothing is being offered.
 */

interface PhoneLineSectionProps {
  data: BusinessSettings;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}

export function PhoneLineSection({ data, onSave }: PhoneLineSectionProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ voiceLiveTransferEnabled: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  const enabled = data.voiceLiveTransferEnabled;

  return (
    <DenPanel
      title="Phone line"
      subtitle="What callers are offered when they ring the business number. Saves immediately."
    >
      {error ? (
        <Banner tone="error" title="Save failed" className="settingsEdit__sectionBanner">
          {error}
        </Banner>
      ) : null}
      <ul className="settingsEdit__toggleList">
        <li className="settingsEdit__toggleRow">
          <span className="settingsEdit__toggleLabel">Let callers reach me live</span>
          <Toggle
            label="Toggle letting callers reach me live"
            checked={enabled}
            disabled={saving}
            onChange={(next) => void toggle(next)}
          />
        </li>
      </ul>
      <p className="settingsEdit__hint">
        {enabled
          ? 'Callers hear "press 3 to talk to me right now". Pressing 3 asks who is calling, then ' +
            'rings the AuntieOS app on every device you are signed in on.'
          : 'Callers are offered a voicemail and nothing else. Press 3 is not mentioned, and a caller ' +
            'who presses it anyway is asked again for a voicemail.'}
      </p>
      <p className="settingsEdit__hint">
        Business hours come first either way: outside the hours on the Business hours page, the
        transfer is never offered. If you do not pick up, if you decline, or if the call cannot be
        placed at all, the caller is offered a voicemail instead of being left on a ringing line.
      </p>
      {enabled ? (
        <Banner
          tone="warning"
          title="Not confirmed working yet"
          className="settingsEdit__sectionBanner"
        >
          This switch controls what the greeting offers. Whether a caller actually reaches you also
          needs the Twilio voice credentials and the business number&apos;s incoming-call forwarding,
          both set up outside this app. Those are not finished, so press 3 has not been tested on a
          real call yet. Settings, Integrations shows the part the server can check. Until then,
          treat voicemail as the reliable path.
        </Banner>
      ) : null}
    </DenPanel>
  );
}
