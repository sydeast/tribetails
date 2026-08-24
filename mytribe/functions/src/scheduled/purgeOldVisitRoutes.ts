import { onSchedule } from 'firebase-functions/v2/scheduler';
import type { DocumentReference } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapScheduled } from '../lib/wrapScheduled';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { paginateQuery } from '../lib/paginateCollectionGroup';
import { readRetentionWindow } from '../lib/retentionWindow';
import { stampToMillis } from '../lib/purgeTimestamps';
import { SERIAL } from '../lib/runtimeOptions';

/**
 * ISSUE #519: `business_settings.saveRoutesForDays` becomes real.
 *
 * The field has said "Legal/liability retention", defaulted to 90 days and been
 * decoded by three admin clients since the settings unification. Nothing has
 * ever read it, so the raw GPS ping trail for every visit has accumulated
 * forever while the settings screen claimed a retention policy.
 *
 * WHAT THIS DELETES, AND NOTHING ELSE: documents in the
 * `kin_care_sessions/{sessionId}/breadcrumbs` subcollection, the raw per-ping
 * store, older than the operator's window.
 *
 * WHAT IT MUST NEVER TOUCH, spelled out because a purge is judged by what it
 * leaves alone:
 *  - `kin_care_sessions/{id}` itself. The visit, its status, its timestamps.
 *  - `kin_care_sessions/{id}.gpsSummary`, the down-sampled route baked on
 *    DEPARTED. It is a FIELD ON THE VISIT, not a breadcrumb, so this job cannot
 *    reach it, and that is deliberate rather than an oversight: after a purge
 *    the schedule and the kinfolk portal still replay the visit from
 *    `gpsSummary` (`portal/getMyVisits.ts:85`). What goes is the raw ping trail
 *    behind it, which is the bulk and the part with the retention question.
 *  - `kin_care_reports` and its `gpsRoute`. That is KinTale content.
 *  - `visit_routes` / `location_checkpoints`, a separate admin-only store with
 *    its own timestamps. Folding them in is a scope decision nobody has made.
 *  - `media_files`. Photos are not route data.
 *
 * TWO WRITERS, TWO STAMP SHAPES, ONE SUBCOLLECTION. Android writes
 * `timestamp` as epoch milliseconds (`LocationPoint.timestamp: Long`); the
 * desktop console writes it as an ISO string (`Breadcrumb.timestamp: String`).
 * `stampToMillis` reads both, and a row it cannot read is SKIPPED rather than
 * treated as ancient. See `lib/purgeTimestamps.ts`.
 *
 * UNFILTERED SCAN, CUTOFF IN MEMORY. `paginateQuery` orders every page by
 * document id, so an inequality `.where()` on `timestamp` would be refused by
 * Firestore, and a filtered collection-group query would need a composite index
 * nobody has deployed. The house answer (see that module's header) is to drain
 * unfiltered and decide per document, which is what this does.
 *
 * IDEMPOTENT AND SAFE TO RE-RUN. It deletes by age, so a second run in the same
 * window finds nothing left to delete and writes an audit entry saying zero.
 */

/** Firestore's hard cap on writes in one `WriteBatch`. */
const DELETE_BATCH_LIMIT = 500;

/** What `saveRoutesForDays` reads as when the settings document has never carried it. */
export const DEFAULT_ROUTE_RETENTION_DAYS = 90;

export interface RoutePurgeResult {
  deleted: number;
  scanned: number;
  /** Null when the run refused; the window it acted on otherwise. */
  days: number | null;
  skippedReason?: string;
}

/**
 * Delete breadcrumbs older than the operator's window. Exported for tests;
 * returns what it did rather than logging and swallowing it.
 */
export async function runVisitRoutePurge(now: number = Date.now()): Promise<RoutePurgeResult> {
  const window = await readRetentionWindow(db(), 'saveRoutesForDays', DEFAULT_ROUTE_RETENTION_DAYS, now);
  if (!window.ok) {
    // A refusal is louder than a success. A purge that quietly stops running is
    // how an archive grows forever while a settings screen claims otherwise.
    logEvent({
      severity: 'warn',
      function: 'purgeOldVisitRoutes',
      event: 'retention.purge.skipped',
      extra: { reason: window.reason },
    });
    await writeAuditEntry({
      status: 'FAILURE',
      event: AUDIT_EVENTS.RETENTION_PURGE_SKIPPED,
      severity: 'warn',
      actorRole: 'SYSTEM',
      targetCollection: 'breadcrumbs',
      description: `Visit-route purge did not run: ${window.reason}`,
      payload: { job: 'purgeOldVisitRoutes', reason: window.reason },
    });
    return { deleted: 0, scanned: 0, days: null, skippedReason: window.reason };
  }

  let staged: DocumentReference[] = [];
  let deleted = 0;
  let scanned = 0;

  async function flush(): Promise<void> {
    if (staged.length === 0) return;
    // Hand the refs off and clear BEFORE awaiting, so a rejected commit can
    // never leave the same refs staged for a second commit on a later flush.
    const chunk = staged;
    staged = [];
    const batch = db().batch();
    for (const ref of chunk) batch.delete(ref);
    await batch.commit();
    deleted += chunk.length;
  }

  await paginateQuery(
    db().collectionGroup('breadcrumbs'),
    async (docSnap) => {
      scanned += 1;
      const data = docSnap.data() as Record<string, unknown>;
      const stampedMs = stampToMillis(data['timestamp']);
      // Undated pings are left alone. Nothing should be inferred about the age
      // of a document nobody stamped.
      if (stampedMs === null) return;
      if (stampedMs >= window.cutoffMs) return;
      staged.push(docSnap.ref);
      if (staged.length >= DELETE_BATCH_LIMIT) await flush();
    },
    { functionName: 'purgeOldVisitRoutes' },
  );

  await flush();

  // ONE ENTRY PER RUN, not per document. A run clearing three thousand pings
  // would otherwise write three thousand chained entries and drown the trail it
  // exists to keep readable. A run that deleted nothing still writes one,
  // because "ran and found nothing" and "did not run" are different answers.
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.RETENTION_ROUTES_PURGED,
    severity: 'info',
    actorRole: 'SYSTEM',
    targetCollection: 'breadcrumbs',
    description: `Purged ${deleted} visit breadcrumb(s) older than ${window.days} days`,
    payload: {
      job: 'purgeOldVisitRoutes',
      deleted,
      scanned,
      retentionDays: window.days,
      retentionSource: window.source,
      cutoffIso: new Date(window.cutoffMs).toISOString(),
    },
  });

  return { deleted, scanned, days: window.days };
}

export const purgeOldVisitRoutes = onSchedule(
  // Sweeps and deletes overnight with nobody waiting, so it takes the
  // quarter-vCPU `SERIAL` shape every other purge cron takes. The 2-instance cap
  // absorbs a run that overlaps the next tick rather than piling copies up.
  { schedule: 'every day 03:30', timeZone: 'America/New_York', secrets: ['SENTRY_DSN'], ...SERIAL },
  wrapScheduled('purgeOldVisitRoutes', async () => {
    await runVisitRoutePurge(Date.now());
  }),
);
