import type { Timestamp } from 'firebase/firestore';
import { formatWhen, type FsTime } from './time';
import { str } from './coerce';

/**
 * Pure Tribal Intel ("The Den · Tribal Intel", nav slug `tribal-intel`) list
 * classification + display helpers, kept out of the screen so the mapping
 * logic has direct vitest coverage (the kinTaleFormat.ts / invoiceFormat.ts
 * convention).
 *
 * SOURCE CONFIRMED against the real backend, not assumed from the Kotlin
 * model alone:
 *  - `firestore.rules:616`, `match /training_documents/{id}`
 *    (`allow read: if isAuntie(); allow write: if false;`): a flat top-level
 *    collection the admin reads directly (same shape as
 *    KINTALES_QUERY/INVOICES_QUERY), but every WRITE goes only through the
 *    createTrainingDocument / updateTrainingDocument / deleteTrainingDocument
 *    admin callables (out of scope for this list-only port).
 *  - `MyTribe/functions/src/admin/createTrainingDocument.ts`: the real
 *    writer. Stamps `createdAt: FieldValue.serverTimestamp()` (a REAL
 *    Firestore Timestamp, unlike `kin_care_reports.createdAt`, which is a
 *    client `nowIsoUtc()` string) and `uploadedAt: new Date().toISOString()`
 *    (an opaque, client-computed UTC string: the AO-18 caveat below).
 *    `reconcileStatus` is stamped `'pending'` on every create.
 *  - `MyTribe/functions/src/admin/updateTrainingDocument.ts`: confirms
 *    `uploadedAt` is NOT re-stamped on edit (only `updatedAt`/`updatedBy`/
 *    the reconcile fields are), so it stays the original creation instant.
 *  - `composeApp/.../data/FirestoreClient.kt:2622` (`data class
 *    TrainingDocument`): the wasm's own field shapes, read via a plain
 *    `collectionStream("training_documents")` with NO orderBy/limit (the
 *    AO-29 pattern `TRIBAL_INTEL_QUERY` in `api/tribalIntel.ts` closes off).
 *
 * ── THE AO-18 FIX, non-negotiable per the port brief ───────────────────────
 * The wasm's `TrainingDocumentsScreen.kt#DocCard` renders `doc.uploadedAt`
 * as the RAW ISO string verbatim (`doc.uploadedAt.ifBlank { "-" }`) with no
 * formatting at all. That is not itself a UTC-slice bug, but it is exactly
 * the free-text-ISO-field shape `sessionFormat.ts#sessionTimeOf` /
 * `kinTaleFormat.ts#kinTaleTimeOf` exist to handle honestly: this module
 * wraps it the same way and renders a LOCAL, human time instead of leaking a
 * raw `2026-07-16T13:00:00.000Z` string into the row.
 */

// ── ISO-string → local time (the AO-18 fix) ─────────────────────────────────

/**
 * Wraps a `training_documents.uploadedAt` free-text ISO field as a fake
 * Firestore `Timestamp` so it can flow through `lib/time.ts`'s LOCAL
 * `formatWhen` unchanged. `null` for blank/unparseable input: same "degrade
 * honestly, never fabricate a date" contract `kinTaleFormat.ts#kinTaleTimeOf`
 * uses.
 */
export function tribalIntelTimeOf(iso: string): FsTime {
  const trimmed = iso.trim();
  if (trimmed === '') return null;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return { toDate: () => d } as unknown as Timestamp;
}

/**
 * "Jul 16 14:32"-shaped LOCAL time for a document's `uploadedAt`, or
 * `'Date TBD'` when it is blank or unparseable: never a fabricated time,
 * and never the raw UTC string the wasm reference shows verbatim.
 */
export function tribalIntelWhen(uploadedAt: string): string {
  const trimmed = uploadedAt.trim();
  if (trimmed === '') return 'Date TBD';
  const formatted = formatWhen(tribalIntelTimeOf(trimmed));
  return formatted === '(no time)' ? 'Date TBD' : formatted;
}

// ── title ────────────────────────────────────────────────────────────────

/** "Untitled Document" fallback, matching `TrainingDocumentsScreen.kt#DocCard`'s own copy. */
export function tribalIntelTitle(title: string): string {
  const t = title.trim();
  return t === '' ? 'Untitled Document' : t;
}

/** True when the row is rendering the fallback title (drives the italic/dim styling the wasm card uses). */
export function isTribalIntelTitleFallback(title: string): boolean {
  return title.trim() === '';
}

// ── related-to / attachment pips ─────────────────────────────────────────

/** The free-text `kinfolkRef` household label, or `null` when blank (never renders "Related to: " with nothing after it). */
export function relatedToLabel(kinfolkRef: string): string | null {
  const t = kinfolkRef.trim();
  return t === '' ? null : t;
}

/** "3 attachments" / "1 attachment", or `null` for zero: never a misleading "0 attachments" pip (the KinTales media-pip convention). */
export function attachmentCountLabel(count: number): string | null {
  if (count <= 0) return null;
  return `${count} attachment${count === 1 ? '' : 's'}`;
}

