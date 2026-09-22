import type { Firestore } from 'firebase-admin/firestore';
import { logEvent } from './logger';
import {
  BUSINESS_SETTINGS_DOC,
  BUSINESS_SETTINGS_DOC_LEGACY,
  zonedNow,
  type ZonedNow,
} from './businessHours';
import { FALLBACK_BUSINESS_TIME_ZONE } from './quoteDecision';

/**
 * THE HOUR THE DAILY NOTIFICATION JOBS SEND AT, chosen by the operator.
 *
 * ── WHY THE JOBS TICK HOURLY ──────────────────────────────────────────────────
 *
 * `onSchedule({ schedule: 'every day 09:30' })` is Cloud Scheduler configuration.
 * It is fixed when the function deploys and there is no runtime API that reads
 * it back out of Firestore, so a schedule string cannot be made adjustable: a
 * change to it is a redeploy, which is the thing the operator asked to stop
 * doing.
 *
 * That leaves exactly one shape. The job ticks on a fixed frequent cadence,
 * reads the operator's hour on every tick, and returns without acting when this
 * is not the hour. `docs/superpowers/specs/2026-09-22-notification-schedule-design.md`
 * is the design record.
 *
 * ── THE TICK IS UTC AND THE HOUR IS NOT ───────────────────────────────────────
 *
 * The cron expression is `0 * * * *` in `Etc/UTC` on every job that uses this
 * module. Unix cron rather than `every 60 minutes`, because the interval syntax
 * promises a sixty-minute gap and does not promise the top of the hour, and a
 * job that drifts to :47 asks "is it 09:00 yet" at a different point in the hour
 * every day. UTC rather than the business zone, because an hourly cron in a zone
 * with daylight saving has to answer for the hour that does not exist in spring
 * and the hour that happens twice in autumn, and the two answers are "skip" and
 * "run twice". UTC has neither.
 *
 * The operator's hour is then resolved against the BUSINESS zone inside the
 * handler, where `zonedNow` already does that conversion and where a test can
 * drive it.
 *
 * ── NO SECOND TIME ZONE FIELD ─────────────────────────────────────────────────
 *
 * `business_settings.timeZone` already exists and `businessTodayIso` already
 * reads it. A second zone field would let the two disagree, and the first
 * symptom of that is a notice an hour off with nothing on screen to explain it.
 * The `America/New_York` these crons carried was never a decision: operator
 * ruling 2026-08-11 is that the business runs on `America/Chicago`, and the
 * stored `timeZone` had been left at its New York default because no code read
 * it.
 */

/** The hour `invoiceRemindersCron` and `invoiceOverdueCron` act on. */
export const HOUSEHOLD_NOTIFICATION_HOUR_FIELD = 'householdNotificationHour';

/** The hour `scheduleDigestCron` acts on. */
export const SCHEDULE_DIGEST_HOUR_FIELD = 'scheduleDigestHour';

/**
 * ── THERE IS NO DEFAULT HOUR, BY OPERATOR RULING 2026-09-22 ───────────────────
 *
 * The ruling: no job should be running when this ships. They are activated
 * later, from the AuntieOS settings screen, and the cadence is decided then.
 *
 * So an absent hour does not mean 09:00. It means NOT SCHEDULED, and the job
 * does nothing at any hour of any day until the operator picks one. 09:00, 09:30
 * and 07:00 were never a decision anybody made: they are what happened to be
 * typed into three `onSchedule` calls years ago, and shipping them as defaults
 * would be this module guessing at a cadence the operator has reserved for
 * themselves.
 *
 * That is why the `DEFAULT_*_HOUR` constants a reader might come looking for do
 * not exist. Their absence is the feature.
 */

/**
 * THE CRON EXPRESSION EVERY JOB IN THIS MODULE'S CARE USES. Spelled once so the
 * four `onSchedule` calls cannot drift apart, and so the reason above has one
 * place to live.
 */
