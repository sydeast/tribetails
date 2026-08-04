import { str } from './coerce';
import { tsToDate } from './time';
import { kinTaleTimeOf } from './kinTaleFormat';
import type { KinTaleEntry } from '../api/kinTales';
import type { GeneratedDraftRow } from '../api/drafts';

/**
 * The KinTales LIST's row model: one KinTale, from either of the two
 * collections a KinTale currently lives in.
 *
 * ── THE DEFECT THIS MODULE CLOSES ───────────────────────────────────────────
 * The admin KinTales screen read `kin_care_reports` only. It has a Drafts
 * bucket in its own stat strip and a Drafts tab in its own filter row, and both
 * read 0 forever, because a KinTale in draft state is not written to
 * `kin_care_reports` by the generator at all, it is written to
 * `generated_drafts`. Home's "KinTales pending" panel read that second
 * collection, so the same session showed KinTales on Home and "No KinTales in
 * the last 30 days" on the KinTales screen.
 *
 * The operator's ruling, 2026-08-04, verbatim: "generated drafts are just
 * drafts of the kintales, when i generate a copy from the text generator, the
 * copy it makes is what generated-drafts was". One entity. Two collections.
 * This module is the join, kept pure and out of the screen so every rule below
 * has direct vitest coverage (the `sessionFormat.ts` / `kinTaleFormat.ts`
 * convention).
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * It is not the destination. The right long-term shape is ONE collection with a
 * status field and the other treated as legacy; a client-side join cannot page,
 * cannot window server-side, and inherits both writers' field spellings. That
 * is a data migration, not a screen fix. This module makes the screen honest
 * TODAY and states its own limits on screen rather than quietly presenting a
 * partial list as a whole one.
 */

/** Which collection a row came out of. Rendered nowhere; used for keys and for the detail route a later phase will wire. */
export type KinTaleSource = 'kin_care_reports' | 'generated_drafts';

export interface KinTaleListRow extends KinTaleEntry {
  source: KinTaleSource;
  /**
   * `generated_drafts` only: the draft's `communication_type`, humanised
   * ("visit_report" -> "visit report"), or blank.
   *
   * Shown on the row because this collection holds drafts of EVERY generator
   * output, not only visit recaps: `generate.js`'s `ALLOWED_TYPES` covers sms,
   * email, push, visit_report, social_post, blog_post and general. Under the
   * operator's ruling all of them are drafts of something that goes to a
   * kinfolk, so none is filtered out here (filtering would re-hide rows Home
   * already shows, which is the bug, not the fix). Naming the type on the row
   * is what keeps that honest: an sms draft reads as an sms draft rather than
   * silently as a visit recap.
   */
  draftType?: string | undefined;
}

// ── reading a draft doc, which has two writers ──────────────────────────────

/** First non-blank of the two spellings this collection is written in. See `GeneratedDraftRow`'s field notes. */
function either(a: unknown, b: unknown): string {
  const first = str(a).trim();
  return first !== '' ? first : str(b).trim();
}

/** The draft's household name, either spelling. */
export function draftHousehold(draft: GeneratedDraftRow): string {
  return either(draft.kinfolkName, draft.kinfolk_name);
}

/** The draft's household FK, either spelling. */
export function draftKinfolkId(draft: GeneratedDraftRow): string {
  return either(draft.kinfolk_id, draft.kinfolkId);
}

/** The draft's body copy, either spelling. */
export function draftBody(draft: GeneratedDraftRow): string {
  return either(draft.generatedCopy, draft.generated_copy);
}

/** The generator's title, either spelling. Blank means "no title", which the row renders as a body preview. */
export function draftTitle(draft: GeneratedDraftRow): string {
  return either(draft.generatedTitle, draft.generated_title);
}

/**
 * The draft's creation instant as free ISO-ish text: `createdOn` (the
 * migrated/n8n spelling, and the field `GENERATED_DRAFTS_QUERY` sorts on) then
 * `generated_at` (generate.js's). Blank when neither is set, which the row
 * renders as "Date TBD" rather than a fabricated time.
 */
export function draftCreatedAt(draft: GeneratedDraftRow): string {
  return either(draft.createdOn, draft.generated_at);
}

