/**
 * 17.3 Dashboard customization (React admin). Pure model plus transforms for the
 * operator-editable Home dashboard, persisted as an ordered list of "key:size"
 * tokens. A known key absent from the list = hidden; an empty list = the shipped
 * default, so an un-customized dashboard renders exactly as it did before edit
 * mode existed. `stats` is the stat row, treated as one always-full-width widget.
 *
 * This is a transcription of android `ui/home/DashboardLayout.kt` (itself
 * mirrored from `web/composeApp/.../screens/home/DashboardLayout.kt`), not a
 * reinterpretation. Same key tokens, same size tokens, same first-wins dedupe,
 * same packing, same no-op bounds. That matters because all three surfaces read
 * and write ONE field on ONE document, so a layout an operator arranges on
 * android has to round-trip through here unchanged and back. Any change to the
 * key list or the parsing rules has to land on all three at once.
 *
 * Everything here is a pure function over plain data: no React, no Firestore.
 * Persistence lives in `api/dashboardLayout.ts`.
 */

/**
 * Every widget the dashboard knows how to place, in the order the "hidden cards"
 * strip offers them. The string IS the persisted token, so these values are a
 * storage contract and cannot be renamed without a migration. Kept identical to
 * android's `DashKey` enum, including its order.
 */
export const DASH_KEYS = [
  'stats',
  'todaysPack',
  'kintales',
  'cashFlow',
  'gatekeeper',
  'weatherWatchdog',
  'heatIndex',
  // A8 insight widgets (W8 to W13). All ship hidden: absent from
  // DEFAULT_DASHBOARD, offered under Customize.
  'weeklyCapacity',
  'overdueTracker',
  'petBreakdown',
  'frequentFlyers',
  'holidayRunway',
  // AO-38 / W6 Unread Client Messages.
  'unreadMessages',
  // AO-36 / W3 Key and Code Safebox.
  'safebox',
  // AO-37/39/35/40/41. All hidden by default.
  'careFlags',
  'expirations',
  'routeOptimizer',
  'expenseLog',
  'supplies',
] as const;

export type DashKey = (typeof DASH_KEYS)[number];

/** A widget is either half-width (paired with its neighbour) or full-width. */
export type DashSize = 'compact' | 'wide';

export interface DashWidget {
  key: DashKey;
  size: DashSize;
}

const KEY_SET: ReadonlySet<string> = new Set<string>(DASH_KEYS);

/**
 * Reads one key token. Trims (android's `DashKey.parse` does) and is
 * case-SENSITIVE: `kinTales` is not `kintales`, because accepting near-misses
 * would let two spellings of one widget both persist and then both render.
 * Returns null for anything unknown so the caller can drop it.
 */
export function parseDashKey(raw: string | null | undefined): DashKey | null {
  const t = (raw ?? '').trim();
  return KEY_SET.has(t) ? (t as DashKey) : null;
}

/**
 * Reads one size token, defaulting to compact. Unlike a key, an unreadable size
 * is NOT a reason to drop the widget: the operator asked for that card, and the
 * conservative half-width placement always fits.
 */
export function parseDashSize(raw: string | null | undefined): DashSize {
  return (raw ?? '').trim() === 'wide' ? 'wide' : 'compact';
}

/** The stat row spans the full width always; only it is forced. */
function normalize(key: DashKey, size: DashSize): DashSize {
  return key === 'stats' ? 'wide' : size;
}

/**
 * Shipped default: the stat row on top, the two panels compact so they pair
 * side by side. Frozen, because it is also the value every un-customized
 * operator sees.
 */
export const DEFAULT_DASHBOARD: readonly DashWidget[] = Object.freeze([
  Object.freeze({ key: 'stats', size: 'wide' }),
  Object.freeze({ key: 'todaysPack', size: 'compact' }),
  Object.freeze({ key: 'kintales', size: 'compact' }),
]) as readonly DashWidget[];