export const HOURLY_TICK = { schedule: '0 * * * *', timeZone: 'Etc/UTC' } as const;

/** Where a job records the business day its scan last completed on. */
export const SCHEDULED_RUNS_COLLECTION = 'scheduled_runs';

/** How an hour was arrived at. Decides whether anything is logged. */
export type SendHourSource =
  /** The stored field is an integer 0..23. This job has a cadence. */
  | 'stored'
  /** No such field. Every settings document today. Not scheduled, logged nothing. */
  | 'unset'
  /** The field is there and is not an hour. Not scheduled, logged at `warn`. */
  | 'unusable';

export interface SendHour {
  /** The hour 0..23, or null for "no cadence, so this job does nothing". */
  hour: number | null;
  source: SendHourSource;
}

/**
 * PURE. The hour to act on, given whatever the settings document holds.
 *
 * THREE ANSWERS, AND TWO OF THEM MEAN "DO NOTHING". Only an integer 0..23 is a
 * cadence. An absent field is a job the operator has not switched on, which by
 * the ruling above is every job on the day this deploys.
 *
 * A field holding something else is a job whose cadence cannot be read, and
 * reading it loosely is not open to us: there is no default to fall back TO, so
 * a hand-edited `"9"` cannot be rescued into 09:00 without inventing the guess
 * the ruling forbids.
 *
 * That puts this in the same posture as `householdSendGate.resolveHouseholdSendGate`
 * one field away, which reads its boolean as `=== true` and takes every near miss
 * as off. Both are opt-in switches on an unlaunched product, and for both the
 * safe reading of a value we cannot understand is "the operator did not ask for
 * this".
 *
 * The one difference is the log. `unusable` is not an ordinary state the way
 * `unset` is, so the caller warns on it. `firestore.rules` refuses such a value
 * from every client, which leaves a hand edit in the Firestore console as the
 * only way to produce one.
 */
export function resolveSendHour(raw: unknown): SendHour {
  if (raw === undefined || raw === null) return { hour: null, source: 'unset' };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 23) {
    return { hour: null, source: 'unusable' };
  }
  return { hour: raw, source: 'stored' };
}

/** The slice of `business_settings` this module reads. Raw data, so `unknown`. */
export interface NotificationScheduleSettings {
  timeZone?: unknown;
  [HOUSEHOLD_NOTIFICATION_HOUR_FIELD]?: unknown;
  [SCHEDULE_DIGEST_HOUR_FIELD]?: unknown;
}

export interface NotificationSchedule {
  /** The zone the hours are read in, after the `Intl` check and the fallback. */
  timeZone: string;
  householdHour: SendHour;
  digestHour: SendHour;
}

/**
 * PURE. The whole schedule, given a settings document or `null` for "no
 * settings document exists".
 *
 * A blank or unparseable zone falls back to the ruled `America/Chicago`, the
 * same walk `businessTodayIso` performs, so a settings document with no zone
 * still yields a usable wall clock rather than a UTC one.
 */
export function resolveNotificationSchedule(
  settings: NotificationScheduleSettings | null,
): NotificationSchedule {
  const stored = typeof settings?.timeZone === 'string' ? settings.timeZone.trim() : '';
  const timeZone = stored !== '' && zonedNow(0, stored) !== null ? stored : FALLBACK_BUSINESS_TIME_ZONE;
  return {
    timeZone,
    householdHour: resolveSendHour(settings?.[HOUSEHOLD_NOTIFICATION_HOUR_FIELD]),
    digestHour: resolveSendHour(settings?.[SCHEDULE_DIGEST_HOUR_FIELD]),
  };
}

/** The schedule, or the one state a tick refuses to act on. */
export type ScheduleRead =
  | { ok: true; schedule: NotificationSchedule }
  | { ok: false; reason: 'read-failed' };

