import { useState } from 'react';
import type { BusinessSettings } from '../../api/settings';
import { DenPanel, InfoTip } from '../../components/DenScreenKit';
import { Banner } from '../../components/Banner';
import { PrimaryButton, GhostButton } from '../../components/Buttons';
import { Toggle } from '../../components/Toggle';
import { VISIT_REMINDER_TIMING, resolveBusinessTimeZone } from '../../lib/businessOperations';
import '../SettingsEdit.css';

/**
 * WHEN THE DAILY NOTIFICATION JOBS RUN, AND WHETHER THEY REACH ANYBODY.
 *
 * Two settings the operator could not touch from any client until now.
 *
 * `householdNotificationsLive` shipped in PR #943 as the pre-launch send gate
 * and has had NO control anywhere: turning the product on meant editing a
 * Firestore document by hand, with `docs/runbooks/household-notifications.md` walking through it. This
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
 * The one state worth naming on screen: the switch and the send time
 * disagreeing, either way round.
 *
 * #1834: THE SEND TIME GOVERNS TWO JOBS, NOT EVERY NOTICE. This used to read
 * "no send time is set, so none will go out yet" with the switch on, while
 * visit notices were reaching the household: on my way, arrived, departed and
 * the KinTale all go out as they happen, and so do booking and invoice notices.
 * Only `invoiceRemindersCron` and `invoiceOverdueCron` wait for the hour
 * (`mytribe/functions/src/lib/notificationSchedule.ts`). The note says that.
 *
 * And four things do not pass the switch: a broadcast, a single email or text
 * message, an invite and a password reset (`test/householdSendGateGuard.test.ts`).
 * So the off note does not say "nothing reaches a household". Everything else
 * is held, a KinTale or an invoice the operator sends by hand included.
 *
 * It is a NOTE AND NOT A BLOCKED SAVE. Both are legal states, reasonable to
 * pass through while the operator opens the product. Refusing to save them
 * would be this panel deciding an order of operations the operator did not ask
 * for. Same sentences on Android and the desktop console
 * (`NotificationSchedulePanel.kt`).
 */
export const SCHEDULE_NOTE_ON_NO_HOUR =
  'Notices to households are on and go out as things happen. Invoice reminders and overdue notices have no send time, so only those two wait.';
export const SCHEDULE_NOTE_OFF_WITH_HOUR =
  'A send time is set, but notices to households are off, so they are held back.';
/** The switch's tooltip: what off holds back, and what it does not. */
export const HOUSEHOLD_SWITCH_TIP =
  'Off, notices to households are held back, a KinTale or an invoice you send included, and so are broadcasts and marketing blasts. A message you write to one household still goes: an email, a text, a push, an inbox reply. Invites and password resets still go too. Your own alerts and the daily digest still reach you.';
export function scheduleNote(draft: Draft): string | null {
  const hour = hourFieldNumber(draft.householdNotificationHour);
  if (draft.householdNotificationsLive && hour === null) return SCHEDULE_NOTE_ON_NO_HOUR;
  if (!draft.householdNotificationsLive && hour !== null) return SCHEDULE_NOTE_OFF_WITH_HOUR;
  return null;
}
/**
 * The panel's value line (#1834): the SAVED state of the switch and of the two
 * jobs' send time, then the clock the times are on. Values, not a sentence
 * (ruling 2026-09-11). It reads the saved document, never the draft, so it
 * cannot say "on" before Save has.
 */
export function scheduleDetail(
  data: Pick<BusinessSettings, 'householdNotificationsLive' | 'householdNotificationHour' | 'timeZone'>,
): string {
  const hour = data.householdNotificationHour;
  return [
    `Notices to households: ${data.householdNotificationsLive ? 'on' : 'off'}`,
    `Invoice reminders: ${hour === null ? 'not scheduled' : hourLabel(hour)}`,
    `Times are in ${resolveBusinessTimeZone(data.timeZone)}`,
  ].join(' · ');
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
      detail={scheduleDetail(data)}
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
            <span className="settingsEdit__toggleLabel">
              Send notices to households{' '}
              <InfoTip text={HOUSEHOLD_SWITCH_TIP} />
            </span>
            <Toggle
              label="Toggle household notifications"
              checked={draft.householdNotificationsLive}
              disabled={busy}
              onChange={(next) => edit({ householdNotificationsLive: next })}
            />
          </li>
        </ul>
      </div>

      <div className="settingsEdit__subsection">
        <span className="settingsEdit__groupHeading">
          Daily jobs{' '}
          <InfoTip text={`Visit reminders are not on a clock: they go out ${VISIT_REMINDER_TIMING} each visit. Turn them on or off under Booking rules.`} />
        </span>
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
