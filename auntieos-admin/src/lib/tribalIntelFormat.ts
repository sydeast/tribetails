import type { Timestamp } from 'firebase/firestore';
import { formatWhen, type FsTime } from './time';
import { str } from './coerce';
import { householdLabel, kinfolkDisplayName, type Kin, type Kinfolk } from '../api/directory';

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
 *    KINTALES_QUERY/INVOICES_QUERY). WRITEs go through the
 *    createTrainingDocument / updateTrainingDocument / deleteTrainingDocument
 *    admin callables, which the TribalIntel screen's create/update/delete UI invokes.
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

// ── who the entry is about (issue #393) ──────────────────────────────────

/**
 * The three things a Tribal Intel entry can be about, in this codebase's own
 * nouns:
 *
 *   household  the whole family, `families/{kinfolkId}`: every kinfolk and
 *              every kin under one roof.
 *   kinfolk    one human client, `kinfolk/{kinfolkId}`.
 *   kin        one animal, `kin/{kinId}`.
 *
 * The screen used to know only two, and called the wider one "Whole
 * household" while storing it as KINFOLK, so a note about one person read as a
 * note about everyone. The operator ruling on #393 is these three, named
 * separately.
 */
export type TribalIntelTargetKind = 'household' | 'kinfolk' | 'kin';

/** A resolved target: what kind of thing, and the id of the one it names. */
export interface TribalIntelTarget {
  kind: TribalIntelTargetKind;
  /** `''` when the entry carries no usable id, which reads as "unnamed". */
  id: string;
}

/** The subset `tribalIntelTarget` reads. Optional throughout, same cast-not-validation rule as `TribalIntelEntry`. */
export interface TargetInput {
  targetType?: string | undefined;
  targetKinfolkId?: string | undefined;
  targetKinId?: string | undefined;
  kinfolkRef?: string | undefined;
}

/**
 * Classifies one entry's stored target, by POSITIVE match on the stored text
 * (the `reconcileState` convention: never "not one of the others, so it must
 * be Y").
 *
 * THE READ-TIME DEFAULT IS `household`, and it is a deliberate choice about
 * documents this change did not write:
 *
 *  - A row from the NDJSON migration import carries `kinfolkRef` and no
 *    `targetType` at all. The only thing it names is the household anchor, so
 *    `household` is the widest honest reading; calling it `kinfolk` would
 *    claim the note is about one person when the document never said so.
 *    It is also what the nightly reconcile pipeline already does with such a
 *    row (`reconcile_comms.py#derive_kin_ids` falls through to every kin in
 *    the household).
 *  - A `KIN` row whose `targetKinId` is blank names no animal, so it cannot
 *    render as one. Same fall-through.
 *
 * A stored `KINFOLK` reads as one human client, which is the fix the issue
 * asks for: "target is missing kinfolk or incorrectly states Whole household
 * when its for the kinfolk". Nothing is backfilled; a legacy row gains an
 * explicit `targetType` the first time an operator saves it.
 */
export function tribalIntelTarget(entry: TargetInput): TribalIntelTarget {
  // Pre-spec-23 rows carry only `kinfolkRef`, so it is the anchor of last resort.
  const named = str(entry.targetKinfolkId).trim();
  const anchor = named === '' ? str(entry.kinfolkRef).trim() : named;
  const stored = str(entry.targetType).trim().toUpperCase();
  const kinId = str(entry.targetKinId).trim();

  if (stored === 'KIN' && kinId !== '') return { kind: 'kin', id: kinId };
  if (stored === 'KINFOLK' && anchor !== '') return { kind: 'kinfolk', id: anchor };
  return { kind: 'household', id: anchor };
}

/**
 * The word each target goes by on screen. Byte-identical to Android's
 * `TrainingDocumentsScreen.kt#targetKindLabel`, so an operator reading the
 * same entry on both clients reads the same word.
 */
export function tribalIntelTargetKindLabel(kind: TribalIntelTargetKind): string {
  switch (kind) {
    case 'household':
      return 'Household';
    case 'kinfolk':
      return 'Kinfolk';
    case 'kin':
      return 'Kin';
  }
}

/**
 * Resolves a target to the name of the thing it points at: the household
 * label ("the Halbrooks"), the kinfolk's own name, or the kin's name.
 *
 * Falls back to the raw id when the roster holds no match, which is honest
 * rather than blank: a note pointing at a household that has since been
 * deleted still shows WHICH id it pointed at, and the operator can act on
 * that. Returns `null` only when the entry names nothing at all, so the row
 * renders no target line instead of a label with an empty tail.
 */
