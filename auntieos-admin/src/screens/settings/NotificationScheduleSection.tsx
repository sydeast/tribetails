import { useState } from 'react';
import type { BusinessSettings } from '../../api/settings';
import { DenPanel } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton } from '../../components/Buttons';
import { Toggle } from '../../components/Toggle';
import '../SettingsEdit.css';

/**
 * WHEN THE DAILY NOTIFICATION JOBS RUN, AND WHETHER THEY REACH ANYBODY.
 *
 * Two settings the operator could not touch from any client until now.
 *
 * `householdNotificationsLive` shipped in PR #943 as the pre-launch send gate
 * and has had NO control anywhere: turning the product on meant editing a
 * Firestore document by hand, with `docs/RUNBOOK.md` walking through it. This
 * panel is its first switch.
 *
 * `householdNotificationHour` and `scheduleDigestHour` are new, and they are the
 * answer to "the 09:30 overdue job shouldn't be hardcoded and adjustable in the
 * auntieos". A Cloud Scheduler expression is fixed when the function deploys and
 * cannot be read from Firestore at runtime, so the jobs tick hourly and act on
 * the hour stored here. `mytribe/functions/src/lib/notificationSchedule.ts`
 * carries the full reasoning.
 *
 * ── NOT SCHEDULED IS THE SHIPPED STATE, AND IT IS A REAL CHOICE ───────────────
 *
 * Operator ruling 2026-09-22: no job runs until they switch it on here, and the
 * cadence is decided then. So "Not scheduled" is the first option in both
 * pickers, it is what an unconfigured document reads as, and it means the job
 * does nothing at any hour of any day. The old 09:00, 09:30 and 07:00 are not
 * offered back as defaults, because nobody ever chose them.
 *
 * ── ONE SAVE FOR THE PANEL, NOT ONE PER FLIP ──────────────────────────────────
 *
 * The three controls are one decision. An operator opening the product for the
 * first time is setting the switch AND the hour in the same sitting, and saving
 * each flip separately would put the document through the half-configured state
 * in between: sends on, no cadence. `BookingRulesSection` next door saves the
 * same way and for the same reason.
 */

interface NotificationScheduleSectionProps {
  data: BusinessSettings;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}

interface Draft {
  householdNotificationsLive: boolean;
  /** '' is "Not scheduled". A `<select>` value is a string, so the draft holds one. */
  householdNotificationHour: string;
  scheduleDigestHour: string;
}

/** The value a picker shows for a stored hour, or '' for "not scheduled". */
export function hourFieldValue(hour: number | null): string {
  return hour === null ? '' : String(hour);
}

/**
 * What a picker's value means as a stored hour.
 *
 * Anything that is not one of the 24 options reads as null rather than as a
 * number, which matches `resolveSendHour` on the server: a job whose cadence
 * cannot be read is a job with no cadence, never a job quietly given one.
 */
