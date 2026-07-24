import { doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import {
  DEFAULT_COVERAGE_RULES,
  DEFAULT_DURATIONS,
  withKind,
  type CoverageRules,
  type Duration,
  type PinnedTime,
} from '../lib/coveragePackage';

/**
 * Read side of the Coverage Package Builder's persisted config, paired with
 * `saveCoveragePackageConfig` in `./coveragePackageWrite.ts`.
 *
 * Only the operator-global CONFIG persists — the visit menu (`durations`) and
 * the coverage `rules`. The per-stay inputs (client name, dates, which schedule
 * was approved) are session state on the screen and are deliberately NOT stored,
 * exactly as the original applet persisted only its two config blobs and kept
 * the pricing inputs ephemeral.
 *
 * One doc, read once with `getDoc` (a lone admin has no concurrent editor to
 * react to), the same shape as `getBusinessSettings`. A missing doc returns the
 * shipped defaults rather than throwing (a never-configured install); a genuine
 * read failure (permission-denied, offline) DOES throw, for the screen to
 * surface fail-loud through `AsyncRegion`.
 */

export const COVERAGE_PACKAGE_COLLECTION = 'coverage_package_config';
export const COVERAGE_PACKAGE_DOC_ID = 'config';

/** The persisted, operator-global config. */
export interface CoveragePackageConfig {
  readonly durations: readonly Duration[];
  readonly rules: CoverageRules;
  /** Save stamp, for the "last saved" line. Absent on a never-saved doc. */
  readonly updatedAt?: string;
  readonly updatedBy?: string;
}

type RawRecord = Record<string, unknown>;

function isRecord(v: unknown): v is RawRecord {
  return typeof v === 'object' && v !== null;
}

function pickString(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() !== '' ? v : fallback;
}

function pickNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Coerce one raw duration, or null if it has no usable id/label. */
function decodeDuration(raw: unknown): Duration | null {
  if (!isRecord(raw)) return null;
  const id = pickString(raw.id, '');
  const label = pickString(raw.label, '');
  if (id === '' || label === '') return null;
  // `kind` splits day visits from overnights. Durations saved before it existed
  // carry none; `withKind` migrates them (only the legacy d7 → overnight).
  const kind = raw.kind === 'overnight' ? 'overnight' : raw.kind === 'visit' ? 'visit' : undefined;
  const [decoded] = withKind([
    { id, label, minutes: pickNumber(raw.minutes, 0), price: pickNumber(raw.price, 0), ...(kind ? { kind } : {}) },
  ]);
  return decoded ?? null;
}

function decodeDurations(raw: unknown): readonly Duration[] {
  if (!Array.isArray(raw)) return DEFAULT_DURATIONS;
  const decoded = raw.map(decodeDuration).filter((d): d is Duration => d !== null);
  // An empty or all-invalid list falls back rather than leaving the operator with
  // no menu at all; a partial list is kept as-is (they may have pruned it).
  return decoded.length > 0 ? decoded : DEFAULT_DURATIONS;
}

function decodePinnedTime(raw: unknown): PinnedTime | null {
  if (!isRecord(raw)) return null;
  const id = pickString(raw.id, '');
  if (id === '') return null;
  return {
    id,
    label: pickString(raw.label, ''),
    time: pickString(raw.time, ''),
    durationId: pickString(raw.durationId, ''),
  };
}

function decodeRules(raw: unknown): CoverageRules {
  const d = DEFAULT_COVERAGE_RULES;
  if (!isRecord(raw)) return d;
  const pinnedRaw = Array.isArray(raw.pinnedTimes) ? raw.pinnedTimes : [];
  const pinnedTimes = pinnedRaw
    .map(decodePinnedTime)
    .filter((p): p is PinnedTime => p !== null);
  return {
    wakeStart: pickString(raw.wakeStart, d.wakeStart),
    wakeEnd: pickString(raw.wakeEnd, d.wakeEnd),
    maxGapHours: pickNumber(raw.maxGapHours, d.maxGapHours),
    // An absent `pinnedTimes` key keeps the default seed; an explicit empty array
    // is honoured (the operator cleared every pinned visit).
    pinnedTimes: 'pinnedTimes' in raw ? pinnedTimes : d.pinnedTimes,
  };
}

/** Merge a raw doc onto the shipped defaults. `undefined` (missing doc) → defaults. */
export function mergeCoveragePackageConfig(raw: RawRecord | undefined): CoveragePackageConfig {
  if (raw === undefined) {
    return { durations: DEFAULT_DURATIONS, rules: DEFAULT_COVERAGE_RULES };
  }
  // `exactOptionalPropertyTypes`: only attach the stamp fields when the doc
  // actually carries them, rather than setting them to `undefined`.
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined;
  const updatedBy = typeof raw.updatedBy === 'string' ? raw.updatedBy : undefined;
  return {
    durations: decodeDurations(raw.durations),
    rules: decodeRules(raw.rules),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(updatedBy !== undefined ? { updatedBy } : {}),
  };
}

/**
 * One-shot read of `coverage_package_config/config`. Returns shipped defaults for
 * a never-created doc; throws on a genuine read failure for the caller to surface.
 */
export async function getCoveragePackageConfig(): Promise<CoveragePackageConfig> {
  const snap = await getDoc(doc(db, COVERAGE_PACKAGE_COLLECTION, COVERAGE_PACKAGE_DOC_ID));
  return mergeCoveragePackageConfig(snap.exists() ? (snap.data() as RawRecord) : undefined);
}
