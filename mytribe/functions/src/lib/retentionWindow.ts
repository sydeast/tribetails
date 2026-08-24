import type { Firestore } from 'firebase-admin/firestore';

/**
 * ISSUE #519: how a purge job reads its retention window off
 * `business_settings`, and every reason it refuses to run.
 *
 * The two jobs this backs (`purgeOldVisitRoutes`, `purgeOldDrafts`) DELETE
 * RECORDS PERMANENTLY, so the interesting part of this module is not the happy
 * path. It is the four ways a window can fail to be a window, and the fact that
 * every one of them stops the purge rather than falling back to a number nobody
 * chose.
 *
 * ABSENT IS THE SHIPPED DEFAULT, NOT ZERO. No settings document written before
 * this change carries either key: the fields existed on three models, were
 * editable on none, and nothing ever wrote them. Reading a missing key as 0
 * would delete everything on the first run. It reads as the number every model
 * already states and every new editor already shows (90 days of routes, 30 days
 * of drafts), which is the retention the product has been claiming all along.
 *
 * ZERO, NEGATIVE, FRACTIONAL AND NON-NUMERIC ALL REFUSE. A zero window means
 * "delete everything", and nobody has ruled that an operator may express that
 * by typing a number into a settings box; the new editors will not produce one
 * (`parseWholeNumber` bounds it at 1) so a zero on the document is a hand edit,
 * a legacy value or a bug, and none of those is an instruction to erase the
 * archive. Same for a negative, which would compute a cutoff in the FUTURE and
 * delete every record that exists.
 *
 * A READ FAILURE REFUSES. A transient Firestore error must never be read as
 * "no retention configured". This is the opposite of the choice
 * `lib/autoReminder.ts` makes for the reminder gate, and deliberately: failing
 * open there sends a message that was going to be sent anyway, failing open
 * here destroys data.
 *
 * The ceiling exists for the same reason as the floor. A window past
 * MAX_RETENTION_DAYS is not a policy, it is a typo with an extra digit, and
 * honouring it would silently turn the job off while reporting success.
 */

/** The unified settings doc every client writes (`business_settings/business_settings`). */
const BUSINESS_SETTINGS_DOC = 'business_settings/business_settings';

/**
 * The longest retention either job will act on: ten years, matching the upper
 * bound the three new editors enforce.
 */
export const MAX_RETENTION_DAYS = 3650;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** A usable window, or the reason this run must not delete anything. */
export type RetentionWindow =
  | { ok: true; days: number; cutoffMs: number; source: 'configured' | 'default' }
  | { ok: false; reason: string };

/**
 * Turn a raw field value into a window, or into a refusal. Pure, so every
 * refusal has a direct test and the rule can be read without a Firestore mock.
 *
 * `nowMs` is passed in rather than read, so a test states the cutoff instead of
 * racing the clock.
 */
export function resolveRetentionWindow(
  raw: unknown,
  shippedDefaultDays: number,
  nowMs: number,
): RetentionWindow {
  if (raw === undefined || raw === null) {
    return {
      ok: true,
      days: shippedDefaultDays,
      cutoffMs: nowMs - shippedDefaultDays * DAY_MS,
      source: 'default',
    };
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { ok: false, reason: `retention is ${JSON.stringify(raw)}, not a number` };
  }
  if (!Number.isInteger(raw)) {
    return { ok: false, reason: `retention ${raw} is not a whole number of days` };
  }
  if (raw <= 0) {
    return { ok: false, reason: `retention ${raw} is not a positive number of days` };
  }
  if (raw > MAX_RETENTION_DAYS) {
    return { ok: false, reason: `retention ${raw} is past the ${MAX_RETENTION_DAYS}-day ceiling` };
  }
  return { ok: true, days: raw, cutoffMs: nowMs - raw * DAY_MS, source: 'configured' };
}

/**
 * The window for one retention field, read off `business_settings` at RUN TIME.
 *
 * Read at run time rather than captured at deploy: the operator can change the
 * window on any of the three admin surfaces, and the next run has to honour what
 * they chose rather than what was true when the function was last shipped.
 */
export async function readRetentionWindow(
  firestore: Firestore,
  field: 'saveRoutesForDays' | 'draftRetentionDays',
  shippedDefaultDays: number,
  nowMs: number,
): Promise<RetentionWindow> {
  let raw: unknown;
  try {
    const snap = await firestore.doc(BUSINESS_SETTINGS_DOC).get();
    raw = snap.data()?.[field];
  } catch (err) {
    return { ok: false, reason: `could not read ${field}: ${(err as Error)?.message ?? 'read failed'}` };
  }
  return resolveRetentionWindow(raw, shippedDefaultDays, nowMs);
}
