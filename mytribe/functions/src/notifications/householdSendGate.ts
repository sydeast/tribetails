import type { Firestore } from 'firebase-admin/firestore';
import { logEvent } from '../lib/logger';
import { BUSINESS_SETTINGS_DOC, BUSINESS_SETTINGS_DOC_LEGACY } from '../lib/businessHours';

/**
 * THE PRE-LAUNCH SEND GATE. Nothing reaches a household until the operator
 * switches it on.
 *
 * ── WHY IT EXISTS ─────────────────────────────────────────────────────────────
 *
 * The product is not live, and production data is about to be deleted and
 * re-uploaded whole. A bulk re-upload of historical invoices lands a pile of
 * unpaid, long-past-due bills in `invoices`, and the next `invoiceOverdueCron`
 * scan would find every one of them eligible and write a real household an
 * overdue notice about a bill they settled months ago in the old system. (That
 * scan ran at 09:30 when this was written. It now runs at the hour the operator
 * picks; see `lib/notificationSchedule.ts`.)
 * `invoiceRemindersCron`, `kincareReminderCron`, `scheduleDigestCron` and the
 * three notification sweeps all sit on the same trip wire.
 *
 * ── WHY IT IS ONE FLAG AT THE DISPATCHER AND NOT A SWITCH PER CRON ────────────
 *
 * Because the same sweeps carry the operator's OWN alerts. `security.account.locked.operator`
 * and `security.failedLogin.attempts.operator` (#876) ride the identical path as
 * `invoice.overdue`, and those have to keep working: the operator is the only
 * person watching an unlaunched system. Switching off a cron silences both
 * audiences at once. Switching off HOUSEHOLD-BOUND COPIES silences exactly the
 * ones that would embarrass us, and a lockout alert still reaches the operator
 * from the same run of the same function.
 *
 * Gating in `enqueueNotificationDetailed` also means a caller added next month
 * cannot route around it by forgetting to ask.
 *
 * ── ABSENT IS OFF, AND A FAILED READ IS OFF ───────────────────────────────────
 *
 * The field does not exist in production today, so absent has to mean off or
 * the gate would protect nothing on the day it deploys.
 *
 * A read that THROWS is off too, and that choice is worth stating plainly
 * because it is the opposite of what `businessHours.ts` does three functions
 * away. The phone line fails OPEN, because a caller wrongly told the business is
 * shut hangs up and does not call back. This fails CLOSED, because the cost of
 * the two mistakes is reversed while the product is pre-launch: a suppressed
 * notice is sent on the next run an hour or a day later, and a notice sent to a
 * real household about a migrated bill cannot be recalled.
 *
 * THAT TRADE FLIPS AT LAUNCH and should be revisited then. Once households are
 * live, a Firestore blip would suppress notifications people are waiting for,
 * and "fail closed" stops being the cautious option. It is not flipped here
 * because today the gate is off anyway, so a fail-open read would change nothing
 * except on the one day it matters most.
 *
 * A failed read is therefore logged at CRITICAL rather than swallowed. Absent
 * and explicitly-false are ordinary states and log nothing; only "we could not
 * tell" is an incident.
 */

/**
 * The boolean on `business_settings/business_settings`.
 *
 * It lives on the settings document every other business-wide switch lives on
 * (`timeZone`, `businessHours`, `voiceLiveTransferEnabled`), read through the
 * same modern-id-then-legacy-`singleton` fallback, rather than in a collection
 * of its own. `docs/runbooks/household-notifications.md` has the operator's instructions for setting it.
 */
export const HOUSEHOLD_SEND_GATE_FIELD = 'householdNotificationsLive';

/**
 * What the settings document said, kept as four states rather than a boolean.
 *
 * Three of them mean "do not send" and only one of the three is a problem, so
 * collapsing them would either log an incident every time the gate is simply
 * off, or log nothing when Firestore is unreachable. Both were unacceptable.
 */
export type HouseholdSendGateState =
  /** The field is `true`. Household copies go out. */
  | 'live'
  /** The field (or the whole settings document) is not there. The pre-launch default. */
  | 'absent'
  /** The field is present and is not `true`. The operator turned it off. */
  | 'off'
  /** The read threw. Logged at critical; treated as off. */
  | 'read-failed';

export interface HouseholdSendGate {
  /** The only question the dispatcher asks. */
  live: boolean;
  /** Why, for the log line and for the tests. */
  state: HouseholdSendGateState;
}

/** The slice of the settings document this module reads. Raw data, so `unknown`. */
export interface HouseholdSendGateSettings {
  [HOUSEHOLD_SEND_GATE_FIELD]?: unknown;
}

/**
 * PURE. The state of the gate given a settings document, or `null` for "no
 * settings document exists".
 *
 * STRICTLY `=== true`. A string `'true'`, a `1`, or anything else a hand-edit
 * or a half-typed client could leave behind is not a switch-on. The operator
 * turns this on deliberately, once, from the admin Settings or that doc, and a value we cannot
 * read as the literal boolean is not evidence that they did.
 */
