import { onSchedule } from 'firebase-functions/v2/scheduler';
import type { DocumentReference } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapScheduled } from '../lib/wrapScheduled';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { paginateQuery } from '../lib/paginateCollectionGroup';
import { readRetentionWindow } from '../lib/retentionWindow';
import { firstReadableStamp } from '../lib/purgeTimestamps';
import { SERIAL } from '../lib/runtimeOptions';

/**
 * ISSUE #519: `business_settings.draftRetentionDays` becomes real.
 *
 * The Android settings panel said "Unsent drafts auto-purge after this many
 * days" for as long as the field has existed, and nothing purged anything. This
 * is that job. The copy on all three surfaces was corrected in the same change
 * so it describes what happens rather than what was promised.
 *
 * WHAT A DRAFT IS. `kin_care_reports/{id}` with `status == "DRAFT"`. A KinTale
 * the operator started and never sent. The portal already draws exactly this
 * line: `portal/getMyKinTales.ts` filters `sentAt > ''` and its comment says
 * "excludes DRAFTs", so a kinfolk has never seen one of these.
 *
 * FOUR CONDITIONS, ALL REQUIRED, and every one of them is a thing this job
 * refuses to delete rather than a thing it looks for:
 *
 *  1. `status` is DRAFT (case-insensitively; the field is free text).
 *  2. `sentAt` is empty. Belt and braces with (1): a row that went out to a
 *     kinfolk is theirs, whatever its status string says. If the two ever
 *     disagree, the send wins and the row lives.
 *  3. It is older than the window, read from `updatedAt` FIRST and `createdAt`
 *     only as a fallback. A draft the operator edited last week is not
 *     abandoned however long ago it was started, and dating it by birth would
 *     delete work in progress.
 *  4. It is not an untriaged migration orphan. The May-17 backfill wrote rows
 *     with `sentVia` of `legacy_orphan` / `legacy_visit_logs`, no `kinfolkId`
 *     and no triage decision, and several of them carry a BLANK `createdAt`.
 *     Those are the most dangerous documents in this collection for a purge:
 *     they are awaiting a human decision, and a naive parse of a blank stamp
 *     reads as 1970 and deletes every one of them on the first run. They are
 *     skipped by name.
 *
 * Condition 3 also covers a subtler case on its own: a row with no readable
 * stamp at all is SKIPPED, not deleted. Nothing should be inferred about the
 * age of a document nobody dated (`lib/purgeTimestamps.ts`).
 *
 * MEDIA IS NOT CASCADED. A purged draft's `mediaFileIds` point at `media_files`
 * rows that stay. Deleting media is `deleteMediaFile`'s job, with its own audit
 * entry and its own Cloudinary consequence; a retention sweep quietly destroying
 * photographs as a side effect is not a retention sweep. The result is orphaned
 * media rows, which the existing tooling already handles.
 *
 * `kin_care_reports/{id}/comments` is likewise untouched: no client may write it
 * and this job does not delete subcollections.
 */

/** Firestore's hard cap on writes in one `WriteBatch`. */
const DELETE_BATCH_LIMIT = 500;

/** What `draftRetentionDays` reads as when the settings document has never carried it. */
export const DEFAULT_DRAFT_RETENTION_DAYS = 30;

/** `sentVia` markers the May-17 migration wrote onto rows that still need a human. */
const LEGACY_ORPHAN_MARKERS = new Set(['legacy_orphan', 'legacy_visit_logs']);

interface ReportDoc {
  status?: unknown;
  sentAt?: unknown;
  sentVia?: unknown;
  kinfolkId?: unknown;
  triageStatus?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
}

function str(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * A migration orphan nobody has triaged yet. Ports
 * `KinCareReport.isUntriagedOrphan()` (`FirestoreClient.kt`) field for field, so
 * the row the admin's triage queue is waiting on is the same row this job
 * refuses to touch.
 */
export function isUntriagedOrphan(data: ReportDoc): boolean {
  return (
    str(data.kinfolkId) === '' &&
    str(data.triageStatus) === '' &&
    LEGACY_ORPHAN_MARKERS.has(str(data.sentVia))
  );
}

/** Is this row an unsent draft the purge is allowed to consider at all? */
export function isPurgeableDraft(data: ReportDoc): boolean {
  if (str(data.status).toUpperCase() !== 'DRAFT') return false;
  if (str(data.sentAt) !== '') return false;
  if (isUntriagedOrphan(data)) return false;
  return true;
}

export interface DraftPurgeResult {
  deleted: number;
  scanned: number;
  days: number | null;
  skippedReason?: string;
}

/** Delete unsent drafts older than the operator's window. Exported for tests. */
export async function runDraftPurge(now: number = Date.now()): Promise<DraftPurgeResult> {
  const window = await readRetentionWindow(db(), 'draftRetentionDays', DEFAULT_DRAFT_RETENTION_DAYS, now);
  if (!window.ok) {
    logEvent({
      severity: 'warn',
      function: 'purgeOldDrafts',
      event: 'retention.purge.skipped',
      extra: { reason: window.reason },
    });
    await writeAuditEntry({
      status: 'FAILURE',
      event: AUDIT_EVENTS.RETENTION_PURGE_SKIPPED,
      severity: 'warn',
      actorRole: 'SYSTEM',
      targetCollection: 'kin_care_reports',
      description: `Draft purge did not run: ${window.reason}`,
      payload: { job: 'purgeOldDrafts', reason: window.reason },
    });
    return { deleted: 0, scanned: 0, days: null, skippedReason: window.reason };
  }

  let staged: DocumentReference[] = [];
  let deleted = 0;
  let scanned = 0;

  async function flush(): Promise<void> {
    if (staged.length === 0) return;
    // Cleared before the await, so a rejected commit cannot leave the same refs
    // staged for a second commit on a later flush.
    const chunk = staged;
    staged = [];
    const batch = db().batch();
    for (const ref of chunk) batch.delete(ref);
    await batch.commit();
    deleted += chunk.length;
  }

  await paginateQuery(
    db().collection('kin_care_reports'),
    async (docSnap) => {
      scanned += 1;
      const data = docSnap.data() as ReportDoc;
      if (!isPurgeableDraft(data)) return;
      const stampedMs = firstReadableStamp(data as Record<string, unknown>, ['updatedAt', 'createdAt']);
      if (stampedMs === null) return;
      if (stampedMs >= window.cutoffMs) return;
      staged.push(docSnap.ref);
      if (staged.length >= DELETE_BATCH_LIMIT) await flush();
    },
    { functionName: 'purgeOldDrafts' },
  );

  await flush();

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.RETENTION_DRAFTS_PURGED,
    severity: 'info',
    actorRole: 'SYSTEM',
    targetCollection: 'kin_care_reports',
    description: `Purged ${deleted} unsent draft(s) older than ${window.days} days`,
    payload: {
      job: 'purgeOldDrafts',
      deleted,
      scanned,
      retentionDays: window.days,
      retentionSource: window.source,
      cutoffIso: new Date(window.cutoffMs).toISOString(),
    },
  });

  return { deleted, scanned, days: window.days };
}

export const purgeOldDrafts = onSchedule(
  // Same shape and the same reasoning as `purgeOldVisitRoutes`, half an hour
  // later so the two never contend for the same instance cap.
  { schedule: 'every day 04:00', timeZone: 'America/New_York', secrets: ['SENTRY_DSN'], ...SERIAL },
  wrapScheduled('purgeOldDrafts', async () => {
    await runDraftPurge(Date.now());
  }),
);