/**
 * Reads the schedule, modern settings id first and then the legacy `singleton`,
 * the same two-id walk `loadBusinessHoursSettings` and `loadHouseholdSendGate`
 * perform.
 *
 * A READ THAT THROWS SKIPS THE TICK AND LOGS CRITICAL, matching Phase 1's gate.
 * It is worth saying why the trade is easier here than it was there. Under a
 * daily cron, "we could not read our own settings" cost a whole day of notices.
 * Under an hourly tick it costs one hour and the next tick retries, so failing
 * closed got cheaper by a factor of 24 in the same change that made it
 * necessary.
 *
 * IT IS A BEHAVIOUR CHANGE ALL THE SAME, not only a new branch. Today the scans
 * resolve their day through `businessTodayIso`, whose loader swallows its own
 * read error and returns `null`, which falls back to the ruled zone and lets the
 * scan run. After this an unreadable settings document sends nothing until the
 * read recovers.
 *
 * It does not reuse `loadBusinessHoursSettings` for the same reason
 * `loadHouseholdSendGate` does not: that function returns `null` both for "the
 * document is not there" and for "the read threw", and those want opposite
 * answers here. Absent is ordinary and takes the defaults; a throw is an
 * incident.
 */
export async function loadNotificationSchedule(
  firestore: Firestore,
  functionName: string,
): Promise<ScheduleRead> {
  let settings: NotificationScheduleSettings | null;
  try {
    const snap = await firestore.doc(BUSINESS_SETTINGS_DOC).get();
    if (snap.exists) {
      settings = (snap.data() ?? {}) as NotificationScheduleSettings;
    } else {
      const legacy = await firestore.doc(BUSINESS_SETTINGS_DOC_LEGACY).get();
      settings = legacy.exists ? ((legacy.data() ?? {}) as NotificationScheduleSettings) : null;
    }
  } catch (err) {
    logEvent({
      severity: 'critical',
      function: functionName,
      event: 'notification.schedule.read.failed',
      errorMessage: (err as Error)?.message,
      extra: {
        doc: BUSINESS_SETTINGS_DOC,
        // Said out loud, because the consequence of this line is that the job
        // sends nothing this hour.
        effect: 'tick skipped (fail closed)',
      },
    });
    return { ok: false, reason: 'read-failed' };
  }
  return { ok: true, schedule: resolveNotificationSchedule(settings) };
}

/** Why a tick did or did not run the scan. Logged and asserted on. */
export type TickVerdict =
  /** The hour has come and today's scan has not run. */
  | 'run'
  /** No cadence is configured, so this job does nothing. The shipped state. */
  | 'not-scheduled'
  /** The business zone's clock is before the configured hour. */
  | 'before-hour'
  /** The marker says this business day is already done. */
  | 'already-ran-today'
  /** Neither the stored zone nor the fallback could be read by `Intl`. */
  | 'clock-unresolved';

export interface TickDecision {
  verdict: TickVerdict;
  /** The business day, `YYYY-MM-DD`, or '' when the clock could not be read. */
  dayIso: string;
  /** The business zone's hour 0..23, or -1 when the clock could not be read. */
  localHour: number;
}

/**
 * PURE. Whether this tick should run the scan.
 *
 * ── WHY `>=` AND NOT `==` ─────────────────────────────────────────────────────
 *
 * Exact match is the obvious rule and it is wrong in one direction that matters:
 * a tick that does not happen is a day that does not happen. Cloud Scheduler can
 * miss a fire, a deploy can land on the hour, a cold start can fail, and under
 * exact match the job then waits a full day. Under `>=` the next tick picks it
 * up.
 *
 * It also matches what the operator does. They open the settings screen at 11am,
 * move the hour from 14 to 09, and the reasonable reading of that is "send them
 * now", not "send them tomorrow".
 *
 * ── THE MARKER IS WHAT MAKES EITHER RULE SAFE ─────────────────────────────────
 *
 * `lastRunDayIso` is not an extra precaution bolted onto the catch-up rule. It
 * is what stops a double send under BOTH rules. An operator who moves the hour
 * from 09 to 14 at 11am has already had 09:00 happen and still has 14:00 to
 * come, and exact match fires on both. The hour comparison answers none of the
 * four ways an operator can move this field; the marker answers all of them.
 *
 * ── THE DAY IS THE BUSINESS DAY ───────────────────────────────────────────────
 *
 * Never the UTC day, which rolls over at 18:00 or 19:00 on the operator's clock
 * and would let a late-evening hour fire twice.
 */
