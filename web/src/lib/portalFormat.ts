/**
 * Pure display-formatting helpers shared by Home/Schedule/Kin screens.
 * Kept separate from the screens themselves so the mapping logic (not
 * just the markup) has direct vitest coverage.
 */
import type { BookingStatus, PortalHomeSection } from '../api/types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The `.cal` tile on a visit row: 3-letter month + zero-padded day. */
export function calTile(ms: number): { month: string; day: string } {
  const d = new Date(ms);
  return { month: MONTHS[d.getMonth()]!, day: String(d.getDate()).padStart(2, '0') };
}

/** "Mon, 8:00 AM" — used in the visit row subtitle. */
export function weekdayTime(ms: number): string {
  const d = new Date(ms);
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${WEEKDAYS[d.getDay()]}, ${hours}:${minutes} ${ampm}`;
}

/** "Mon, 8:00 AM with Auntie Maya" / just the weekday-time if no auntie assigned yet. */
export function visitSubtitle(startTimeMs: number | null, auntieDisplayName: string | null): string {
  if (startTimeMs === null) return auntieDisplayName ? `With Auntie ${auntieDisplayName}` : 'Time to be confirmed';
  const base = weekdayTime(startTimeMs);
  return auntieDisplayName ? `${base} with Auntie ${auntieDisplayName}` : base;
}

/** "Today" / "Yesterday" / "3 days ago" / falls back to a short date past a week out. */
export function relativeDay(ms: number, now: number = Date.now()): string {
  const startOfDay = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

const SPECIES_EMOJI: Record<string, string> = {
  dog: '\u{1F436}',
  cat: '\u{1F431}',
  rabbit: '\u{1F430}',
  bird: '\u{1F426}',
  fish: '\u{1F41F}',
  reptile: '\u{1F98E}',
  small_mammal: '\u{1F439}',
};

/** Best-effort emoji for a kin's species; falls back to a paw print. */
export function speciesEmoji(species: string | null): string {
  if (!species) return '\u{1F43E}';
  return SPECIES_EMOJI[species.toLowerCase()] ?? '\u{1F43E}';
}

export interface ChipInfo {
  label: string;
  tone: 'warm' | 'go' | 'done';
}

/** Chip label + color tone for a booking's status, per the mockup's CONFIRMED/PENDING/COMPLETED chips. */
export function bookingChip(status: BookingStatus): ChipInfo {
  switch (status) {
    case 'confirmed':
      return { label: 'CONFIRMED', tone: 'warm' };
    case 'requested':
      return { label: 'PENDING', tone: 'go' };
    case 'completed':
      return { label: 'COMPLETED', tone: 'done' };
    case 'cancelled':
      return { label: 'CANCELLED', tone: 'done' };
    default:
      return { label: status.toUpperCase(), tone: 'warm' };
  }
}

/** Cycles the mockup's v1/v2/v3 calendar-tile color variants by row index. */
export function visitVariant(index: number): 'v1' | 'v2' | 'v3' {
  const variants = ['v1', 'v2', 'v3'] as const;
  return variants[index % 3]!;
}

/** Cycles the mockup's k1..k4 kin-row border color variants by row index. */
export function kinVariant(index: number): 'k1' | 'k2' | 'k3' | 'k4' {
  const variants = ['k1', 'k2', 'k3', 'k4'] as const;
  return variants[index % 4]!;
}

/** "Saturday morning" / "Saturday afternoon" / "Saturday evening" — the Home hero kicker. */
export function greetingKick(now: number = Date.now()): string {
  const d = new Date(now);
  const hour = d.getHours();
  const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  return `${WEEKDAYS_FULL[d.getDay()]} ${part}`;
}

const WEEKDAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Whole minutes elapsed since `startMs`, floored at 0 (clock skew / future timestamps). */
export function elapsedMinutes(startMs: number, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - startMs) / 60_000));
}

/** "Saturday, June 6" — the Schedule page-head kicker. */
export function fullDateKick(now: number = Date.now()): string {
  const d = new Date(now);
  return `${WEEKDAYS_FULL[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** "8:02 AM" from an ISO timestamp, or null if absent/unparseable. */
export function isoTime(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : weekdayTime(ms).split(', ')[1] ?? null;
}

// ── Home section layout (O-14: parity with HomeScreen.kt's resolveHomeLayout) ──

/** A resolved home section: id + per-section limit (0 = unlimited). */
export interface HomeSectionResolved {
  id: string;
  limit: number;
}

/** Canonical section order used when the operator supplies no config. */
export const CANONICAL_HOME_ORDER = ['liveVisit', 'upNext', 'tales', 'roster', 'quickStart'] as const;

/**
 * Resolves the home layout from the operator `sections` config — a direct
 * port of HomeScreen.kt's `resolveHomeLayout`, kept behavior-identical so
 * the same operator config produces the same layout on web and Android.
 * Empty config -> the canonical order, all sections enabled, unlimited.
 * Otherwise -> the CONFIGURED order, dropping disabled sections and any
 * unknown id, carrying each section's limit through.
 */
export function resolveHomeLayout(sections: PortalHomeSection[]): HomeSectionResolved[] {
  if (sections.length === 0) {
    return CANONICAL_HOME_ORDER.map((id) => ({ id, limit: 0 }));
  }
  return sections
    .filter((s) => s.enabled && (CANONICAL_HOME_ORDER as readonly string[]).includes(s.id))
    .map((s) => ({ id: s.id, limit: s.limit }));
}
