import { call } from '../lib/fns';

/**
 * AO-39 Expiration Countdown. Admin-gated MyTribe callables over the new
 * top-level `expirations` collection (admin-only read+write in firestore.rules).
 * Shapes are fixed by WIDGET_FANOUT_SPEC.md so all three platforms match.
 *
 * `dateIso` is a plain `YYYY-MM-DD` calendar date (not an instant), the day the
 * thing lapses. The server sorts by `dateIso` ascending; the widget re-filters
 * to the near horizon via `lib/dashboardInsights.ts#upcomingExpirations`.
 */

/** The kinds of thing that can expire. Free-text on the doc; one of these. */
export type ExpirationKind = 'gateCode' | 'vetRecord' | 'card' | 'license' | 'other';

/**
 * One `expirations/{id}` row as returned by `listExpirations`.
 *
 * Every string field is OPTIONAL because this interface is a cast over raw
 * Firestore document data, not a validation of it. Nothing enforces that a doc
 * carries `label`, `dateIso` or `kind`, so declaring them non-null was a lie
 * that let a string method throw on undefined and blank the whole dashboard
 * through React's error boundary. Default at the point of use (`?? ''` or
 * `lib/coerce.ts#str`) so one legacy row degrades to one dull row.
 */
export interface ExpirationRow {
  _id: string;
  label?: string | undefined;
  /** `YYYY-MM-DD` calendar date the item lapses. */
  dateIso?: string | undefined;
  /** Optional household this belongs to; blank when it is a global expiry. */
  kinfolkId?: string | undefined;
  /** One of ExpirationKind; free-text on the source doc, so typed loosely. */
  kind?: string | undefined;
}

/**
 * `listExpirations` (admin-gated): every tracked expiry, server-sorted by
 * `dateIso` ascending. Throws (via `lib/fns.call`) on failure, surfaced
 * fail-loud by the widget rather than swallowed to an empty list.
 */
export async function listExpirations(): Promise<ExpirationRow[]> {
  const res = await call<Record<string, never>, { expirations?: ExpirationRow[] }>(
    'listExpirations',
    {},
  );
  return res.expirations ?? [];
}

/** What `upsertExpiration` writes. Omit `expirationId` to create; pass it to update. */
export interface UpsertExpirationInput {
  expirationId?: string;
  label: string;
  dateIso: string;
  kind: ExpirationKind;
  kinfolkId?: string;
}

/** `upsertExpiration` (admin-gated): create or update an expiry, returns its id. */
export async function upsertExpiration(input: UpsertExpirationInput): Promise<{ id: string }> {
  const res = await call<UpsertExpirationInput, { id: string }>('upsertExpiration', input);
  return { id: res.id };
}