export function decideTick(args: {
  nowMs: number;
  timeZone: string;
  hour: number;
  lastRunDayIso: string | null;
}): TickDecision {
  const now: ZonedNow | null =
    zonedNow(args.nowMs, args.timeZone) ?? zonedNow(args.nowMs, FALLBACK_BUSINESS_TIME_ZONE);
  if (now === null) return { verdict: 'clock-unresolved', dayIso: '', localHour: -1 };
  const localHour = Number(now.timeHHmm.slice(0, 2));
  if (!Number.isInteger(localHour)) return { verdict: 'clock-unresolved', dayIso: '', localHour: -1 };
  if (localHour < args.hour) return { verdict: 'before-hour', dayIso: now.dateIso, localHour };
  if (args.lastRunDayIso === now.dateIso) {
    return { verdict: 'already-ran-today', dayIso: now.dateIso, localHour };
  }
  return { verdict: 'run', dayIso: now.dateIso, localHour };
}

/**
 * The business day this job's scan last completed on, or null when it has never
 * run or the marker cannot be read.
 *
 * A MARKER THAT CANNOT BE READ IS NOT A REASON TO SKIP, which is the opposite of
 * the settings read above, and the asymmetry is the point. An unreadable settings
 * document means we do not know what the operator asked for. An unreadable marker
 * means we do not know whether we already did it, and every job that reaches this
 * point carries a per-record stamp that makes a repeat scan idempotent:
 * `reminderNotifiedAtMs`, `overdueNotifiedAtMs`, and for the digest a per-day
 * dedupe key at the dispatcher. So the safe answer is "run and let the per-record
 * guard referee it", and the risk is a wasted scan rather than a second notice.
 */
export async function readLastRunDay(
  firestore: Firestore,
  functionName: string,
): Promise<string | null> {
  try {
    const snap = await firestore.doc(`${SCHEDULED_RUNS_COLLECTION}/${functionName}`).get();
    const raw = snap.data()?.lastRunDayIso;
    return typeof raw === 'string' && raw !== '' ? raw : null;
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: functionName,
      event: 'notification.schedule.marker.read.failed',
      errorMessage: (err as Error)?.message,
      extra: { effect: 'scan runs; per-record stamps prevent a second send' },
    });
    return null;
  }
}

/**
 * Records that this job's scan completed for `dayIso`.
 *
 * WRITTEN AFTER THE SCAN, NOT BEFORE. A crash mid-scan then leaves the day
 * unmarked and the next tick redoes it, which every job here survives because
 * each one's per-record stamp makes a redo idempotent. Marking first would be
 * safe against a double send and would instead lose a whole day to any crash.
 *
 * A failed marker write is logged at `error` rather than thrown: the scan
 * already happened and its sends already landed, so failing the function here
 * would only add a retry of work that is done. The cost of the failure is one
 * extra scan on the next tick.
 */
export async function markRanToday(
  firestore: Firestore,
  functionName: string,
  fields: { dayIso: string; nowMs: number; hour: number; timeZone: string },
): Promise<void> {
  try {
    await firestore.doc(`${SCHEDULED_RUNS_COLLECTION}/${functionName}`).set(
      {
        lastRunDayIso: fields.dayIso,
        lastRunAtMs: fields.nowMs,
        hour: fields.hour,
        timeZone: fields.timeZone,
      },
      { merge: true },
    );
  } catch (err) {
    logEvent({
      severity: 'error',
      function: functionName,
      event: 'notification.schedule.marker.write.failed',
      errorMessage: (err as Error)?.message,
      extra: { dayIso: fields.dayIso, effect: 'next tick rescans; per-record stamps hold' },
    });
  }
}

