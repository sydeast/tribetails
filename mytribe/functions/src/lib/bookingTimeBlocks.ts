import { zonedNow } from './businessHours';

/**
 * TIME-BLOCK BOOKING: the availability half of `business_settings`.
 *
 * Operator requirement, 2026-08-24, stated directly: "kinfolk book within time
 * blocks, not at a specific set time. I need to be able to create these time
 * blocks and those are what the kinfolk should be able to select from when
 * booking."
 *
 * ── THE TWO THINGS THAT ARE NOT THE SAME THING ───────────────────────────────
 *
 * `business_settings.timeBlocks` is BOOKABLE availability: named windows
 * ("Midday", 11:00-15:00) a household picks BY NAME instead of by clock. That
 * is what this module reads.
 *
 * The `booking_time_slots` COLLECTION is the opposite: block-OUT time, written
 * by `admin/createBlockedTimeSlot.ts` and the Google Calendar busy importer,
 * and treated as unavailable by `lib/bookingBusyConflict.ts`. Nothing in this
 * file touches it, and nothing in it belongs here. The names are one letter
 * apart and the meanings are inverted; keep them apart.
 *
 * ── WHY THE NORMALIZATION LIVES IN ONE FUNCTION ──────────────────────────────
 *
 * Two consumers ask the same question: `portal/getBookingPolicy.ts` (what may
 * this household choose from) and `portal/requestBooking.ts` (may it send what
 * it just sent). If those two read the raw `business_settings` fields
 * separately they can disagree — a portal told "specific times are fine" by one
 * reader and refused by the other is a household staring at a refusal for a
 * control the app itself offered. So {@link resolveBookingPolicy} is the ONLY
 * decoder, both callables run it, and every degrade decision below is taken
 * once, server-side, rather than re-derived per client.
 *
 * ── THE ROWS ARE NOT VALIDATED ANYWHERE ELSE ─────────────────────────────────
 *
 * `auntieos-admin/src/api/settings.ts` types every string on
 * `TimeBlockDefinition` as optional ON PURPOSE, because `mergeBusinessSettings`
 * checks that `timeBlocks` IS an array and never inspects a row inside it. A
 * legacy or hand-edited row carrying only `{ id: 'midday' }` therefore reaches
 * this module, and the admin comment says exactly what happens next: it "throws
 * on the first `.trim()`". {@link parseTimeBlockRow} is the guard that comment
 * asks for. It never throws and it never guesses a window it cannot read.
 */

/** How a household chose the WHEN of a visit. Wire values, as stored in `business_settings`. */
export type BookingMode = 'SPECIFIC_TIME' | 'TIME_BLOCK';

/**
 * One bookable window, as a household is allowed to see it.
 *
 * Every field is REQUIRED here, which is the whole point of the type: an
 * unreadable stored row does not become a `BookableTimeBlock` with blank
 * strings in it, it becomes `null` and is dropped. `startTime`/`endTime` are
 * `HH:MM` in the BUSINESS's timezone, and `endTime` is always strictly later.
 */
export interface BookableTimeBlock {
  id: string;
  label: string;
  /** `HH:MM`, business-local, inclusive. */
  startTime: string;
  /**
   * `HH:MM`, business-local, exclusive — same convention as the admin
   * `resolveTimeBlock`. `"24:00"` for a window running to the end of the day,
   * which is a boundary rather than a clock time; read it with
   * {@link parseDayBoundaryHHmm}, never {@link parseHHmm}.
   */
  endTime: string;
  /** `endTime - startTime`, so a client can say how long the window is without re-parsing. */
  durationMinutes: number;
}

/**
 * The booking policy as the portal is allowed to know it.
 *
 * THIS IS THE WHOLE PROJECTION THAT CROSSES THE KINFOLK BOUNDARY. Nothing else
 * off `business_settings` may be added to it without deciding, in writing, that
 * a household should see it: the doc also carries rates, integration state,
 * notification toggles, GPS policy and retention windows, and
 * `getBusinessClosures.ts` exists precisely because the raw doc is admin-only
 * in `firestore.rules`.
 */
export interface BookingPolicy {
  /** Whether a household may pick a NAMED window. False when there is nothing usable to pick. */
  allowTimeBlockBooking: boolean;
  /** Whether a household may pick an arbitrary clock time. */
  allowSpecificTimeBooking: boolean;
  /** Which mode a wizard opens on. Always one this policy actually allows. */
  defaultBookingMode: BookingMode;
  /** The active, readable windows, in start order. Empty iff `allowTimeBlockBooking` is false. */
  timeBlocks: BookableTimeBlock[];
}