/**
 * A draft's `communication_type`, humanised for display. Either spelling,
 * underscores spaced out, matching what `pendingTaleRows` already prints on
 * Home so the two surfaces name the same draft the same way.
 */
export function draftTypeLabel(draft: GeneratedDraftRow): string {
  return either(draft.communicationType, draft.communication_type).replace(/_/g, ' ').trim();
}

/**
 * Map a `generated_drafts` status onto the list's own `KinTaleState`
 * vocabulary, POSITIVELY (the AO-12 convention `kinTaleState` documents: every
 * branch is a match on literal text, never "not one of the others").
 *
 * `generated` and `pending` are the two codes that mean nobody has signed this
 * off yet (`generate.js` writes `'generated'`; android's `Draft` defaults to
 * `'pending'` and `getPendingDraftCount` counts exactly that string). Blank
 * counts too: a draft doc with no status is still an unsent draft, and android's
 * model defaults it to `pending` for the same reason.
 *
 * EVERYTHING ELSE IS PASSED THROUGH UNMAPPED, which makes it `'unknown'`, and
 * that is a deliberate refusal rather than an oversight. `approved` is the
 * obvious candidate for "sent", and it is not one: `approveGeneratedDraft`
 * stamps `status: 'approved'` BEFORE the send and stamps nothing at all
 * afterwards, so an approved doc is equally consistent with a delivered message
 * and with a delivery that threw. Calling it Sent would be inventing a delivery
 * receipt. `unknown` rows still appear under the All tab, exactly as an
 * unrecognised `kin_care_reports` status does; they are simply not counted as
 * Sent, Drafts or Needs-another-look.
 */
export function draftStatusAsKinTaleStatus(status: string): string {
  switch (str(status).trim().toLowerCase()) {
    case 'generated':
    case 'pending':
    case '':
      return 'DRAFT';
    default:
      return str(status);
  }
}

// ── the two adapters ───────────────────────────────────────────────────────

/** A `kin_care_reports` row, tagged with where it came from. No field is rewritten. */
export function rowFromReport(entry: KinTaleEntry): KinTaleListRow {
  return { ...entry, source: 'kin_care_reports' };
}

/**
 * A `generated_drafts` doc as a KinTale list row.
 *
 * `_id` is NAMESPACED (`generated_drafts/<id>`) rather than passed through. Two
 * collections can hold the same document id, and this id is a React key today
 * and a detail route's argument tomorrow; an unnamespaced collision would
 * render one row and open the wrong document. Callers that need the bare id
 * have `source` plus the prefix to strip.
 *
 * Every field a draft genuinely has no answer for is left ABSENT, not filled
 * with a plausible-looking blank: no `sentVia` (nothing was sent, and a blank
 * one would render the misleading "imported" pip `sentViaLabel` documents), no
 * `serviceType` (a draft is not attached to a visit), no `mediaFileIds`,
 * no `sessionId`. `createdAt` carries the draft's own creation instant so the
 * row dates itself through the same `kinTaleWhen` path every report uses.
 */
export function rowFromDraft(draft: GeneratedDraftRow): KinTaleListRow {
  const type = draftTypeLabel(draft);
  return {
    _id: `generated_drafts/${draft._id}`,
    source: 'generated_drafts',
    kinfolkId: draftKinfolkId(draft),
    kinfolkName: draftHousehold(draft),
    title: draftTitle(draft),
    bodyCopy: draftBody(draft),
    status: draftStatusAsKinTaleStatus(str(draft.status)),
    createdAt: draftCreatedAt(draft),
    ...(type !== '' ? { draftType: type } : {}),
  };
}

// ── the window and the facet, applied client-side to drafts ────────────────

export interface DraftWindowOptions {
  /** The toolbar's lower bound, or null for "All (archive)". Same value the reports query gets as a server predicate. */
  startIso: string | null;
  /** The household facet. Blank means every household. */
  kinfolkId?: string | undefined;
}