/** What one tick did, for the caller's tests and nothing else. */
export interface TickResult {
  verdict: TickVerdict | 'read-failed';
  dayIso: string;
}

/**
 * ONE TICK OF AN HOUR-DRIVEN DAILY JOB, shared by the three that have one.
 *
 * The order of the four steps is the whole cost story and is not incidental:
 *
 *   1. read the settings once. The only unconditional read.
 *   2. decide, on the business zone's clock.
 *   3. only then read the marker.
 *   4. only then run `scan`, which drains a collection.
 *
 * A tick before the hour costs ONE document read. A tick after the hour costs
 * two. A daily job going hourly is 23 extra invocations a day, and this ordering
 * is what keeps all 23 of them at a read or two rather than at a full drain of
 * `invoices` or of the `bookings` collection group.
 *
 * `scan` is handed the business day the tick already resolved, so a matching tick
 * costs no more reads than the old daily run did: the settings read that
 * `runDay` used to perform inside each scan has moved up here.
 */
export async function runHourlyTick(args: {
  firestore: Firestore;
  functionName: string;
  nowMs: number;
  /** Which of the two hours on the settings document governs this job. */
  pickHour: (schedule: NotificationSchedule) => SendHour;
  scan: (dayIso: string) => Promise<void>;
}): Promise<TickResult> {
  const read = await loadNotificationSchedule(args.firestore, args.functionName);
  if (!read.ok) return { verdict: 'read-failed', dayIso: '' };

  const { timeZone } = read.schedule;
  const { hour, source } = args.pickHour(read.schedule);
  if (source === 'unusable') {
    logEvent({
      severity: 'warn',
      function: args.functionName,
      event: 'notification.schedule.hour.unusable',
      extra: { effect: 'job treated as not scheduled' },
    });
  }
  /**
   * THE SHIPPED STATE, and the cheapest branch there is: one settings read and
   * a return. No cadence means the operator has not switched this job on, so it
   * does nothing, on every tick of every day, whatever the collections hold.
   *
   * Nothing is logged for `unset`. Three jobs times 24 ticks is 72 lines a day
   * saying that a feature nobody has turned on is still off, which is how a log
   * stops being read.
   */
  if (hour === null) return { verdict: 'not-scheduled', dayIso: '' };

  const before = decideTick({ nowMs: args.nowMs, timeZone, hour, lastRunDayIso: null });
  if (before.verdict === 'clock-unresolved') {
    logEvent({
      severity: 'error',
      function: args.functionName,
      event: 'business.day.unresolved',
      extra: { now: args.nowMs, timeZone },
    });
    return { verdict: 'clock-unresolved', dayIso: '' };
  }
  if (before.verdict === 'before-hour') return { verdict: 'before-hour', dayIso: before.dayIso };

  const lastRunDayIso = await readLastRunDay(args.firestore, args.functionName);
  const decision = decideTick({ nowMs: args.nowMs, timeZone, hour, lastRunDayIso });
  if (decision.verdict !== 'run') return { verdict: decision.verdict, dayIso: decision.dayIso };

  await args.scan(decision.dayIso);
  await markRanToday(args.firestore, args.functionName, {
    dayIso: decision.dayIso,
    nowMs: args.nowMs,
    hour,
    timeZone,
  });
  logEvent({
    severity: 'info',
    function: args.functionName,
    event: 'notification.schedule.ran',
    extra: { dayIso: decision.dayIso, hour, localHour: decision.localHour, timeZone },
  });
  return { verdict: 'run', dayIso: decision.dayIso };
}
