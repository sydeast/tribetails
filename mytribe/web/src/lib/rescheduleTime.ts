import type { BookingMode, BusinessWeekdayHoursDto, GetBookingPolicyResult, TimeBlockDto } from '../api/bookingApi';
import { dateKey, initialBookingMode, OPEN_BLOCK_LEAD_MINUTES, parseDateKey, parseHourMinute, startOfDay } from './bookingWizardLogic';
/**
 * #1284: the pure half of the reschedule picker.
 *
 * The picker reuses the booking wizard's own pieces: the month grid
 * (`BookingMonthPicker`), the policy (`getBookingPolicy`), the closures
 * (`getBusinessClosures`), the block labels and the open-block lead. What it
 * adds is the arithmetic those pieces cannot do for a single proposed time:
 * turning a picked day and a time or block into an instant ON THE BUSINESS
 * CLOCK, and telling the household why a combination will not work before the
 * server says so. The server (`rescheduleTimeRules.ts`) stays the authority;
 * everything here is a courtesy that keeps a doomed request from being sent.
 */
/** The ruled default zone (#1109), used only when an older server returns none. */
export const FALLBACK_TIME_ZONE = 'America/Chicago';
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Offset (ms) of `timeZone` from UTC at the instant `ms`: wall clock read as UTC, minus the instant. */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(ms / 1000) * 1000;
}
/**
 * The instant at which the wall clock in `timeZone` reads `hhmm` on the
 * calendar day `dayKey` (`YYYY-MM-DD`), or null when either does not parse.
 * `24:00` is the next midnight. Two passes, so a day that crosses a daylight
 * saving change still lands on the right side of it.
 */
export function zonedWallClockToMs(dayKey: string, hhmm: string, timeZone: string): number | null {
  const day = parseDateKey(dayKey);
  if (day === null) return null;
  const hm = hhmm.trim() === '24:00' ? { hour: 24, minute: 0 } : parseHourMinute(hhmm);
  if (hm === null) return null;
  const wallAsUtc = Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), hm.hour, hm.minute);
  try {
    let ms = wallAsUtc - zoneOffsetMs(wallAsUtc, timeZone);
    ms = wallAsUtc - zoneOffsetMs(ms, timeZone);
    return ms;
  } catch {
    return null;
  }
}
/** Padded `HH:mm` so plain string comparison orders times. */
function padHHmm(v: string): string {
  const [h = '', m = ''] = v.split(':');
  return `${h.padStart(2, '0')}:${m}`;
}
function weekdayOf(day: Date): number {
  return day.getDay();
}
/**
 * The picker's closed-day map: the company closures `getBusinessClosures`
 * returned, plus every date in the horizon that falls on a weekday the
 * business is shut. Same shape as the wizard's `closedDates`, so the shared
 * month grid needs no new prop.
 */
export function closedDaysFor(
  closures: ReadonlyMap<string, string>,
  weekly: readonly BusinessWeekdayHoursDto[] | undefined,
  today: Date,
  horizonDays: number,
): Map<string, string> {
  const out = new Map(closures);
  const closedWeekdays = new Set((weekly ?? []).filter((d) => !d.open).map((d) => d.weekday));
  if (closedWeekdays.size === 0) return out;
  const start = startOfDay(today);
  for (let i = 0; i <= horizonDays; i += 1) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = dateKey(d);
    if (closedWeekdays.has(weekdayOf(d)) && !out.has(key)) out.set(key, `${WEEKDAY_NAMES[weekdayOf(d)]}s`);
  }
  return out;
}
/** The weekday's hours, or null when the business has none on file (no restriction known). */
export function hoursOn(day: Date, weekly: readonly BusinessWeekdayHoursDto[] | undefined): BusinessWeekdayHoursDto | null {
  if (!weekly || weekly.length !== 7) return null;
  return weekly.find((d) => d.weekday === weekdayOf(day)) ?? null;
}
/** Which ways of saying WHEN this visit can use, and the one to open on. */
export function rescheduleModes(
  policy: Pick<GetBookingPolicyResult, 'allowTimeBlockBooking' | 'allowSpecificTimeBooking' | 'defaultBookingMode' | 'startTimeServiceIds'>,
  serviceId: string | null,
): { modes: BookingMode[]; initial: BookingMode } {
  // #1092: a start-time KinCare books by the clock whatever the switches say.
  if (serviceId !== null && (policy.startTimeServiceIds ?? []).includes(serviceId)) {
    return { modes: ['SPECIFIC_TIME'], initial: 'SPECIFIC_TIME' };
  }
  const initial = initialBookingMode(policy);
  const modes: BookingMode[] = [];
  if (policy.allowTimeBlockBooking) modes.push('TIME_BLOCK');
  if (policy.allowSpecificTimeBooking) modes.push('SPECIFIC_TIME');
  return modes.length > 0 ? { modes, initial } : { modes: ['SPECIFIC_TIME'], initial: 'SPECIFIC_TIME' };
}
export interface BlockChoice {
  block: TimeBlockDto;
  /** The instant the request is carried on: the block's first minute, or a little after now for a block already open today. */
  startMs: number;
}
const OPEN_BLOCK_STEP_MS = 5 * 60_000;
/**
 * The blocks still bookable on `dayKey`, each with the instant to send.
 *
 * Mirrors `anchorOpenBlockVisit` (the wizard's rule for a block that has
 * already opened today) on the business clock: a block whose first minute has
 * passed starts a little after now if that still fits before it closes, and is
 * dropped otherwise.
 */
