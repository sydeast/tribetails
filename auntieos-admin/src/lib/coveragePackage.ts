/**
 * Coverage Package Builder — pure domain logic.
 *
 * Ported from the standalone `PackageBuilder` applet (a React sketch that
 * persisted to a `window.storage` KV shim). The maths is unchanged; what is new
 * is that it is fully typed and split out of the screen so it can be unit-tested
 * on its own, the same shape as `settingsFormat.ts` (pure helpers + a sibling
 * `.test.ts`) rather than logic buried in a component.
 *
 * The model: an operator prices a multi-day pet-sitting stay by describing how a
 * SINGLE covered day must look — a wake window (e.g. 07:00–22:00), a maximum gap
 * allowed between visits, and any "pinned" visits that must happen at a fixed
 * time every day (medication, a morning feed). `buildDayPatterns` turns those
 * rules into a few concrete, RULE-VALID daily schedules at different price
 * points; the screen prices the approved one across the whole stay.
 */

/** A named visit length with its price. `id` is stable for the life of the doc. */
export interface Duration {
  readonly id: string;
  readonly label: string;
  readonly minutes: number;
  readonly price: number;
}

/** A visit that must happen at a fixed time every covered day. */
export interface PinnedTime {
  readonly id: string;
  readonly label: string;
  /** "HH:MM", 24h, as an `<input type="time">` yields. */
  readonly time: string;
  /** Which `Duration` this pinned visit is billed at. */
  readonly durationId: string;
}

/** The per-client coverage rules that shape a valid day. */
export interface CoverageRules {
  /** "HH:MM" the covered day starts. */
  readonly wakeStart: string;
  /** "HH:MM" the covered day ends. */
  readonly wakeEnd: string;
  /** Longest allowed gap between consecutive visits, in hours. */
  readonly maxGapHours: number;
  readonly pinnedTimes: readonly PinnedTime[];
}

/** One visit inside a generated day: a pinned time or a gap-filling check-in. */
export interface Touchpoint {
  readonly type: 'pinned' | 'flex';
  readonly label: string;
  /** Minutes since midnight. */
  readonly time: number;
  readonly durationId: string;
  readonly durationLabel: string;
  readonly price: number;
}

/** A complete, rule-valid schedule for one covered day. */
export interface DayPattern {
  readonly id: string;
  readonly strategyLabel: string;
  readonly touchpoints: readonly Touchpoint[];
  readonly overnightCost: number;
  readonly overnightLabel: string | null;
  readonly dayTotal: number;
  /** Structural fingerprint used to drop duplicate strategies. */
  readonly signature: string;
}

/** The shipped default visit menu, used until an operator edits it. */
export const DEFAULT_DURATIONS: readonly Duration[] = [
  { id: 'd1', label: '15-min visit', minutes: 15, price: 15 },
  { id: 'd2', label: '30-min visit', minutes: 30, price: 22 },
  { id: 'd3', label: '45-min visit', minutes: 45, price: 28 },
  { id: 'd4', label: '60-min visit', minutes: 60, price: 35 },
  { id: 'd5', label: '90-min visit', minutes: 90, price: 60 },
  { id: 'd6', label: 'Overnight (2hr)', minutes: 120, price: 80 },
  { id: 'd7', label: 'Overnight (12hr)', minutes: 720, price: 150 },
];

/** The shipped default coverage rules. `id` is fixed (not random) so the default
 *  is stable across reads and safe to compare in tests. */
export const DEFAULT_COVERAGE_RULES: CoverageRules = {
  wakeStart: '07:00',
  wakeEnd: '22:00',
  maxGapHours: 6,
  pinnedTimes: [{ id: 'seed-morning', label: 'Morning feeding', time: '07:30', durationId: 'd2' }],
};

/** Visit-length ceiling (minutes) separating flexible day visits from overnights. */
export const OVERNIGHT_MINUTES = 300;

/** A short, collision-unlikely id for a client-created row. */
export function uid(): string {
  return Math.random().toString(36).slice(2, 9);
}