// ── comm. type distinct list + filtering ─────────────────────────────────

/**
 * The subset `distinctCommTypes` needs from a row: a `Pick`, not the full
 * entry. Optional to match `TribalIntelEntry`, which is a cast over raw
 * Firestore data rather than a validation of it: a doc with no
 * `communicationType` key must classify as blank, never throw on `.trim()`.
 */
export interface CommTypeInput {
  communicationType?: string | undefined;
}

/**
 * Every distinct, non-blank `communicationType` across `docs`, in FIRST-
 * OCCURRENCE order (not alphabetical): mirrors the wasm's own
 * `state.allDocs.map { it.communicationType }.filter { isNotBlank }.distinct()`,
 * which drives its dynamic comm.-type filter chips.
 */
export function distinctCommTypes<T extends CommTypeInput>(docs: readonly T[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of docs) {
    const t = str(d.communicationType).trim();
    if (t === '' || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Keeps only rows whose `communicationType` exactly matches `selected`. `null` (the "All" tab) is a no-op. */
export function filterByCommType<T extends CommTypeInput>(docs: readonly T[], selected: string | null): T[] {
  if (selected === null) return [...docs];
  return docs.filter((d) => str(d.communicationType) === selected);
}

// ── free-text search ──────────────────────────────────────────────────────

/**
 * The subset `filterTribalIntel` searches: a `Pick`, not the full entry.
 * Optional for the same reason as `CommTypeInput`: an absent field is simply
 * not searchable text, and must not throw mid-keystroke and blank the screen.
 */
export interface SearchableTribalIntelInput {
  title?: string | undefined;
  content?: string | undefined;
  communicationType?: string | undefined;
}

/**
 * Client-side search across title, content, and comm. type, case-insensitive.
 * Mirrors the wasm's own `filter()` in `TrainingDocumentsViewModel.kt` and the
 * `filterSchemas`/`AuntieSearchField` convention this admin already ships
 * (FormSchemas.tsx).
 */
export function filterTribalIntel<T extends SearchableTribalIntelInput>(
  docs: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...docs];
  return docs.filter(
    (d) =>
      str(d.title).toLowerCase().includes(q) ||
      str(d.content).toLowerCase().includes(q) ||
      str(d.communicationType).toLowerCase().includes(q),
  );
}

// ── reconcile status classification (positive enumeration, no negation) ────

/**
 * Every state this module will ever return. `reconcileStatus` defaults to
 * `''` on any `training_documents` doc written before spec 23 shipped (the
 * pre-Tribal-Intel-write-tool era): `'none'` is that HONEST, DISTINCT
 * bucket, not folded into `'unknown'`: a blank field is "no reconcile pass
 * has ever been queued for this doc", which is a different fact than "some
 * recognized-but-foreign status text landed here". `createTrainingDocument.ts`
 * stamps `'pending'` on every real create and both the create/update
 * callables re-queue `'pending'` on every edit; the nightly Python reconcile
 * pipeline is what can move a doc to `'applied'`/`'skipped'`/`'error'` (see
 * `TrainingDocumentsScreen.kt#DocCard`'s own reconcile-status chip, which
 * this ports). `'unknown'` covers any other non-blank text (the AO-12
 * lesson: every branch below is a positive match against the literal text,
 * never "not one of the others, so must be Y").
 */
export type ReconcileState = 'none' | 'pending' | 'applied' | 'skipped' | 'error' | 'unknown';

/** Classifies one document's free-text `reconcileStatus`, case-insensitively. */
export function reconcileState(reconcileStatus: string): ReconcileState {
  const s = reconcileStatus.trim().toLowerCase();
  if (s === '') return 'none';
  switch (s) {
    case 'pending':
      return 'pending';
    case 'applied':
      return 'applied';
    case 'skipped':
      return 'skipped';
    case 'error':
      return 'error';
    default:
      return 'unknown';
  }
}

export interface ReconcileStateInfo {
  label: string;
  chipLabel: string;
  cssClass: string;
}

/** Friendly label + chip class per state. Pure 1:1 map, no fallback branch. */
export function reconcileStateInfo(state: ReconcileState): ReconcileStateInfo {
  switch (state) {
    case 'none':
      return { label: 'Not yet queued', chipLabel: 'NONE', cssClass: 'none' };
    case 'pending':
      return { label: 'Queued for reconcile', chipLabel: 'PENDING', cssClass: 'pending' };
    case 'applied':
      return { label: 'Folded into dossier/411', chipLabel: 'APPLIED', cssClass: 'applied' };
    case 'skipped':
      return { label: 'Skipped', chipLabel: 'SKIPPED', cssClass: 'skipped' };
    case 'error':
      return { label: 'Reconcile error', chipLabel: 'ERROR', cssClass: 'error' };
    case 'unknown':
      return { label: 'Unknown', chipLabel: 'UNKNOWN', cssClass: 'unknown' };
  }
}
