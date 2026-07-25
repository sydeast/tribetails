import { doc, getDoc } from 'firebase/firestore';
import { call } from '../lib/fns';
import { db } from '../lib/firebase';
import { parseDashboard, resolvedDashboard, toTokens, type DashWidget } from '../lib/dashboardLayout';

/**
 * 17.3 Dashboard customization: persistence for the operator's Home widget
 * layout. The model lives in `lib/dashboardLayout.ts`; this is only the seam
 * between it and the stored field.
 *
 * The layout is an ordered "key:size" token list at
 * `users/{uid}.dashboardWidgets`, the SAME field android reads and writes
 * (`AuntieRepository.saveUserProfile`) and the superseded wasm admin used
 * before it. One field, three parsers, so a dashboard arranged on the phone
 * opens arranged here.
 *
 * The two halves take different routes ON PURPOSE:
 *
 * - READ is a direct `getDoc`. `firestore.rules` already grants an admin
 *   `read` on `users/{uid}`, and `api/account.ts` reads the rest of this same
 *   document exactly this way. A callable would add a cold start to Home's
 *   first paint and buy nothing.
 * - WRITE goes through the `saveDashboardLayout` callable. The same rule grants
 *   `write`, so this buys no access; it buys validation and a smaller blast
 *   radius. The rule checks nothing about what lands in the field, and android's
 *   client-side save rewrites the WHOLE user document, which is why it has to
 *   re-read the profile first so a theme pref saved elsewhere is not clobbered.
 *   The callable writes one field with `{ merge: true }`, so that hazard does
 *   not exist on this surface.
 *   See `mytribe/functions/src/admin/saveDashboardLayout.ts`.
 *
 * Both halves fail loud. A read rejection propagates rather than quietly
 * returning the shipped default, which would show the operator a dashboard that
 * is not theirs and say nothing. A save rejection propagates so the caller can
 * revert the on-screen order and name the failure, rather than leaving an
 * arrangement on screen that no longer exists anywhere.
 */

/**
 * The cap the callable enforces (`.max(30)`). Mirrored here so an over-long
 * list is refused with a readable message before a round trip, instead of
 * coming back as a generic `invalid-argument`.
 */
export const MAX_DASHBOARD_TOKENS = 30;

/** Keeps only the strings out of a raw stored array; the model drops the rest. */
function readTokens(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * The operator's saved layout, or the shipped default when nothing readable is
 * stored (a new operator, or a document written before this feature existed).
 * A genuine read rejection propagates.
 */
export async function getDashboardLayout(uid: string): Promise<DashWidget[]> {
  const id = uid.trim();
  if (id === '') throw new Error('getDashboardLayout requires a uid');

  const snap = await getDoc(doc(db, 'users', id));
  if (!snap.exists()) return resolvedDashboard([]);
  const raw = (snap.data() as Record<string, unknown> | undefined)?.['dashboardWidgets'];
  return resolvedDashboard(readTokens(raw));
}

/**
 * Persists the layout and returns what the SERVER stored, parsed back through
 * the model. The caller holds an optimistic order on screen; reconciling it
 * against the stored list is the only way to be sure the two agree. Rejects on
 * any failure, never resolves on a write that did not land.
 *
 * No uid is sent. The callable writes `req.auth.uid`, so this cannot target
 * another operator's dashboard even if something asked it to.
 */
export async function saveDashboardLayout(list: readonly DashWidget[]): Promise<DashWidget[]> {
  const tokens = toTokens(list);
  if (tokens.length > MAX_DASHBOARD_TOKENS) {
    throw new Error(
      `A dashboard can hold at most ${MAX_DASHBOARD_TOKENS} widgets; this layout has ${tokens.length}.`,
    );
  }

  const res = await call<{ tokens: string[] }, { ok?: boolean; tokens?: unknown }>(
    'saveDashboardLayout',
    { tokens },
  );

  if (!Array.isArray(res.tokens)) {
    throw new Error(
      'saveDashboardLayout answered without the stored layout, so the save cannot be confirmed.',
    );
  }
  return parseDashboard(readTokens(res.tokens));
}
