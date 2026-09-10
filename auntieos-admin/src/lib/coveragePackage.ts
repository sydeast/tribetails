/**
 * Coverage Package Builder — pure domain logic.
 *
 * Full port of the canonical `PackageBuilder_7` sketch. An operator prices a
 * multi-day pet-sitting stay by BUILDING one or more named packages: each package
 * is a template of visits (any mix of lengths/times), with per-night overnights,
 * an optional per-day override, and an optional discount. Suggestions seed a
 * package from a rule (Lean / Balanced / Generous); every seeded visit is then
 * freely editable — there is no requirement for a pinned visit or an auto-filled
 * gap, so an operator can simply pick services for a client.
 *
 * Pricing rules that make this more than a sum:
 *  - An overnight is a WINDOW, not a line item. A visit inside the overnight
 *    window (or its arrival buffer) is already covered → priced $0.
 *  - Booking an overnight earns ONE free visit the next day, stacked on top of
 *    the window coverage.
 *
 * This file is pure and unit-tested; the screen and its Android twin
 * (`domain/CoveragePackage.kt`) render it. Keep the two behaviour-identical.
 *
 * WHERE THE MENU COMES FROM (issue #693). The service lengths and prices are the
 * operator's KinCare types, `business_settings.serviceRates` plus
 * `serviceDurations`, edited in Settings and already read by Schedule, the
 * new-visit dialog and SessionDetail. `durationsFromServiceRates` below is the
 * one adapter. The Packages screen used to keep a second rate card of its own in
 * `coverage_package_config/config`; that panel is gone, and with it the chance of
 * quoting a price Settings never agreed to.
 */

import { serviceOptionsFromRates } from './newBooking';

// ── model ───────────────────────────────────────────────────────────────────

export type DurationKind = 'visit' | 'overnight';

/** A named service length with its price. `kind` splits day visits from overnights. */
export interface Duration {
  readonly id: string;
  readonly label: string;
  readonly minutes: number;
  readonly price: number;
  readonly kind: DurationKind;
}

/** A visit that must happen at a fixed time every covered day (client non-negotiable). */
export interface PinnedTime {
  readonly id: string;
  readonly label: string;
  /** "HH:MM", 24h. */
  readonly time: string;
  readonly durationId: string;
}

/** Per-client coverage rules — seed the suggestion generator, not a hard gate. */
export interface CoverageRules {
  readonly wakeStart: string;
  readonly wakeEnd: string;
  readonly maxGapHours: number;
  readonly pinnedTimes: readonly PinnedTime[];
}

/** One scheduled visit inside a package. `time` is minutes since midnight. */
export interface Visit {
  readonly id: string;
  readonly time: number;
  readonly durationId: string;
  readonly label: string;
}

/** A named package: a visit template + per-night overnights + optional per-day overrides. */
export interface Package {
  readonly id: string;
  readonly name: string;
  /** The template — applies to every day that isn't customized. */
  readonly visits: readonly Visit[];
  /** `{ [dayIndex]: Visit[] }` — a day's own schedule, replacing the template. */
  readonly dayOverrides: Readonly<Record<number, readonly Visit[]>>;
  /** `{ [nightIndex]: true }` — which nights get an overnight. */
  readonly overnightNights: Readonly<Record<number, boolean>>;
  readonly overnightStart: string;
  readonly overnightBufferHours: number;
  readonly discountLabel: string;
  readonly discountPct: number;
}

/** One visit inside a generated SUGGESTION (pinned or gap-filling check-in). */
export interface Touchpoint {
  readonly type: 'pinned' | 'flex';
  readonly label: string;
  readonly time: number;
  readonly durationId: string;
  readonly durationLabel: string;
  readonly price: number;
}

/** A suggested day schedule at one price point (a seed for a new package). */
export interface DayPattern {
  readonly id: string;
  readonly strategyLabel: string;
  readonly touchpoints: readonly Touchpoint[];
  readonly dayTotal: number;
  readonly signature: string;
}

/** What an overnight covers on a given day. */
export interface Coverage {
  /** Minutes since midnight from which tonight's overnight (incl. buffer) covers. */
  readonly eveningFrom: number | null;
  /** Minutes since midnight until which last night's overnight covers this morning. */
  readonly morningUntil: number | null;
  /** True when the prior night had an overnight → one free visit today. */
  readonly bonusFreeVisit: boolean;
}

const BARE_COVERAGE: Coverage = { eveningFrom: null, morningUntil: null, bonusFreeVisit: false };