/** Why `resolveBookingPolicy` had to override what the operator stored. Logged, never shown. */
export type BookingPolicyDegrade =
  /** `allowTimeBlockBooking` was on but no row survived {@link parseTimeBlockRow}. */
  | 'no-usable-blocks'
  /** Both switches were off, which no screen can render. */
  | 'no-mode-allowed'
  /** `defaultBookingMode` named a mode this business does not allow. */
  | 'default-mode-unavailable';

export interface ResolvedBookingPolicy {
  policy: BookingPolicy;
  /** Empty when the stored settings were internally consistent. */
  degrades: BookingPolicyDegrade[];
}

const HHMM_RE = /^(\d{1,2}):(\d{2})$/;

/** The last minute a WALL CLOCK can show, 23:59. */
const LAST_MINUTE_OF_DAY = 24 * 60 - 1;
/** The end of the day as an EXCLUSIVE boundary, 24:00. Not a time any clock shows. */
const END_OF_DAY = 24 * 60;

/**
 * TWO KINDS OF `HH:MM`, AND WHY THEY NEED TWO PARSERS (#596).
 *
 * A WALL-CLOCK TIME is what `zonedNow` reports and what a block STARTS at: it
 * runs 00:00-23:59, and "24:00" is not one of its values. An EXCLUSIVE END
 * BOUNDARY is what a block ENDS at: a window running to the end of the day ends
 * at 24:00, and 23:59 would be a different, shorter window.
 *
 * One parser for both is the defect #596 found. `formatHHmm` clamped to
 * `24 * 60` and emitted `"24:00"` for a block ending at midnight, `parseHHmm`
 * rejected any hour above 23 and returned null for it, so a string the server
 * had just generated failed the server's own parser and `visitMatchesBlock`
 * answered `zone-unusable` — a "cannot tell" that `assertVisitBookingMode` lets
 * through. Containment stopped running for that block entirely.
 *
 * So there are two pairs now, and each round-trips losslessly across its whole
 * range (asserted as a property in `test/bookingTimeBlocks.test.ts`, because
 * that property is what would have caught this):
 *
 *   parseHHmm            <-> formatHHmm             0..1439  ("00:00".."23:59")
 *   parseDayBoundaryHHmm <-> formatDayBoundaryHHmm  0..1440  ("00:00".."24:00")
 *
 * `parseHHmm` deliberately still rejects "24:00": a clock never shows it, a
 * block may not START at it, and `zonedNow` (`hourCycle: 'h23'`) never emits it.
 */

/** Minutes since local midnight for a bare wall-clock `HH:MM`, or null. Never throws, whatever `raw` is. */
export function parseHHmm(raw: unknown): number | null {
  return parseMinutesOfDay(raw, LAST_MINUTE_OF_DAY);
}

/**
 * Minutes since local midnight for an EXCLUSIVE end boundary, or null. Accepts
 * everything {@link parseHHmm} does, plus exactly `"24:00"` -> 1440.
 */
export function parseDayBoundaryHHmm(raw: unknown): number | null {
  return parseMinutesOfDay(raw, END_OF_DAY);
}