export function hourFieldNumber(value: string): number | null {
  if (value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
}

/**
 * "9:00 AM" for 9. Twelve-hour with a meridiem because the operator reads this,
 * not a machine, and "13:00" is a needless translation on a US business's
 * settings screen. The stored value is the integer either way.
 */
export function hourLabel(hour: number): string {
  const meridiem = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:00 ${meridiem}`;
}

/** The 24 choices, plus the "not scheduled" one that comes first. */
export const HOUR_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'Not scheduled' },
  ...Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: hourLabel(h) })),
];

function seed(data: BusinessSettings): Draft {
  return {
    householdNotificationsLive: data.householdNotificationsLive,
    householdNotificationHour: hourFieldValue(data.householdNotificationHour),
    scheduleDigestHour: hourFieldValue(data.scheduleDigestHour),
  };
}

/** The patch this draft would write. */
export function notificationSchedulePatch(draft: Draft): Partial<BusinessSettings> {
  return {
    householdNotificationsLive: draft.householdNotificationsLive,
    householdNotificationHour: hourFieldNumber(draft.householdNotificationHour),
    scheduleDigestHour: hourFieldNumber(draft.scheduleDigestHour),
  };
}

function isDirty(draft: Draft, data: BusinessSettings): boolean {
  const p = notificationSchedulePatch(draft);
  return (
    p.householdNotificationsLive !== data.householdNotificationsLive ||
    p.householdNotificationHour !== data.householdNotificationHour ||
    p.scheduleDigestHour !== data.scheduleDigestHour
  );
}

/**
 * The one state worth naming on screen: sends are on but nothing is scheduled,
 * so no invoice notice will ever go out however many bills are overdue.
 *
 * It is a NOTE AND NOT A BLOCKED SAVE. It is a legal state, and it is a
 * reasonable one to pass through while the operator opens the product before
 * deciding when it should chase anybody. Refusing to save it would be this
 * panel deciding an order of operations the operator did not ask for.
 */
export function scheduleNote(draft: Draft): string | null {
  const hour = hourFieldNumber(draft.householdNotificationHour);
  if (draft.householdNotificationsLive && hour === null) {
    return 'Household notices are on, but no send time is set, so none will go out yet. Pick a time below.';
  }
  if (!draft.householdNotificationsLive && hour !== null) {
    return 'A send time is set, but household notices are off, so nothing reaches a household yet.';
  }
  return null;
}

export function NotificationScheduleSection({ data, onSave }: NotificationScheduleSectionProps) {
  const [draft, setDraft] = useState<Draft>(() => seed(data));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const dirty = isDirty(draft, data);
  const note = scheduleNote(draft);

  function edit(next: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...next }));
    setJustSaved(false);
  }

  async function handleSave() {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(notificationSchedulePatch(draft));
      setJustSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <DenPanel
      title="Notification schedule"
      subtitle="Whether automatic notices reach households at all, and what time of day the daily jobs run."
      detail={`Times are in ${data.timeZone}`}
    >
      {error ? (
        <Banner tone="error" title="Save failed" className="settingsEdit__sectionBanner">
          {error}
        </Banner>
      ) : null}
      {note ? (
        <Banner tone="warning" title="Worth knowing" className="settingsEdit__sectionBanner">
          {note}
        </Banner>
      ) : null}

      <div className="settingsEdit__subsection">
        <span className="settingsEdit__groupHeading">Sending</span>
        <ul className="settingsEdit__toggleList">
          <li className="settingsEdit__toggleRow">
            <span className="settingsEdit__toggleLabel">Send notices to households</span>
            <Toggle
              label="Toggle household notifications"
              checked={draft.householdNotificationsLive}
              disabled={busy}
              onChange={(next) => edit({ householdNotificationsLive: next })}
            />
          </li>
        </ul>
        <p className="settingsEdit__hint">
          Off, every notice bound for a household is held back and nothing is sent. Your own alerts
          and the daily digest still reach you.
        </p>
      </div>

      <div className="settingsEdit__subsection">
        <span className="settingsEdit__groupHeading">Daily jobs</span>
        <div className="settingsEdit__fields">
          <div className="settingsEdit__fieldGroup">
            <label className="settingsEdit__field">
              <span className="settingsEdit__fieldLabel">Invoice reminders and overdue notices</span>
              <select
                className="settingsEdit__input"
                value={draft.householdNotificationHour}
                disabled={busy}
                aria-describedby="householdHour-hint"
                onChange={(e) => edit({ householdNotificationHour: e.target.value })}
              >
                {HOUR_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <span id="householdHour-hint" className="settingsEdit__hint">
              Both run once a day at this time. Not scheduled means neither runs.
            </span>
          </div>

          <div className="settingsEdit__fieldGroup">
            <label className="settingsEdit__field">
              <span className="settingsEdit__fieldLabel">Your daily schedule digest</span>
              <select
                className="settingsEdit__input"
                value={draft.scheduleDigestHour}
                disabled={busy}
                aria-describedby="digestHour-hint"
                onChange={(e) => edit({ scheduleDigestHour: e.target.value })}
              >
                {HOUR_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <span id="digestHour-hint" className="settingsEdit__hint">
              The next day&rsquo;s visits, emailed to you. Households never see it.
            </span>
          </div>
        </div>
        {/* Named because the panel would otherwise read as covering every
            notification. Visit reminders go out relative to the visit, not at a
            time of day, so there is no hour to set for them and the switch that
            does govern them lives elsewhere. */}
        <p className="settingsEdit__hint">
          Visit reminders are not on a clock: they go out 24 to 48 hours before each visit. Turn
          them on or off under Booking rules.
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
          disabled={!dirty || busy}
          busy={busy}
        />
        {justSaved && !dirty ? <span className="settingsEdit__savedNote">Saved</span> : null}
      </div>
    </DenPanel>
  );
}