/** One priced visit line. */
export interface PricedItem {
  readonly key: string;
  readonly time: number;
  readonly label: string;
  readonly durationLabel: string;
  readonly price: number;
  readonly listPrice: number;
  readonly covered: boolean;
  readonly bonus: boolean;
  readonly free: boolean;
  readonly freeReason: string | null;
}

/** One priced day of the stay. */
export interface PricedDayRow {
  readonly dayIndex: number;
  readonly items: readonly PricedItem[];
  readonly customized: boolean;
  readonly canOvernight: boolean;
  readonly isOvernight: boolean;
  readonly overnightCost: number;
  readonly overnightLabel: string;
  readonly overnightStartMin: number | null;
  readonly coverage: Coverage;
  readonly dayCost: number;
}

/** A fully priced package across the stay. */
export interface PricedPackage {
  readonly rows: readonly PricedDayRow[];
  readonly subtotal: number;
  readonly discountPct: number;
  readonly discount: number;
  readonly total: number;
}

/** Context needed to price a package. */
export interface PriceContext {
  readonly days: number;
  readonly nights: number;
  readonly durations: readonly Duration[];
  readonly overnightDuration: Duration | undefined;
}

// ── defaults ────────────────────────────────────────────────────────────────

/** The shipped default menu. Only the 12hr is a true overnight; the 2hr and 6hr
 *  are long daytime stays (they can fill gaps, so "Generous" reaches for the 6hr). */
export const DEFAULT_DURATIONS: readonly Duration[] = [
  { id: 'd1', label: '15-min visit', minutes: 15, price: 15, kind: 'visit' },
  { id: 'd2', label: '30-min visit', minutes: 30, price: 25, kind: 'visit' },
  { id: 'd3', label: '45-min visit', minutes: 45, price: 35, kind: 'visit' },
  { id: 'd4', label: '60-min visit', minutes: 60, price: 45, kind: 'visit' },
  { id: 'd5', label: '90-min visit', minutes: 90, price: 60, kind: 'visit' },
  { id: 'd6', label: '2-hour visit', minutes: 120, price: 80, kind: 'visit' },
  { id: 'd8', label: '6-hour visit', minutes: 360, price: 100, kind: 'visit' },
  { id: 'd7', label: 'Overnight (12hr)', minutes: 720, price: 150, kind: 'overnight' },
];

/** Durations saved before `kind` existed carry no type. d7 was the only real
 *  overnight ever shipped, so everything else migrates to a visit — length is not
 *  a reliable signal (a 6hr stay is a visit, a 12hr is not). */
const LEGACY_OVERNIGHT_IDS = new Set<string>(['d7']);

export function withKind(list: readonly Partial<Duration>[]): Duration[] {
  return list.map((d) => ({
    id: d.id ?? uid(),
    label: d.label ?? '',
    minutes: d.minutes ?? 0,
    price: d.price ?? 0,
    kind: d.kind ?? (LEGACY_OVERNIGHT_IDS.has(d.id ?? '') ? 'overnight' : 'visit'),
  }));
}

/**
 * True when a KinCare type's NAME says it is an overnight.
 *
 * `serviceRates` carries a name, a length and a price, and nothing else: there
 * is no `kind` column for the operator to set, so the name is the only signal
 * there is. Substring-matching "overnight" in a lowercased service name is the
 * rule `denFormat.ts` and `DenScreenKit.tsx` already colour sessions by, so a
 * type reads the same way on the calendar and here. Length is deliberately NOT
 * a signal: a 6-hour day stay is a visit, a 12-hour stay is not.
 */
export function isOvernightServiceName(name: string): boolean {
  return name.toLowerCase().includes('overnight');
}

/**
 * The operator's KinCare types, read as the package builder's menu.
 *
 * `rates` is `business_settings.serviceRates` (`Record<name, price-as-string>`)
 * and `durations` is the parallel `business_settings.serviceDurations`
 * (`Record<name, minutes-as-string>`). `serviceOptionsFromRates` does the reading
 * and the duration precedence (stated minutes first, then the length parsed out
 * of the name), so this stays the one place that maps a KinCare type onto a
 * `Duration`.
 *
 * The service NAME is the id. Names are the key `serviceRates` is stored under
 * and the canonical value every other reader sends, so a visit that points at
 * "Overnight" keeps pointing at it when Settings changes its price.
 *
 * A type with no stated or parseable length gets 0 minutes: it still prices, and
 * only the overnight-coverage window and the gap-filling spacing care about
 * length. A blank price reads as 0, which keeps the type pickable and leaves it
 * out of the tier generator (which only fills with priced visits).
 */