/**
 * Narrow the loaded drafts to the same window and household the reports query
 * was given, CLIENT-SIDE.
 *
 * It has to be client-side, and that is a real limitation rather than a
 * shortcut. The reports side windows on `createdAt` server-side because that
 * field is an ISO string that compares correctly against `rangeStartIso`'s
 * output. The drafts side cannot: `GENERATED_DRAFTS_QUERY` already orders on
 * `createdOn`, adding a range predicate on a DIFFERENT field would need a
 * composite index and a second sort key, and half the docs date themselves on
 * `generated_at` instead. So the drafts stream stays exactly the spec Home
 * already uses (one Watch target, see `api/drafts.ts`) and the narrowing
 * happens here, over the newest 50. The screen says so.
 *
 * AN UNDATED DRAFT IS KEPT, not dropped. Dropping it would hide a real row for
 * the one reason the operator cannot see from the screen; keeping it costs a
 * row that sorts last (see `mergeByCreatedDesc`). Silent omission is the
 * failure this codebase is built to refuse.
 */
export function draftsInWindow(
  drafts: readonly GeneratedDraftRow[],
  { startIso, kinfolkId }: DraftWindowOptions,
): GeneratedDraftRow[] {
  const bound = startIso === null ? null : Date.parse(startIso);
  const wantHousehold = str(kinfolkId).trim();
  return drafts.filter((d) => {
    if (wantHousehold !== '' && draftKinfolkId(d) !== wantHousehold) return false;
    if (bound === null || Number.isNaN(bound)) return true;
    const at = createdMs({ createdAt: draftCreatedAt(d) });
    return at === null || at >= bound;
  });
}

// ── the merge ──────────────────────────────────────────────────────────────

/**
 * A row's creation instant in ms, or null when the field is blank or
 * unparseable.
 *
 * Through `kinTaleTimeOf`, never `new Date()` directly: 83 of the 92 live
 * `kin_care_reports` store "September 3, 2025 2:02pm", which `new Date()`
 * rejects outright (see `kinTaleFormat.ts` and `parseFlexibleDate`). A bare
 * parse here would call the majority of the archive undated.
 */
function createdMs(row: Pick<KinTaleEntry, 'createdAt'>): number | null {
  // `tsToDate`, not `t.toDate()`: FsTime is `Timestamp | null | undefined`.
  const d = tsToDate(kinTaleTimeOf(str(row.createdAt)));
  return d === null ? null : d.getTime();
}

/**
 * Interleave two ALREADY-ORDERED lists into one newest-first list.
 *
 * ── WHY A MERGE AND NOT A SORT, WHICH MATTERS MORE THAN IT LOOKS ────────────
 * The reports list arrives in the order Firestore returned it: `createdAt`
 * descending, compared as STRINGS by the server. Re-sorting the combined array
 * would re-sort the reports among themselves using a parsed-date comparison the
 * server never used, and those two orders disagree on exactly the rows whose
 * `createdAt` is the "September 3, 2025 2:02pm" free text rather than ISO. That
 * would silently reshuffle a paged list against its own cursor. So this is a
 * merge step, not a sort: each input keeps its own internal order EXACTLY, and
 * the only decision made here is which list to take the next row from.
 *
 * An undated row never wins a comparison, so it lands after everything dated in
 * the other list while holding its place within its own. It is never dropped.
 */
export function mergeByCreatedDesc(
  reports: readonly KinTaleListRow[],
  drafts: readonly KinTaleListRow[],
): KinTaleListRow[] {
  const out: KinTaleListRow[] = [];
  let i = 0;
  let j = 0;
  while (i < reports.length && j < drafts.length) {
    // Non-null: both indices are bounds-checked by the loop condition.
    const a = reports[i]!;
    const b = drafts[j]!;
    const ta = createdMs(a);
    const tb = createdMs(b);
    if (tb === null || (ta !== null && ta >= tb)) {
      out.push(a);
      i += 1;
    } else {
      out.push(b);
      j += 1;
    }
  }
  return [...out, ...reports.slice(i), ...drafts.slice(j)];
}

/**
 * The list the KinTales screen renders: the loaded page of `kin_care_reports`
 * plus every loaded `generated_drafts` doc that falls in the same window and
 * household, newest first.
 */
export function kinTaleListRows(
  reports: readonly KinTaleEntry[],
  drafts: readonly GeneratedDraftRow[],
  options: DraftWindowOptions,
): KinTaleListRow[] {
  return mergeByCreatedDesc(
    reports.map(rowFromReport),
    draftsInWindow(drafts, options).map(rowFromDraft),
  );
}