/** Inclusive day count between two "YYYY-MM-DD" dates; 0 if unset or reversed. */
export function daysBetween(start: string, end: string): number {
  if (!start || !end) return 0;
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  const diff = Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1;
  return diff > 0 ? diff : 0;
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
  const h = Math.floor(((((mins % 1440) + 1440) % 1440) / 60));
  const m = Math.floor(((mins % 60) + 60) % 60);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

type FillStrategy = 'cheapest' | 'mid' | 'richest';
const FILL_STRATEGIES: readonly FillStrategy[] = ['cheapest', 'mid', 'richest'];

function strategyLabel(strategy: FillStrategy): string {
  if (strategy === 'cheapest') return 'Lean';
  if (strategy === 'richest') return 'Generous';
  return 'Balanced';
}

/**
 * Turn coverage rules into a few rule-valid daily schedules at distinct prices.
 *
 * A "touchpoint" is either a pinned time (fixed) or a flexible visit dropped in
 * to satisfy the max-gap rule. `wakeStart`/`wakeEnd` bound the covered day; the
 * optional overnight block covers the hours outside it. Three fill strategies
 * (lean / balanced / generous) vary which duration fills the gaps, yielding
 * distinct schedules and prices; literal duplicates are collapsed by signature.
 */
export function buildDayPatterns(
  durations: readonly Duration[],
  rules: CoverageRules,
  useOvernight: boolean,
  overnightDurationId: string,
): DayPattern[] {
  const { pinnedTimes, maxGapHours, wakeStart, wakeEnd } = rules;
  const maxGapMin = maxGapHours * 60;
  const wakeStartMin = timeToMinutes(wakeStart);
  const wakeEndMin = timeToMinutes(wakeEnd);
  if (wakeStartMin === null || wakeEndMin === null || wakeEndMin <= wakeStartMin) return [];

  const pinned = pinnedTimes
    .map((p) => ({ ...p, minutes: timeToMinutes(p.time) }))
    .filter((p): p is PinnedTime & { minutes: number } => p.minutes !== null)
    .sort((a, b) => a.minutes - b.minutes);

  // Exclude overnight-length visits from the flexible day fill.
  const eligibleDurations = durations.filter((d) => d.price > 0 && d.minutes < OVERNIGHT_MINUTES);
  if (eligibleDurations.length === 0 && pinned.length === 0) return [];

  // Fixed anchors across the wake window: start, each pinned time, end.
  const anchors = [wakeStartMin, ...pinned.map((p) => p.minutes), wakeEndMin].sort((a, b) => a - b);

  // Gaps wider than the max become fill targets.
  const gaps: Array<{ start: number; end: number; size: number }> = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const from = anchors[i]!;
    const to = anchors[i + 1]!;
    const gapSize = to - from;
    if (gapSize > maxGapMin) gaps.push({ start: from, end: to, size: gapSize });
  }

  const sortedByPrice = [...eligibleDurations].sort((a, b) => a.price - b.price);
  const patterns: DayPattern[] = [];

  for (const strategy of FILL_STRATEGIES) {
    let fillDuration: Duration | undefined;
    if (strategy === 'cheapest') fillDuration = sortedByPrice[0];
    else if (strategy === 'richest') fillDuration = sortedByPrice[sortedByPrice.length - 1];
    else fillDuration = sortedByPrice[Math.floor((sortedByPrice.length - 1) / 2)];
    if (!fillDuration) continue;
    const fill = fillDuration;

    const touchpoints: Touchpoint[] = pinned.map((p) => {
      const pinnedDuration = durations.find((d) => d.id === p.durationId);
      return {
        type: 'pinned',
        label: p.label || 'Pinned visit',
        time: p.minutes,
        durationId: p.durationId || fill.id,
        durationLabel: pinnedDuration?.label ?? fill.label,
        price: pinnedDuration?.price ?? fill.price,
      };
    });

    for (const gap of gaps) {
      // Drop visits into the gap spaced at most maxGapMin apart.
      const numFillVisits = Math.ceil(gap.size / maxGapMin) - 1;
      if (numFillVisits <= 0) continue;
      for (let i = 1; i <= numFillVisits; i++) {
        const t = gap.start + (gap.size * i) / (numFillVisits + 1);
        touchpoints.push({
          type: 'flex',
          label: 'Check-in',
          time: t,
          durationId: fill.id,
          durationLabel: fill.label,
          price: fill.price,
        });
      }
    }

    touchpoints.sort((a, b) => a.time - b.time);

    let overnightCost = 0;
    let overnightLabel: string | null = null;
    if (useOvernight) {
      const od = durations.find((d) => d.id === overnightDurationId);
      if (od) {
        overnightCost = od.price;
        overnightLabel = od.label;
      }
    }

    // A schedule with no visits AND no overnight is not a real option. It happens
    // when the rules are degenerate — the wake window is no wider than the max
    // gap and there are no pinned visits, so nobody needs to be on site. Without
    // this guard all three strategies collapse to the same empty schedule and
    // dedupe down to a single phantom $0 "Lean" card, which reads as broken.
    // Emit nothing instead, so the screen shows its actionable empty-state.
    if (touchpoints.length === 0 && overnightCost === 0) continue;

    const dayTotal = touchpoints.reduce((sum, tp) => sum + tp.price, 0) + overnightCost;
    const signature =
      touchpoints.map((t) => `${t.durationId}@${Math.round(t.time)}`).join('|') +
      (useOvernight ? `+ON:${overnightDurationId}` : '');

    // Avoid literal duplicate strategies (e.g. cheapest === mid when only one
    // duration qualifies).
    if (patterns.some((p) => p.signature === signature)) continue;

    patterns.push({
      id: uid(),
      strategyLabel: strategyLabel(strategy),
      touchpoints,
      overnightCost,
      overnightLabel,
      dayTotal,
      signature,
    });
  }

  return patterns.sort((a, b) => a.dayTotal - b.dayTotal);
}