export function resolveHouseholdSendGate(
  settings: HouseholdSendGateSettings | null,
): HouseholdSendGateState {
  if (settings === null) return 'absent';
  const raw = settings[HOUSEHOLD_SEND_GATE_FIELD];
  if (raw === true) return 'live';
  if (raw === undefined) return 'absent';
  return 'off';
}

/**
 * Reads the gate, modern settings id first and then the legacy `singleton`, the
 * same two-id walk `loadBusinessHoursSettings` performs.
 *
 * IT DOES NOT REUSE `loadBusinessHoursSettings`, deliberately. That function
 * catches its own read error and returns `null`, which is the same answer it
 * gives for "the document is not there". Both are off, so a boolean gate could
 * share it, but then a Firestore outage would be indistinguishable from the
 * ordinary pre-launch state and nothing would ever be logged. Telling the two
 * apart is the whole reason requirement 1 asks for a critical log, so the read
 * is done here where the `catch` can say which one happened.
 */
export async function loadHouseholdSendGate(firestore: Firestore): Promise<HouseholdSendGate> {
  let state: HouseholdSendGateState;
  try {
    const snap = await firestore.doc(BUSINESS_SETTINGS_DOC).get();
    if (snap.exists) {
      state = resolveHouseholdSendGate((snap.data() ?? {}) as HouseholdSendGateSettings);
    } else {
      const legacy = await firestore.doc(BUSINESS_SETTINGS_DOC_LEGACY).get();
      state = legacy.exists
        ? resolveHouseholdSendGate((legacy.data() ?? {}) as HouseholdSendGateSettings)
        : 'absent';
    }
  } catch (err) {
    logEvent({
      severity: 'critical',
      function: 'householdSendGate',
      event: 'household.send.gate.read.failed',
      errorMessage: (err as Error)?.message,
      extra: {
        doc: BUSINESS_SETTINGS_DOC,
        field: HOUSEHOLD_SEND_GATE_FIELD,
        // Said out loud in the log, because the consequence of this line is that
        // real households hear nothing until the read recovers.
        effect: 'household notifications suppressed (fail closed)',
      },
    });
    return { live: false, state: 'read-failed' };
  }
  return { live: state === 'live', state };
}

/**
 * #1834 (operator ruling, 2026-11-20): WHAT THE HOUSEHOLD SEND SWITCH HOLDS.
 *
 * "Send notices to households" (`householdNotificationsLive`) holds every
 * automatic notice to a household (`householdSendGate.ts`). The ruling settles
 * the two kinds of send a person presses by hand:
 *
 *   - BROADCASTS ARE HELD. A Communicate broadcast and a marketing blast, the
 *     two one-to-many sends, are held as a whole while the switch is off, or
 *     while that notification is turned off in Settings. Nothing is queued to
 *     go later: the owner is told on screen, the Activity Log gets one line,
 *     and the owner sends again once notices are back on.
 *
 *   - SINGLE MESSAGES PASS. A message the owner writes to one household goes
 *     with the switch off: a Communicate email or text (`sendExternalMessage`,
 *     `sendGeneratedDraft`), and a Communicate push or an inbox reply (both
 *     `message.reply`). A household's own channel choices and the operator's
 *     per-notice switch still apply to them.
 *
 * NOT THE KINTALE NOTICE, ON PURPOSE. `kintale.published` is sent by the
 * KinTale document triggers, and those fire for every report the production
 * re-upload writes as well as for one a person sends; nothing on a report
 * tells the two apart (`docs/runbooks/household-notifications.md`). Passing it
 * here would announce every uploaded KinTale to its household during the
 * re-upload. It stays held until a send a person makes can be told apart.
 *
 * Invites and password resets were never behind the switch and are not here.
 *
 * Here, beside the gate itself, because the dispatcher and the scheduled sweep
 * ask it synchronously at cold start. The async checks and the refusal live in
 * `sendSwitchRules.ts`, which is loaded only when a broadcast or a blast runs.
 */

/** Household-copy keys that pass the send switch: one message, one household, sent by a person. */
export const ONE_HOUSEHOLD_MESSAGE_KEYS: readonly string[] = ['message.reply'];

/**
 * The one-to-many sends. `broadcast.message` is a Communicate broadcast; the
 * other three are the marketing blast campaigns (`MARKETING_KEYS` in
 * `admin/scheduleMarketingBlast.ts`, pinned equal by the test).
 */
export const BROADCAST_KEYS: readonly string[] = [
  'broadcast.message',
  'newsletter.announcement',
  'survey.event',
  'marketing.optin',
];

/** True when a household copy of `key` goes out with the send switch off. */
export function passesHouseholdSendSwitch(key: string): boolean {
  return ONE_HOUSEHOLD_MESSAGE_KEYS.includes(key);
}

/** True for the keys a broadcast or a marketing blast sends. */
export function isBroadcastKey(key: string): boolean {
  return BROADCAST_KEYS.includes(key);
}