export function durationsFromServiceRates(
  rates: Record<string, string>,
  durations: Record<string, string> = {},
): Duration[] {
  return serviceOptionsFromRates(rates, durations).map((option) => ({
    id: option.name,
    label: option.name,
    minutes: option.durationMinutes ?? 0,
    price: Number(option.rate) || 0,
    kind: isOvernightServiceName(option.name) ? 'overnight' : 'visit',
  }));
}

/**
 * Repoint any pinned visit whose length no longer exists onto the first visit
 * type in the menu (or onto nothing, when the menu has no visit type).
 *
 * The builder's menu used to be its own list with its own synthetic ids
 * (`d1`…`d8`); it is now the KinCare types, keyed by name. A quote saved before
 * that, and the shipped default pinned visit, both carry a dead id, which would
 * otherwise render as "no duration set" and price at $0 with no explanation.
 */
export function alignPinnedToDurations(rules: CoverageRules, durations: readonly Duration[]): CoverageRules {
  const fallback = durations.find((d) => d.kind === 'visit')?.id ?? '';
  const known = new Set(durations.map((d) => d.id));
  const pinnedTimes = rules.pinnedTimes.map((p) => (known.has(p.durationId) ? p : { ...p, durationId: fallback }));
  return { ...rules, pinnedTimes };
}

/** The shipped default coverage rules. Pinned id is fixed (not random) so the
 *  default is stable across reads and safe to compare in tests. Its `durationId`
 *  is a menu id that no KinCare rate card carries, so the screen runs the default
 *  through `alignPinnedToDurations` before showing it. */
export const DEFAULT_COVERAGE_RULES: CoverageRules = {
  wakeStart: '07:00',
  wakeEnd: '22:00',
  maxGapHours: 6,
  pinnedTimes: [{ id: 'seed-morning', label: 'Morning feeding', time: '07:30', durationId: 'd2' }],
};

/** Blank-package defaults, filled in over any partial persisted package. */
export const PACKAGE_DEFAULTS: Omit<Package, 'id' | 'name'> = {
  visits: [],
  dayOverrides: {},
  overnightNights: {},
  overnightStart: '21:00',
  overnightBufferHours: 2,
  discountLabel: '',
  discountPct: 0,
};

/** Fill a partial (persisted) package up to a full one. */
export function normalizePackage(p: Partial<Package>): Package {
  return {
    ...PACKAGE_DEFAULTS,
    ...p,
    id: p.id ?? uid(),
    name: p.name ?? 'Package',
    discountPct: Number(p.discountPct) || 0,
    overnightBufferHours: Number(p.overnightBufferHours ?? PACKAGE_DEFAULTS.overnightBufferHours) || 0,
  };
}

// ── small helpers ─────────────────────────────────────────────────────────────

/** A short, collision-unlikely id for a client-created row. */
export function uid(): string {
  return Math.random().toString(36).slice(2, 9);
}

/**
 * Today as a "YYYY-MM-DD" value an `<input type="date">` accepts, in the
 * operator's LOCAL zone.
 *
 * Built from `getFullYear`/`getMonth`/`getDate`, never from
 * `toISOString().slice(0, 10)`: that converts to UTC first, so anyone west of
 * Greenwich gets tomorrow's date after their local evening. The rest of this
 * file already reads a date string as local wall-clock time (`daysBetween`,
 * `dateLabel` both parse `${date}T00:00:00`), so this matches them.
 */