export function tribalIntelTargetName(
  target: TribalIntelTarget,
  kinfolk: readonly Kinfolk[],
  kin: readonly Kin[],
): string | null {
  if (target.id === '') return null;

  if (target.kind === 'kin') {
    const match = kin.find((k) => k._id === target.id);
    if (match === undefined) return target.id;
    const name = str(match.name).trim();
    return name === '' ? target.id : name;
  }

  const match = kinfolk.find((kf) => kf._id === target.id);
  if (match === undefined) return target.id;
  if (target.kind === 'kinfolk') return kinfolkDisplayName(match);
  // A household is named after the surname it shares. A kinfolk with no last
  // name on file has no household label to build, so the person's own display
  // name carries it rather than an empty string.
  const label = householdLabel(str(match.lastName));
  return label === '' ? kinfolkDisplayName(match) : label;
}

/** "Household: the Halbrooks" / "Kinfolk: Jane Halbrook" / "Kin: Rufus", or `null` when the entry names nobody. */
export function tribalIntelTargetLabel(
  entry: TargetInput,
  kinfolk: readonly Kinfolk[],
  kin: readonly Kin[],
): string | null {
  const target = tribalIntelTarget(entry);
  const name = tribalIntelTargetName(target, kinfolk, kin);
  if (name === null) return null;
  return `${tribalIntelTargetKindLabel(target.kind)}: ${name}`;
}

/** "3 attachments" / "1 attachment", or `null` for zero: never a misleading "0 attachments" pip (the KinTales media-pip convention). */
export function attachmentCountLabel(count: number): string | null {
  if (count <= 0) return null;
  return `${count} attachment${count === 1 ? '' : 's'}`;
}

// ── junk-row filtering ────────────────────────────────────────────────────

/**
 * The subset `dropEmptyTribalIntel` reads: a `Pick`, not the full entry, and
 * every field optional for the same reason as `TribalIntelEntry` itself. The
 * rows this filter exists to catch are precisely the ones missing every field.
 */
export interface EmptyCheckInput {
  title?: string | undefined;
  content?: string | undefined;
  attachments?: readonly unknown[] | undefined;
}

/**
 * Drops content-less junk rows: leftover all-null import/seed documents with
 * nothing in them. Without this they render as "Untitled Document" with a blank
 * body and inflate the Total / Comm. types / With content counts, so the
 * operator sees documents that are not documents.
 *
 * Ports the archive's own filter (`TrainingDocumentsViewModel.kt`:
 * `result.value.filter { it.title.isNotBlank() || it.content.isNotBlank() }`,
 * which spec 23 item 4 records as already-correct behavior) and the identical
 * line in Android's `TrainingDocumentsScreen.kt`.
 *
 * ONE DELIBERATE WIDENING of the archive rule: an entry with attachments but no
 * text is KEPT. When the archive was written, `createTrainingDocument` did not
 * exist and attachments were not part of the model, so a row could only be real
 * if it carried text. The deployed callable now accepts "title OR content OR at
 * least one attachment", so an attachment-only entry is a legitimately saved
 * one. The narrower rule would hide the operator's own photo-only note the
 * moment it was saved, which is a worse failure than the junk it was written
 * to catch.
 *
 * Applied ONCE, before both the stat strip and the list, so the counts can
 * never describe a different set of rows than the ones on screen (the parity
 * bug the Android summary row had: it filtered the list but counted the raw
 * stream).
 */
export function dropEmptyTribalIntel<T extends EmptyCheckInput>(docs: readonly T[]): T[] {
  return docs.filter(
    (d) => str(d.title).trim() !== '' || str(d.content).trim() !== '' || (d.attachments?.length ?? 0) > 0,
  );
}

// ── honesty copy (shared by the form, the screen banner, and the confirm) ──

/**
 * Shown after a successful create or update.
 *
 * The reconcile pipeline is a NIGHTLY pass. A saved entry lands with
 * `reconcileStatus: 'pending'` and nothing about the dossier or the 411 has
 * changed yet, so this copy names the next pass and refuses the word
 * "instantly". Wording carried over verbatim from the archive ViewModel and
 * Android's `AdminDataViewModel`, so all three clients make the same promise.
 */
export const TRIBAL_INTEL_QUEUED_MESSAGE =
  'Queued for reconcile. The dossier and 411 update on the next reconcile pass, not instantly.';

/**
 * Shown in the delete confirm, before the operator can commit.
 *
 * `deleteTrainingDocument` removes the source note and nothing else. Its own
 * audit payload records the caveat: "Already-folded dossier/411 text is not
 * retroactively unmerged." Deleting an entry that a prior pass already folded
 * therefore leaves that text in the summaries until they are regenerated, and
 * an operator deleting something they regret writing needs to know that BEFORE
 * they confirm, not after.
 */
export const TRIBAL_INTEL_DELETE_CAVEAT =
  'This removes the source note. It does not unmerge any text the reconcile pipeline has already folded ' +
  'into the dossier or the 411. Those summaries keep the earlier wording until they are regenerated.';

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