/**
 * Parse "key:size" tokens: drop unknown keys, dedupe by key (first wins), force
 * stats wide. Never throws on malformed input, because the input is a stored
 * field that a older or newer client may have written.
 */
export function parseDashboard(tokens: readonly string[]): DashWidget[] {
  const seen = new Set<DashKey>();
  const out: DashWidget[] = [];
  for (const raw of tokens) {
    const parts = raw.split(':');
    const key = parseDashKey(parts[0]);
    if (key === null) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, size: normalize(key, parseDashSize(parts[1])) });
  }
  return out;
}

/**
 * The effective dashboard at load: the saved layout, or the default when nothing
 * readable is stored. A layout the operator deliberately emptied also resolves
 * back to the default, matching android: a blank Home is never what was meant.
 */
export function resolvedDashboard(tokens: readonly string[]): DashWidget[] {
  const parsed = parseDashboard(tokens);
  return parsed.length > 0 ? parsed : DEFAULT_DASHBOARD.map((x) => ({ ...x }));
}

/** Serialize back to the "key:size" tokens the persisted field holds. */
export function toTokens(list: readonly DashWidget[]): string[] {
  return list.map((x) => `${x.key}:${x.size}`);
}

/** Known widgets not currently shown, in DASH_KEYS order (the hidden strip). */
export function hiddenKeys(shown: readonly DashWidget[]): DashKey[] {
  const shownKeys = new Set<string>(shown.map((x) => x.key));
  return DASH_KEYS.filter((k) => !shownKeys.has(k));
}

/**
 * Group the shown widgets into render rows: a wide widget is a solo full-width
 * row, consecutive compacts pair two to a row, and a lone trailing compact sits
 * alone. Order is preserved and every widget appears exactly once.
 */
export function packRows(shown: readonly DashWidget[]): DashWidget[][] {
  const rows: DashWidget[][] = [];
  let i = 0;
  while (i < shown.length) {
    const current = shown[i];
    if (current === undefined) break;
    const next = shown[i + 1];
    if (current.size === 'compact' && next !== undefined && next.size === 'compact') {
      rows.push([current, next]);
      i += 2;
    } else {
      rows.push([current]);
      i += 1;
    }
  }
  return rows;
}

/** Adjacent swap up; no-op at the top or on an out-of-range index. */
export function moveWidgetUp(list: readonly DashWidget[], index: number): DashWidget[] {
  const out = [...list];
  if (index <= 0 || index >= list.length) return out;
  const above = out[index - 1];
  const here = out[index];
  if (above === undefined || here === undefined) return out;
  out[index - 1] = here;
  out[index] = above;
  return out;
}

/** Adjacent swap down; no-op at the bottom or on an out-of-range index. */
export function moveWidgetDown(list: readonly DashWidget[], index: number): DashWidget[] {
  const out = [...list];
  if (index < 0 || index >= list.length - 1) return out;
  const here = out[index];
  const below = out[index + 1];
  if (here === undefined || below === undefined) return out;
  out[index + 1] = here;
  out[index] = below;
  return out;
}

/** Set one widget's size (stats stays wide). A key that is hidden is untouched. */
export function setWidgetSize(
  list: readonly DashWidget[],
  key: DashKey,
  size: DashSize,
): DashWidget[] {
  return list.map((x) => (x.key === key ? { key: x.key, size: normalize(key, size) } : { ...x }));
}

/** Hide a widget (drop it from the shown list). */
export function hideWidget(list: readonly DashWidget[], key: DashKey): DashWidget[] {
  return list.filter((x) => x.key !== key).map((x) => ({ ...x }));
}

/** Show a previously hidden widget, appended at the end. Already shown = no-op. */
export function showWidget(
  list: readonly DashWidget[],
  key: DashKey,
  size: DashSize = 'compact',
): DashWidget[] {
  const out = list.map((x) => ({ ...x }));
  if (out.some((x) => x.key === key)) return out;
  out.push({ key, size: normalize(key, size) });
  return out;
}
