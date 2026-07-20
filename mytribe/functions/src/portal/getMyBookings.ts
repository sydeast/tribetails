import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

interface GetMyBookingsRequest { kinfolkId?: string }

interface BookingDto {
  /** kinCare (per-visit) document id. */
  id: string;
  /** Envelope id this visit belongs to. */
  batchId: string | null;
  kinfolkId: string;
  status: 'requested' | 'confirmed' | 'enRoute' | 'active' | 'completed' | 'cancelled';
  serviceType: string | null;
  title: string | null;
  startTimeMs: number | null;
  endTimeMs: number | null;
  kinIds: string[];
  kinNames: string[];
  auntieDisplayName: string | null;
  auntieAvatarUrl: string | null;
  notes: string | null;
  requestedByUid: string | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  /** Active visit progress hint, only on status=active. */
  visitProgress: 'confirmed' | 'enRoute' | 'active' | 'ended' | null;
  /** AuntieOS back-references (null until AuntieOS writes them). */
  sourceBookingId: string | null;
  sessionId: string | null;
  /** Vendor-parity (2026-07-02): a cancellation ask is pending on this visit. */
  cancelRequested: boolean;
}

interface EnvelopeDto {
  batchId: string;
  envelopeStatus:
    | 'requested'
    | 'partiallyConfirmed'
    | 'confirmed'
    | 'inProgress'
    | 'completed'
    | 'cancelled';
  pattern: 'individual' | 'weekly';
  serviceName: string | null;
  kinIds: string[];
  kinNames: string[];
  notes: string | null;
  visitCount: number;
  confirmedCount: number;
  completedCount: number;
  firstStartTimeMs: number | null;
  lastStartTimeMs: number | null;
  kinCares: BookingDto[];
}

interface GetMyBookingsResult {
  liveVisit: BookingDto | null;
  upcoming: BookingDto[];
  recent: BookingDto[];
  envelopes: EnvelopeDto[];
}

/**
 * Returns all visits split into live + upcoming + recent buckets, plus the
 * envelope grouping. READ-ONLY.
 * Source: `collectionGroup('kinCares').where('familyId','==',kinfolkId)` for the
 * per-visit docs, and the parent `bookings/{batchId}` docs for envelope fields.
 */