export function blockChoices(dayKey: string, blocks: readonly TimeBlockDto[], nowMs: number, timeZone: string): BlockChoice[] {
  const out: BlockChoice[] = [];
  for (const block of blocks) {
    const firstMs = zonedWallClockToMs(dayKey, block.startTime, timeZone);
    const endMs = zonedWallClockToMs(dayKey, block.endTime, timeZone);
    if (firstMs === null || endMs === null) continue;
    if (firstMs > nowMs) {
      out.push({ block, startMs: firstMs });
      continue;
    }
    const earliest = nowMs + OPEN_BLOCK_LEAD_MINUTES * 60_000;
    const anchored = Math.ceil(earliest / OPEN_BLOCK_STEP_MS) * OPEN_BLOCK_STEP_MS;
    if (anchored < endMs) out.push({ block, startMs: anchored });
  }
  return out;
}
export interface RescheduleProposal {
  startMs: number;
  timeBlockId: string | null;
}
export interface ProposalInput {
  dayKey: string | null;
  mode: BookingMode;
  /** `HH:MM`, for a clock time. */
  time: string;
  blockId: string | null;
  blocks: readonly TimeBlockDto[];
  weekly: readonly BusinessWeekdayHoursDto[] | undefined;
  timeZone: string;
  nowMs: number;
  /** True for a start-time KinCare (#1092), which the weekly hours do not bound. */
  startTimeService: boolean;
}
/**
 * The proposal to send, or why there is none yet. `problem` is null while the
 * household simply has not finished choosing.
 */
export function resolveProposal(input: ProposalInput): { proposal: RescheduleProposal | null; problem: string | null } {
  const none = { proposal: null, problem: null };
  if (input.dayKey === null) return none;
  const day = parseDateKey(input.dayKey);
  if (day === null) return none;
  if (input.mode === 'TIME_BLOCK') {
    const choice = blockChoices(input.dayKey, input.blocks, input.nowMs, input.timeZone).find((c) => c.block.id === input.blockId);
    if (input.blockId === null) return none;
    if (!choice) return { proposal: null, problem: 'That block has already passed on this day. Pick a later block or another day.' };
    return { proposal: { startMs: choice.startMs, timeBlockId: choice.block.id }, problem: null };
  }
  if (parseHourMinute(input.time) === null) return none;
  const hours = hoursOn(day, input.weekly);
  if (hours && !input.startTimeService) {
    const t = padHHmm(input.time);
    if (hours.open && hours.startTime !== null && hours.endTime !== null && (t < hours.startTime || t >= hours.endTime)) {
      return {
        proposal: null,
        problem: `We are open ${hours.startTime} to ${hours.endTime} on ${WEEKDAY_NAMES[hours.weekday]}s. Pick a time inside those hours.`,
      };
    }
  }
  const startMs = zonedWallClockToMs(input.dayKey, input.time, input.timeZone);
  if (startMs === null) return none;
  return { proposal: { startMs, timeBlockId: null }, problem: null };
}