function parseMinutesOfDay(raw: unknown, maxMinutes: number): number | null {
  if (typeof raw !== 'string') return null;
  const m = HHMM_RE.exec(raw.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
  if (hh < 0 || mm < 0 || mm > 59) return null;
  const total = hh * 60 + mm;
  return total > maxMinutes ? null : total;
}

/** Minutes since midnight back to a wall-clock `HH:MM`, zero-padded. Clamped to 00:00-23:59. */
export function formatHHmm(minutes: number): string {
  return padHHmm(Math.max(0, Math.min(LAST_MINUTE_OF_DAY, Math.round(minutes))));
}

/** Minutes since midnight back to an exclusive end boundary, zero-padded. Clamped to 00:00-24:00. */
export function formatDayBoundaryHHmm(minutes: number): string {
  return padHHmm(Math.max(0, Math.min(END_OF_DAY, Math.round(minutes))));
}

function padHHmm(clamped: number): string {
  const hh = Math.floor(clamped / 60);
  const mm = clamped % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** 'midday' -> 'Midday', 'late-afternoon' -> 'Late Afternoon'. Only used when a row has no label. */
function labelFromId(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * One stored row -> one bookable window, or null when the row cannot be read.
 *
 * NEVER THROWS. That is the contract the admin `TimeBlockDefinition` comment
 * asks for: a row is raw Firestore data that nothing has validated, so
 * `{ id: 'midday' }`, `{}`, `null`, a string, and a row whose `endTime` is
 * before its `startTime` all arrive here and all leave as `null`.
 *
 * TWO DELIBERATE RECOVERIES, and only two:
 *   - a row with a usable `startTime` and NO readable `endTime` takes its end
 *     from `defaultBlockDurationMinutes` — the companion
 *     `business_settings.defaultTimeBlockDurationHours` field exists for
 *     exactly this, and a 4-hour window from a stated start is a far more
 *     honest reading of the operator's intent than dropping the block.
 *   - a row with no `label` is named from its id, because a picker that offers
 *     an unnamed button is the empty-picker failure in miniature.
 * A row with no readable START is NOT recovered: there is nothing to guess
 * from, and inventing one would put a household in front of a window the
 * business never said it keeps.
 *
 * `active` is the wire key (Kotlin's `TimeBlockDefinition.isActive` carries
 * `@SerialName("active")`). Only `active === false` deactivates: a legacy row
 * with the key missing is treated as active, matching the admin defaults where
 * the field is written on every row.
 */
export function parseTimeBlockRow(raw: unknown, defaultBlockDurationMinutes: number): BookableTimeBlock | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (row['active'] === false) return null;

  const id = typeof row['id'] === 'string' ? row['id'].trim() : '';
  if (id.length === 0) return null;

  // A START is a wall-clock time: 24:00 is not one, and a row claiming it has
  // no readable start.
  const startMinutes = parseHHmm(row['startTime']);
  if (startMinutes === null) return null;

  // An END is an exclusive boundary, so 24:00 IS one — that is a window running
  // to the end of the day, and it is the case #596 was lost on.
  const parsedEnd = parseDayBoundaryHHmm(row['endTime']);
  const fallbackEnd = startMinutes + Math.max(1, Math.round(defaultBlockDurationMinutes));
  const endMinutes = parsedEnd !== null && parsedEnd > startMinutes ? parsedEnd : Math.min(END_OF_DAY, fallbackEnd);
  if (endMinutes <= startMinutes) return null;

  const startTime = formatHHmm(startMinutes);
  const endTime = formatDayBoundaryHHmm(endMinutes);
  // THE INVARIANT, ENFORCED AT THE ONLY DOOR (#596). `BookableTimeBlock`'s
  // contract is that its times are parseable, and every consumer — the
  // containment check above all — is written as if that holds. It is asserted
  // here rather than assumed, so a future change to either formatter turns into
  // a dropped row (which `resolveBookingPolicy` degrades honestly) instead of
  // an enforcement check that silently stops running.
  if (parseHHmm(startTime) !== startMinutes || parseDayBoundaryHHmm(endTime) !== endMinutes) return null;

  const rawLabel = typeof row['label'] === 'string' ? row['label'].trim() : '';
  return {
    id,
    label: rawLabel.length > 0 ? rawLabel : labelFromId(id),
    startTime,
    endTime,
    durationMinutes: endMinutes - startMinutes,
  };
}

/** `business_settings.defaultTimeBlockDurationHours` -> minutes, with the doc default (4h) as the floor case. */
function defaultBlockMinutes(raw: unknown): number {
  const hours = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 4;
  return Math.round(hours * 60);
}

function boolOr(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

/**
 * THE ONE DECODER. Turns the raw `business_settings` document into a policy
 * that is internally consistent by construction, plus the list of overrides it
 * had to apply to get there.
 *
 * The three switches (`allowTimeBlockBooking`, `allowSpecificTimeBooking`,
 * `defaultBookingMode`) have shipped on the doc for months and are read by
 * NOTHING — no server code, no portal code. This function is the first reader,
 * so the degrade rules are decisions, not precedent, and they are stated here
 * rather than spread across two callables and two clients:
 *
 *  1. BLOCK BOOKING ON, NO USABLE BLOCK -> block booking is served OFF. An
 *     operator who has not configured a window, or whose only rows are
 *     unreadable, must not produce a picker with nothing in it. This is the
 *     "degrade to something honest rather than an empty picker" rule, taken
 *     once, on the server, so neither client has to have an opinion.
 *  2. NEITHER MODE ALLOWED -> specific-time booking is served ON. Two false
 *     booleans is a misconfiguration, not an instruction: there is no
 *     "bookings are closed" setting on this document, and the closest real one
 *     (`companyHolidays`) is a different field with a different callable. Fail
 *     safe means the household can still ask; it does not mean the wizard
 *     shows a dead screen. Specific-time is the mode that needs no
 *     configuration at all, which is why it is the one we fall back to.
 *  3. DEFAULT MODE UNAVAILABLE -> the default becomes whichever mode survived
 *     rules 1 and 2. A wizard cannot open on a mode it may not use.
 */
export function resolveBookingPolicy(settings: unknown): ResolvedBookingPolicy {
  const data = (settings && typeof settings === 'object' ? settings : {}) as Record<string, unknown>;
  const degrades: BookingPolicyDegrade[] = [];

  const blockMinutes = defaultBlockMinutes(data['defaultTimeBlockDurationHours']);
  const rawRows = Array.isArray(data['timeBlocks']) ? (data['timeBlocks'] as unknown[]) : [];
  const timeBlocks = rawRows
    .map((row) => parseTimeBlockRow(row, blockMinutes))
    .filter((b): b is BookableTimeBlock => b !== null)
    .sort((a, b) => (a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : a.id.localeCompare(b.id)));

  let allowTimeBlockBooking = boolOr(data['allowTimeBlockBooking'], true);
  let allowSpecificTimeBooking = boolOr(data['allowSpecificTimeBooking'], true);

  if (allowTimeBlockBooking && timeBlocks.length === 0) {
    allowTimeBlockBooking = false;
    degrades.push('no-usable-blocks');
  }
  if (!allowTimeBlockBooking && !allowSpecificTimeBooking) {
    allowSpecificTimeBooking = true;
    degrades.push('no-mode-allowed');
  }

  const storedMode = data['defaultBookingMode'];
  let defaultBookingMode: BookingMode = storedMode === 'TIME_BLOCK' ? 'TIME_BLOCK' : 'SPECIFIC_TIME';
  const modeAllowed =
    defaultBookingMode === 'TIME_BLOCK' ? allowTimeBlockBooking : allowSpecificTimeBooking;
  if (!modeAllowed) {
    defaultBookingMode = allowTimeBlockBooking ? 'TIME_BLOCK' : 'SPECIFIC_TIME';
    degrades.push('default-mode-unavailable');
  }

  return {
    policy: {
      allowTimeBlockBooking,
      allowSpecificTimeBooking,
      defaultBookingMode,
      // Empty iff block booking is off, so a client never has to reconcile the
      // two: an allowed mode always has something to offer.
      timeBlocks: allowTimeBlockBooking ? timeBlocks : [],
    },
    degrades,
  };
}

/** The block with this id, or null. Ids are compared trimmed, never case-folded. */
export function findTimeBlock(policy: BookingPolicy, id: string): BookableTimeBlock | null {
  const wanted = id.trim();
  return policy.timeBlocks.find((b) => b.id === wanted) ?? null;
}

/**
 * What {@link visitMatchesBlock} concluded.
 *
 * `zone-unusable` is a "cannot tell", never a "no". `block-unreadable` IS a no —
 * see {@link visitMatchesBlock} for why the two are not the same answer.
 */
export type BlockMatch = 'inside' | 'outside' | 'zone-unusable' | 'block-unreadable';

/**
 * Does this instant fall inside the block's window, read on the BUSINESS's own
 * wall clock?
 *
 * CONTAINMENT, NOT EQUALITY, and start-inclusive / end-exclusive — the exact
 * semantics `auntieos-admin`'s `resolveTimeBlock` already uses to LABEL a
 * session with its block. Matching that matters more than being strict: the
 * admin app decides which block a visit is in by containment, so a validator
 * that demanded `startTimeMs` land exactly on the window's first minute would
 * accept a narrower set than the surface that reads it back.
 *
 * The clients build `startTimeMs` from the DEVICE's zone, and a household is
 * not always sitting in the business's. Containment over a multi-hour window
 * absorbs the ordinary case of that drift; equality would refuse it outright.
 *
 * ── TWO FAILURES THAT ARE NOT THE SAME FAILURE (#596) ────────────────────────
 *
 * `timeZone` unusable (blank, or an IANA name `Intl` rejects) returns
 * `zone-unusable` rather than a verdict. Callers treat that as "cannot tell"
 * and let the request through on the window check alone — the SAME fail-open
 * posture `lib/businessHours.ts` argues for at length, and for the same reason:
 * a wrong refusal costs a household a booking they were entitled to make, while
 * a visit landing an hour off inside a 4-hour window costs the office nothing
 * they cannot see, because the block id is persisted on the visit either way.
 * The id/active checks are NOT skipped: those we can always answer.
 *
 * A BLOCK whose own `startTime`/`endTime` will not parse is the opposite case
 * and gets its own answer, `block-unreadable`. Nothing about it is unknown from
 * the household's side: the server generated those two strings itself, in
 * {@link parseTimeBlockRow}, so an unreadable one is a bug in this file rather
 * than configuration the operator never filled in. Failing open on it is how
 * #596 turned a formatter/parser mismatch into an enforcement check that
 * silently stopped running, and callers must refuse instead. In practice this
 * is unreachable — {@link parseTimeBlockRow} re-parses what it emits and drops
 * the row otherwise — which is exactly the point: it is a tripwire, not a path.
 */
export function visitMatchesBlock(
  startTimeMs: number,
  block: BookableTimeBlock,
  timeZone: string,
): BlockMatch {
  // The block is checked FIRST, so a server-side defect is never reported as a
  // household-side unknown even when the zone is also unusable.
  const start = parseHHmm(block.startTime);
  const end = parseDayBoundaryHHmm(block.endTime);
  if (start === null || end === null || end <= start) return 'block-unreadable';

  const local = zonedNow(startTimeMs, timeZone);
  if (local === null) return 'zone-unusable';
  const minutes = parseHHmm(local.timeHHmm);
  if (minutes === null) return 'zone-unusable';
  return minutes >= start && minutes < end ? 'inside' : 'outside';
}

/** `business_settings.timeZone`, trimmed, or '' when the field is missing or not a string. */
export function businessTimeZone(settings: unknown): string {
  const data = (settings && typeof settings === 'object' ? settings : {}) as Record<string, unknown>;
  return typeof data['timeZone'] === 'string' ? (data['timeZone'] as string).trim() : '';
}

/**
 * The BUSINESS's own calendar date (`YYYY-MM-DD`) for an instant.
 *
 * #597: the identity of a block-mode visit is (date, KinCare, block), and the
 * date has to be the business's, not the raw instant and not the device's. The
 * whole premise of block booking is that the instant is approximate — every
 * visit in a window carries that window's first minute — so two visits in the
 * same block on the same BUSINESS day must still collide while different days
 * must not, and only the business's day boundary answers that.
 *
 * WHEN THE ZONE IS UNUSABLE we fall back to the UTC calendar date rather than
 * refusing to key at all, for three reasons:
 *   - it is deterministic and total, so the duplicate rule keeps running rather
 *     than quietly switching itself off — which is the failure mode #596 is
 *     about, and repeating it here would be worse than a slightly wrong day;
 *   - the refusal it must never lose is the SAME KinCare at the SAME instant,
 *     and identical `startTimeMs` values always produce the identical UTC date,
 *     whatever the zone is. That case is preserved exactly;
 *   - the case it could get wrong is two visits the business considers
 *     different days landing on one UTC date, which needs them under 24h apart;
 *     block-mode visits on different dates are a whole day apart by
 *     construction, since both clients build them from the same block start.
 * A blank zone is also loud at the call site — see `containmentIsInert`.
 */
export function businessCalendarDate(startTimeMs: number, timeZone: string): string {
  const local = zonedNow(startTimeMs, timeZone);
  if (local !== null) return local.dateIso;
  if (!Number.isFinite(startTimeMs)) return 'unknown-date';
  return new Date(startTimeMs).toISOString().slice(0, 10);
}

/**
 * Is time-block CONTAINMENT switched off by a timezone this server cannot read?
 *
 * `visitMatchesBlock` fails open on an unusable zone, on purpose, and that
 * decision stands. What must not stand is it happening SILENTLY: with a blank
 * or invalid `business_settings.timeZone` the containment check returns
 * `zone-unusable` for every block, so rule 4 of `assertVisitBookingMode` — a
 * client cannot send an arbitrary time under a block's name — is not running at
 * all, for anyone. That is an enforcement control being off, and nobody would
 * otherwise find out. Callers log it by name.
 *
 * Only meaningful where blocks are actually bookable, which is why the policy is
 * a parameter: a business that takes no block bookings has no containment to
 * lose.
 */
export function containmentIsInert(policy: BookingPolicy, timeZone: string): boolean {
  if (!policy.allowTimeBlockBooking) return false;
  // The exact predicate containment itself uses, so the two cannot drift: blank
  // and "not an IANA name Intl knows" are both covered, and neither is guessed at.
  return zonedNow(Date.now(), timeZone) === null;
}