export function todayIso(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Inclusive day count between two "YYYY-MM-DD" dates; 0 if unset or reversed. */
export function daysBetween(start: string, end: string): number {
  if (!start || !end) return 0;
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  const diff = Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1;
  return diff > 0 ? diff : 0;
}

/** A "YYYY-MM-DD" start date + a day offset → a short label; '' when unparseable. */
export function dateLabel(
  startDate: string,
  offset = 0,
  opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' },
): string {
  if (!startDate) return '';
  const d = new Date(`${startDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('en-US', opts);
}

/** "HH:MM" → minutes since midnight, or null when unparseable. */
export function timeToMinutes(t: string): number | null {
  if (!t) return null;
  const parts = t.split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/** Minutes since midnight → a 12h "h:MM AM/PM" label. */
export function minutesToTime(mins: number): string {
  const norm = ((Math.round(mins) % 1440) + 1440) % 1440;
  const h = Math.floor(norm / 60);
  const m = norm % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

/** Minutes since midnight → "HH:MM" for an `<input type="time">`. */
export function minutesToInput(mins: number): string {
  const v = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

/** A gap in minutes → "1h 30m" / "45m" / "2h". */
export function formatGap(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// ── suggestions ───────────────────────────────────────────────────────────────

type FillStrategy = 'cheapest' | 'mid' | 'richest';
const FILL_STRATEGIES: readonly FillStrategy[] = ['cheapest', 'mid', 'richest'];

function pick<T>(pool: readonly T[], strategy: FillStrategy): T | undefined {
  if (pool.length === 0) return undefined;
  if (strategy === 'cheapest') return pool[0];
  if (strategy === 'richest') return pool[pool.length - 1];
  return pool[Math.floor((pool.length - 1) / 2)];
}

function strategyLabel(strategy: FillStrategy): string {
  if (strategy === 'cheapest') return 'Lean';
  if (strategy === 'richest') return 'Generous';
  return 'Balanced';
}

/**
 * Suggest a starting day: fill any gap wider than the rule with one repeated
 * duration, at three price points. Only a SEED — every visit it produces is
 * editable afterwards, which is the whole point of the package model.
 */
export function buildDayPatterns(
  durations: readonly Duration[],
  pinnedTimes: readonly PinnedTime[],
  maxGapHours: number,
  wakeStart: string,
  wakeEnd: string,
  dedupe = true,
): DayPattern[] {
  const maxGapMin = maxGapHours * 60;
  const wakeStartMin = timeToMinutes(wakeStart);
  const wakeEndMin = timeToMinutes(wakeEnd);
  if (wakeStartMin === null || wakeEndMin === null || wakeEndMin <= wakeStartMin) return [];

  const pinned = pinnedTimes
    .map((p) => ({ ...p, minutes: timeToMinutes(p.time) }))
    .filter((p): p is PinnedTime & { minutes: number } => p.minutes !== null)
    .sort((a, b) => a.minutes - b.minutes);

  const eligibleDurations = durations.filter((d) => d.price > 0 && d.kind === 'visit');
  if (eligibleDurations.length === 0 && pinned.length === 0) return [];

  const anchors = [wakeStartMin, ...pinned.map((p) => p.minutes), wakeEndMin].sort((a, b) => a - b);

  const gaps: Array<{ start: number; size: number }> = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const size = anchors[i + 1]! - anchors[i]!;
    if (size > maxGapMin) gaps.push({ start: anchors[i]!, size });
  }

  const sortedByPrice = [...eligibleDurations].sort((a, b) => a.price - b.price);
  const patterns: DayPattern[] = [];

  for (const strategy of FILL_STRATEGIES) {
    const fallbackFill = pick(sortedByPrice, strategy);
    if (!fallbackFill) continue;

    const touchpoints: Touchpoint[] = pinned.map((p) => {
      const pd = durations.find((d) => d.id === p.durationId);
      return {
        type: 'pinned',
        label: p.label || 'Pinned visit',
        time: p.minutes,
        durationId: p.durationId || fallbackFill.id,
        durationLabel: pd?.label ?? fallbackFill.label,
        price: pd?.price ?? fallbackFill.price,
      };
    });

    for (const gap of gaps) {
      const numFillVisits = Math.ceil(gap.size / maxGapMin) - 1;
      if (numFillVisits <= 0) continue;
      const spacing = gap.size / (numFillVisits + 1);
      // A repeated check-in must not run longer than the space between check-ins,
      // or it overlaps the next — that's a day-stay/overnight the sitter books by
      // hand. Fall back to the shortest if nothing fits.
      const fits = sortedByPrice.filter((d) => d.minutes <= spacing);
      const fillDuration = pick(fits.length ? fits : [sortedByPrice[0]!], strategy)!;
      for (let i = 1; i <= numFillVisits; i++) {
        touchpoints.push({
          type: 'flex',
          label: 'Check-in',
          time: gap.start + (gap.size * i) / (numFillVisits + 1),
          durationId: fillDuration.id,
          durationLabel: fillDuration.label,
          price: fillDuration.price,
        });
      }
    }

    touchpoints.sort((a, b) => a.time - b.time);
    // A suggestion with no visits is useless as a seed (a degenerate window with no
    // pinned visits) — emit nothing rather than a phantom $0 "Lean" seed button.
    if (touchpoints.length === 0) continue;
    const dayTotal = touchpoints.reduce((s, t) => s + t.price, 0);
    const signature = touchpoints.map((t) => `${t.durationId}@${Math.round(t.time)}`).join('|');
    if (dedupe && patterns.some((p) => p.signature === signature)) continue;

    patterns.push({ id: strategy, strategyLabel: strategyLabel(strategy), touchpoints, dayTotal, signature });
  }

  return patterns.sort((a, b) => a.dayTotal - b.dayTotal);
}

/** Seed a package's visit template from a suggestion. */
export function visitsFromPattern(pattern: DayPattern): Visit[] {
  return pattern.touchpoints.map((tp) => ({
    id: uid(),
    time: Math.round(tp.time),
    durationId: tp.durationId,
    label: tp.label,
  }));
}

/** Seed a blank package from the client's pinned visits. */
export function visitsFromPinned(pinnedTimes: readonly PinnedTime[]): Visit[] {
  return pinnedTimes
    .map((p) => ({ ...p, minutes: timeToMinutes(p.time) }))
    .filter((p): p is PinnedTime & { minutes: number } => p.minutes !== null)
    .sort((a, b) => a.minutes - b.minutes)
    .map((p) => ({ id: uid(), time: p.minutes, durationId: p.durationId, label: p.label }));
}

// ── pricing ───────────────────────────────────────────────────────────────────

/** The visits actually scheduled on a given day: its override if it has one, else the template. */
export function effectiveVisits(pkg: Package, dayIndex: number): readonly Visit[] {
  return pkg.dayOverrides[dayIndex] ?? pkg.visits;
}

/**
 * What an overnight covers on `dayIndex`. An overnight is a window that starts at
 * the package's overnight time and runs for the overnight duration's length,
 * spilling into the next morning. A visit inside that window — or the arrival
 * buffer just before it — is already covered.
 */
export function coverageForDay(
  pkg: Package,
  dayIndex: number,
  nights: number,
  overnightDuration: Duration | undefined,
): Coverage {
  const startMin = timeToMinutes(pkg.overnightStart);
  if (startMin === null || !overnightDuration) return BARE_COVERAGE;

  const span = Number(overnightDuration.minutes) || 0;
  const bufferMin = Math.max(0, Number(pkg.overnightBufferHours) || 0) * 60;
  const tonight = dayIndex < nights && !!pkg.overnightNights[dayIndex];
  const priorNight = dayIndex > 0 && !!pkg.overnightNights[dayIndex - 1];
  const endAbs = startMin + span;

  return {
    eveningFrom: tonight ? startMin - bufferMin : null,
    morningUntil: priorNight && endAbs > 1440 ? endAbs - 1440 : null,
    bonusFreeVisit: priorNight,
  };
}

/** Price a single day's visits against its overnight coverage. */
export function priceDay(
  visits: readonly Visit[],
  durations: readonly Duration[],
  coverage: Coverage,
): { items: PricedItem[]; total: number } {
  const { eveningFrom, morningUntil, bonusFreeVisit } = coverage;
  const sorted = [...visits].sort((a, b) => a.time - b.time);

  const items: PricedItem[] = sorted.map((v) => {
    const d = durations.find((x) => x.id === v.durationId);
    const price = d ? d.price : 0;
    const coveredMorning = morningUntil !== null && v.time <= morningUntil;
    const coveredEvening = eveningFrom !== null && v.time >= eveningFrom;
    const covered = coveredMorning || coveredEvening;
    return {
      key: v.id,
      time: v.time,
      label: v.label || 'Visit',
      durationLabel: d ? d.label : 'no duration set',
      price: covered ? 0 : price,
      listPrice: price,
      covered,
      bonus: false,
      free: covered,
      freeReason: covered ? 'covered by overnight' : null,
    };
  });

  // The overnight loyalty perk: one free visit the day after an overnight, applied
  // to the earliest still-paid visit. The window (above) is the sitter being there;
  // this free visit is a separate promise stacked on top, so a covered morning does
  // NOT consume it — the credit floats to the next paid visit.
  if (bonusFreeVisit) {
    const idx = items.findIndex((it) => !it.free);
    if (idx >= 0) {
      items[idx] = { ...items[idx]!, price: 0, bonus: true, free: true, freeReason: 'free visit — overnight bundle' };
    }
  }

  return { items, total: items.reduce((s, i) => s + i.price, 0) };
}

/** Gaps checked against the rule but never blocking — a hand-built day is the sitter's call. */
export function gapWarnings(
  visits: readonly Visit[],
  wakeStart: string,
  wakeEnd: string,
  maxGapHours: number,
  coverage: Coverage,
): string[] {
  const ws = timeToMinutes(wakeStart);
  const we = timeToMinutes(wakeEnd);
  if (ws === null || we === null || we <= ws) return [];

  const from = coverage.morningUntil !== null ? Math.max(ws, coverage.morningUntil) : ws;
  const to = coverage.eveningFrom !== null ? Math.min(we, coverage.eveningFrom) : we;
  if (to <= from) return [];

  const maxGap = maxGapHours * 60;
  const inside = visits.map((v) => v.time).filter((t) => t > from && t < to).sort((a, b) => a - b);
  const anchors = [from, ...inside, to];
  const out: string[] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const size = anchors[i + 1]! - anchors[i]!;
    if (size > maxGap) out.push(`${minutesToTime(anchors[i]!)} → ${minutesToTime(anchors[i + 1]!)} is ${formatGap(size)}`);
  }
  return out;
}

/** Price a whole package across the stay: per-day rows, subtotal, discount, total. */
export function pricePackage(pkg: Package, ctx: PriceContext): PricedPackage {
  const { days, nights, durations, overnightDuration } = ctx;
  const rows: PricedDayRow[] = [];
  for (let i = 0; i < days; i++) {
    const coverage = coverageForDay(pkg, i, nights, overnightDuration);
    const day = priceDay(effectiveVisits(pkg, i), durations, coverage);
    const canOvernight = i < nights;
    const isOvernight = canOvernight && !!pkg.overnightNights[i];
    const overnightCost = isOvernight && overnightDuration ? overnightDuration.price : 0;
    rows.push({
      dayIndex: i,
      items: day.items,
      customized: !!pkg.dayOverrides[i],
      canOvernight,
      isOvernight,
      overnightCost,
      overnightLabel: overnightDuration ? overnightDuration.label : '',
      overnightStartMin: timeToMinutes(pkg.overnightStart),
      coverage,
      dayCost: day.total + overnightCost,
    });
  }
  const subtotal = rows.reduce((s, r) => s + r.dayCost, 0);
  const pct = Math.min(100, Math.max(0, Number(pkg.discountPct) || 0));
  const discount = subtotal * (pct / 100);
  return { rows, subtotal, discountPct: pct, discount, total: subtotal - discount };
}

// ── quote text ────────────────────────────────────────────────────────────────

export interface QuoteInput {
  readonly clientName: string;
  readonly startDate: string;
  readonly days: number;
  readonly priced: PricedPackage & { readonly pkg: Package };
}

/** A clean plain-text quote for the clipboard — pastes into an email, text, or agreement. */
export function quoteText({ clientName, startDate, days, priced }: QuoteInput): string {
  const { pkg, rows, subtotal, discountPct, discount, total } = priced;
  const money = (n: number): string => `$${n.toFixed(2)}`;
  const lines: string[] = ['TribeTails — Coverage Package', ''];
  if (clientName.trim() !== '') lines.push(`Prepared for: ${clientName.trim()}`);
  lines.push(`${pkg.name} · ${days} day${days !== 1 ? 's' : ''}`);
  if (startDate) lines.push(`${dateLabel(startDate, 0)} – ${dateLabel(startDate, days - 1)}`);
  lines.push('');

  for (const r of rows) {
    const when = startDate ? dateLabel(startDate, r.dayIndex) : `Day ${r.dayIndex + 1}`;
    const on = r.isOvernight && r.overnightStartMin !== null ? `   (overnight from ${minutesToTime(r.overnightStartMin)})` : '';
    lines.push(`Day ${r.dayIndex + 1} — ${when}${on}   ${money(r.dayCost)}`);
    for (const it of r.items) {
      const price = it.free ? 'free' : money(it.price);
      const reason = it.freeReason ? ` — ${it.freeReason}` : '';
      lines.push(`   ${minutesToTime(it.time).padEnd(9)} ${it.label} (${it.durationLabel})${reason}   ${price}`);
    }
    if (r.isOvernight && r.overnightStartMin !== null) {
      lines.push(`   ${minutesToTime(r.overnightStartMin).padEnd(9)} ${r.overnightLabel}   ${money(r.overnightCost)}`);
    }
    lines.push('');
  }

  lines.push(`Subtotal   ${money(subtotal)}`);
  if (discountPct > 0) lines.push(`${pkg.discountLabel || 'Discount'} (${discountPct}%)   -${money(discount)}`);
  lines.push(`Total   ${money(total)}`);
  return lines.join('\n');
}
