import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

// RESERVED / ARCHIVED 2026-05-19, legacy KinTale ingest path.
//
// Writes to `families/{familyId}/kinTales` (the pre-flat-collection layout
// superseded by canonical `kin_care_reports` per HANDOFF 2026-05-18). Kept
// deployed in reserved state per operator direction so the legacy bridge can
// be temporarily reanimated for backfill if a downstream consumer still
// needs the families-subcollection shape.
//
// Zero active client callers as of 2026-05-19 per repo-wide grep.
// New writes should target `kin_care_reports` via the canonical KinTale path.

const RoutePoint = z.object({
  lat: z.number(),
  lng: z.number(),
  t: z.number().optional(), // epoch millis, optional, UI degrades gracefully without
});

const GpsSummary = z.object({
  distanceMeters: z.number().nonnegative().optional(),
  durationSeconds: z.number().nonnegative().optional(),
});

const Args = z.object({
  familyId: z.string().min(1),
  body: z.string(),
  authorDisplayName: z.string(),
  mediaIds: z.array(z.string()).optional(),
  /**
   * Optional GPS visit route. AuntieOS web/Android reads
   * `kin_care_sessions/{sid}/breadcrumbs` on DEPARTED and forwards them here
   * so the kinfolk's MyTribe app can render the route alongside the journal.
   * Capped at 5_000 points to keep the doc under Firestore's 1MB limit.
   */
  gpsRoute: z.array(RoutePoint).max(5000).optional(),
  gpsSummary: GpsSummary.optional(),
});

export async function ingestKinTaleHandler(req: CallableRequest<unknown>): Promise<{ kinTaleId: string }> {
  const args = Args.parse(req.data);
  const docData: Record<string, unknown> = {
    body: args.body,
    authorId: req.auth!.uid,
    authorDisplayName: args.authorDisplayName,
    mediaIds: args.mediaIds ?? [],
    sharedAsIds: [],
    sentAt: FieldValue.serverTimestamp(),
  };
  if (args.gpsRoute && args.gpsRoute.length > 0) {
    docData['gpsRoute'] = args.gpsRoute;
  }
  if (args.gpsSummary && (args.gpsSummary.distanceMeters !== undefined || args.gpsSummary.durationSeconds !== undefined)) {
    docData['gpsSummary'] = args.gpsSummary;
  }
  const ref = await db().collection(`families/${args.familyId}/kinTales`).add(docData);
  await writeAuditEntry({
    event: AUDIT_EVENTS.CONTENT_KINTALE_INGESTED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: req.auth!.uid,
    familyId: args.familyId,
    payload: { kinTaleId: ref.id },
  });
  return { kinTaleId: ref.id };
}

export const ingestKinTale = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('ingestKinTale', ingestKinTaleHandler),
);