export async function getMyBookingsHandler(
  req: CallableRequest<GetMyBookingsRequest>,
): Promise<GetMyBookingsResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const firestore = db();
  const { kinfolkId } = await resolveKinfolkAccess(uid, req.data?.kinfolkId, req.auth?.token?.admin === true, 'getMyBookings');

  const snap = await firestore
    .collectionGroup('kinCares')
    .where('familyId', '==', kinfolkId)
    .get();

  const nowMs = Date.now();
  // batchId -> kinCare dtos, preserving the parent envelope id per visit.
  const byBatch = new Map<string, BookingDto[]>();
  const all: BookingDto[] = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    const batchId = resolveBatchId(d, data);
    const dto: BookingDto = {
      id: d.id,
      batchId,
      kinfolkId,
      status: (data['status'] as BookingDto['status']) ?? 'requested',
      serviceType: stringOrNull(data['serviceType']) ?? stringOrNull(data['serviceName']),
      title: stringOrNull(data['title']),
      startTimeMs: tsMillis(data['startTime']),
      endTimeMs: tsMillis(data['endTime']),
      kinIds: Array.isArray(data['kinIds']) ? (data['kinIds'] as string[]) : [],
      kinNames: Array.isArray(data['kinNames']) ? (data['kinNames'] as string[]) : [],
      auntieDisplayName: stringOrNull(data['auntieDisplayName']),
      auntieAvatarUrl: stringOrNull(data['auntieAvatarUrl']),
      notes: stringOrNull(data['notes']),
      requestedByUid: stringOrNull(data['requestedByUid']),
      createdAtMs: tsMillis(data['createdAt']),
      updatedAtMs: tsMillis(data['updatedAt']),
      visitProgress: (data['visitProgress'] as BookingDto['visitProgress']) ?? null,
      sourceBookingId: stringOrNull(data['sourceBookingId']),
      sessionId: stringOrNull(data['sessionId']),
      cancelRequested: Boolean(data['cancelRequestedAt']),
    };
    if (batchId) {
      const bucket = byBatch.get(batchId) ?? [];
      bucket.push(dto);
      byBatch.set(batchId, bucket);
    }
    return dto;
  });

  // Bucket logic, IDENTICAL to the pre-envelope behaviour so the UI is
  // unchanged when the envelope flag is off.
  const live = all.find((b) => b.status === 'active' || b.status === 'enRoute') ?? null;
  const upcoming = all
    .filter((b) => (b.status === 'requested' || b.status === 'confirmed') && (b.startTimeMs ?? 0) >= nowMs - 60_000)
    .sort((a, b) => (a.startTimeMs ?? 0) - (b.startTimeMs ?? 0));
  const recent = all
    .filter((b) => b.status === 'completed' || b.status === 'cancelled')
    .sort((a, b) => (b.startTimeMs ?? 0) - (a.startTimeMs ?? 0))
    .slice(0, 10);

  // Read the parent envelopes for envelope-level fields.
  const batchIds = [...byBatch.keys()];
  const envelopes: EnvelopeDto[] = [];
  for (const batchId of batchIds) {
    const kinCares = (byBatch.get(batchId) ?? []).sort(
      (a, b) => (a.startTimeMs ?? 0) - (b.startTimeMs ?? 0),
    );
    const parentSnap = await firestore
      .doc(`families/${kinfolkId}/bookings/${batchId}`)
      .get();
    const env = (parentSnap.data() ?? {}) as Record<string, unknown>;
    envelopes.push({
      batchId,
      envelopeStatus: (env['envelopeStatus'] as EnvelopeDto['envelopeStatus']) ?? 'requested',
      pattern: (env['pattern'] as EnvelopeDto['pattern']) ?? 'individual',
      serviceName: stringOrNull(env['serviceName']),
      kinIds: Array.isArray(env['kinIds']) ? (env['kinIds'] as string[]) : [],
      kinNames: Array.isArray(env['kinNames']) ? (env['kinNames'] as string[]) : [],
      notes: stringOrNull(env['notes']),
      visitCount: numberOr(env['visitCount'], kinCares.length),
      confirmedCount: numberOr(env['confirmedCount'], 0),
      completedCount: numberOr(env['completedCount'], 0),
      firstStartTimeMs: tsMillis(env['firstStartTime']),
      lastStartTimeMs: tsMillis(env['lastStartTime']),
      kinCares,
    });
  }
  envelopes.sort((a, b) => (a.firstStartTimeMs ?? 0) - (b.firstStartTimeMs ?? 0));

  logEvent({ severity: 'info', function: 'getMyBookings', event: 'portal.bookings.resolved', uid, extra: { kinfolkId, total: all.length, envelopes: envelopes.length } });
  return { liveVisit: live, upcoming, recent, envelopes };
}

/** Prefers the doc's own `batchId` field; falls back to the parent doc id. */
function resolveBatchId(
  doc: { ref?: { parent?: { parent?: { id?: string } | null } } },
  data: Record<string, unknown>,
): string | null {
  const fromField = stringOrNull(data['batchId']);
  if (fromField) return fromField;
  const fromParent = doc.ref?.parent?.parent?.id;
  return typeof fromParent === 'string' && fromParent.length > 0 ? fromParent : null;
}

function stringOrNull(v: unknown): string | null { return typeof v === 'string' && v.length > 0 ? v : null; }
function numberOr(v: unknown, fallback: number): number { return typeof v === 'number' ? v : fallback; }
function tsMillis(v: unknown): number | null {
  if (v instanceof Timestamp) return v.toMillis();
  if (typeof v === 'number') return v;
  return null;
}

export const getMyBookings = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'], minInstances: 1 },
  wrapCallable('getMyBookings', getMyBookingsHandler),
);
