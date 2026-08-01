import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';

/**
 * Lists the untriaged orphan `kin_care_reports`: the KinTale Logs "Needs
 * triage" section's read side, companion to `triageOrphanReport.ts` (the
 * write side, ASSIGN / DUPLICATE / ARCHIVE).
 *
 * WHY THIS EXISTS AS ITS OWN CALLABLE, NOT A CLIENT-SIDE FILTER OVER THE MAIN
 * LIST. The admin's KinTales list (`api/kinTales.ts#KINTALES_QUERY`) is
 * ordered `createdAt desc` and hard-capped at 200, by design, so it never
 * opens an unbounded listener (AO-29). The orphans this screen exists to
 * surface are the reverse of "recent": they are the 7 pre-cutover
 * `visit_logs` rows the May 17 migration imported with no `kinfolkId`, and
 * their `createdAt` is the MIGRATION date, not a visit date. As the live
 * collection grows past 200 newer reports, that ordered-and-capped query
 * would silently push every orphan off the page and the "Needs triage"
 * section would quietly go empty, exactly the AO-12/AO-29 failure class this
 * codebase treats as a bug rather than a display nuance. A dedicated,
 * unordered, single-filter read is what makes "an orphan is reachable
 * regardless of how many reports exist" a property of the query rather than
 * a coincidence of today's row count.
 *
 * INDEX-FREE ON PURPOSE. The query below is exactly one predicate
 * (`sentVia in [...]`), no `orderBy`. A single equality/`in` filter is served
 * by Firestore's automatic per-field index; adding an `orderBy` on a
 * different field (even `createdAt`) would turn this into a composite-index
 * query this environment cannot deploy from. Sorting instead happens in
 * memory, over the already-bounded page.
 *
 * `kinfolkId`/`triageStatus` blank-ness (the rest of Android's
 * `KinCareReport.isUntriagedOrphan()`, `data/model/Models.kt`) is filtered
 * IN MEMORY, not server-side, for the identical reason
 * `listUninvoicedSessions.ts` filters `status`/`invoiceId` in memory: a
 * second equality predicate here would also force a composite index, and a
 * report whose `kinfolkId`/`triageStatus` field is simply ABSENT (never
 * written, not merely `''`) must still count as blank, which Firestore
 * equality cannot express (`where('kinfolkId','==','')` skips a document
 * that lacks the field entirely).
 */

/** The two migration provenance markers a real orphan carries. Mirrors `KinCareReport.isUntriagedOrphan()` exactly (`legacy_orphan` Pass-1, `legacy_visit_logs` Pass-2 rename). */
const ORPHAN_SENT_VIA_MARKERS = ['legacy_orphan', 'legacy_visit_logs'] as const;

/**
 * Generous next to the one-time migration's known 7 rows, and still a hard
 * cap: this callable reads exactly one bounded query, never an unbounded scan.
 */
const MAX_RESULTS = 200;

const ORPHAN_REPORTS_COLLECTION = 'kin_care_reports';

const OrphanReportSchema = z
  .object({
    _id: z.string().min(1),
    /** Free-text report body, same shape as `KinTaleEntry.bodyCopy`; the row preview truncates it client-side. */
    bodyCopy: z.string(),
    /** One of `ORPHAN_SENT_VIA_MARKERS`, already guaranteed by the query's own `in` filter. */
    sentVia: z.string(),
    /** Free-text ISO string (or blank), same caveat as every other date field on this collection. Used only to sort the response; the row itself does not render it (mirrors Android's `OrphanRow`, which shows id + channel + body, no timestamp). */
    createdAt: z.string(),
  })
  .strict();

const Result = z
  .object({
    reports: z.array(OrphanReportSchema),
    /** Rows read before the in-memory triage filter, so an empty `reports` is distinguishable from a query that matched nothing at all. */
    scanned: z.number().int().min(0),
  })
  .strict();

export type OrphanReportEntry = z.infer<typeof OrphanReportSchema>;
export type ListOrphanReportsResult = z.infer<typeof Result>;

function isBlank(v: unknown): boolean {
  return typeof v !== 'string' || v.trim() === '';
}

export async function listOrphanReportsHandler(
  req: CallableRequest<unknown>,
): Promise<ListOrphanReportsResult> {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const snap = await db()
    .collection(ORPHAN_REPORTS_COLLECTION)
    .where('sentVia', 'in', [...ORPHAN_SENT_VIA_MARKERS])
    .limit(MAX_RESULTS)
    .get();

  const reports: OrphanReportEntry[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() as {
      kinfolkId?: unknown;
      triageStatus?: unknown;
      bodyCopy?: unknown;
      sentVia?: unknown;
      createdAt?: unknown;
    };
    // isUntriagedOrphan: kinfolkId blank AND triageStatus blank. sentVia is
    // already guaranteed to be one of the markers by the query above.
    if (!isBlank(data.kinfolkId) || !isBlank(data.triageStatus)) continue;
    reports.push({
      _id: doc.id,
      bodyCopy: typeof data.bodyCopy === 'string' ? data.bodyCopy : '',
      sentVia: typeof data.sentVia === 'string' ? data.sentVia : '',
      createdAt: typeof data.createdAt === 'string' ? data.createdAt : '',
    });
  }

  // Newest migration rows first. A blank createdAt sorts last rather than
  // being treated as "now": '' < every real ISO string lexically.
  reports.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  logEvent({
    severity: 'info',
    function: 'listOrphanReports',
    event: 'admin.orphanReports.listed',
    uid,
    extra: { scanned: snap.docs.length, matched: reports.length },
  });

  return validateResponse('listOrphanReports', Result, {
    reports,
    scanned: snap.docs.length,
  });
}

export const listOrphanReports = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listOrphanReports', listOrphanReportsHandler),
);