/** A "YYYY-MM-DD" date → a short "Mon, Jul 28" label; '' when unparseable. */
export function dateLabel(date: string): string {
  if (!date) return '';
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Everything the quote text needs: the approved daily schedule priced across a stay. */
export interface QuoteInput {
  readonly clientName: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly days: number;
  readonly pattern: DayPattern;
}

/**
 * A clean plain-text quote for the clipboard / share sheet — pastes cleanly into
 * an email, text, or a Kinfolk agreement. Ported from the standalone applet's
 * `quoteText`, adapted to the shipped model: one approved daily schedule priced
 * across the whole stay (the applet's per-day override model is a later port).
 */
export function quoteText({ clientName, startDate, endDate, days, pattern }: QuoteInput): string {
  const money = (n: number): string => `$${n.toFixed(2)}`;
  const lines: string[] = ['TribeTails — Coverage Package', ''];
  if (clientName.trim() !== '') lines.push(`Prepared for: ${clientName.trim()}`);
  lines.push(`${pattern.strategyLabel} schedule · ${days} day${days !== 1 ? 's' : ''}`);
  const start = dateLabel(startDate);
  const end = dateLabel(endDate);
  if (start && end) lines.push(`${start} – ${end}`);
  lines.push('');

  lines.push('Each day:');
  for (const tp of pattern.touchpoints) {
    const label = tp.label === 'Check-in' ? `Check-in (${tp.durationLabel})` : `${tp.label} (${tp.durationLabel})`;
    lines.push(`   ${minutesToTime(tp.time).padEnd(9)} ${label}   ${money(tp.price)}`);
  }
  if (pattern.overnightLabel) {
    lines.push(`   ${'overnight'.padEnd(9)} ${pattern.overnightLabel}   ${money(pattern.overnightCost)}`);
  }
  lines.push(`   Per day   ${money(pattern.dayTotal)}`);
  lines.push('');
  lines.push(`Total (${days} day${days !== 1 ? 's' : ''})   ${money(pattern.dayTotal * days)}`);
  return lines.join('\n');
}
