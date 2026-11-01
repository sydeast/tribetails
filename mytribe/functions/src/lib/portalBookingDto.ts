/**
 * #1281: the portal's booking read model, shared by the callable that LISTS
 * bookings (`getMyBookings`) and the callables that WRITE them
 * (`requestBooking`, `requestBookingReschedule`, `requestBookingCancellation`).
 *
 * The writers hand back the record they just wrote, in exactly the shape the
 * list returns, so a client can put it straight into its cache instead of
 * showing the household its pre-save list until a refetch lands (the 5 to 20
 * seconds #1281 is about). One mapper, so a written record and a listed one
 * can never decode into two different shapes. Moved here verbatim from
 * `portal/getMyBookings.ts`; the schemas are the same objects that file's
 * `Result` is built from, which is also what keeps the generated contract
 * names unchanged.
 */
import { Timestamp } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { resolveBookingPolicy } from './bookingTimeBlocks';
export const BookingDtoSchema = z
  .object({
    /** kinCare (per-visit) document id. */
    id: z.string().min(1),
    /** Envelope id this visit belongs to. */
    batchId: z.string().min(1).nullable(),
    kinfolkId: z.string().min(1),
    status: z.enum(['requested', 'confirmed', 'enRoute', 'active', 'completed', 'cancelled']),
    serviceType: z.string().nullable(),
    /**
     * #1284: the catalog service this visit was booked as, so the reschedule
     * picker can tell a start-time KinCare (an overnight, booked by the clock
     * whatever the block switches say) from one that rides a time block. Null
     * on a visit that carries none (a session with no booking, an older doc).
     */
    serviceId: z.string().nullable(),
    title: z.string().nullable(),
    startTimeMs: z.number().int().nullable(),
    endTimeMs: z.number().int().nullable(),
    /**
     * #1098: true while Tribe Tails has not set this visit's start time. An
     * Overnight is requested as a night and the operator sets its start when
     * approving, so until then `startTimeMs` / `endTimeMs` are null and
     * `requestedDate` names the night. False on every other visit, and on any
     * visit written before #1098.
     */
    startTimePending: z.boolean(),
    /** #1098: the night asked for (business-local `YYYY-MM-DD`) while `startTimePending`; null otherwise. */
    requestedDate: z.string().nullable(),
    /**
     * #1301: the named window the household booked this visit into ("Midday"),
     * or null for a by-the-clock visit. A block visit has a start time that is
     * only the window's anchor, so clients show the window, never the clock.
     */
    timeBlockLabel: z.string().nullable(),
    /** #1301: that window's `HH:MM` bounds in the business's zone, null when the block has since been removed. */
    timeBlockStartTime: z.string().nullable(),
    timeBlockEndTime: z.string().nullable(),
    kinIds: z.array(z.string()),
    kinNames: z.array(z.string()),
    auntieDisplayName: z.string().nullable(),
    auntieAvatarUrl: z.string().nullable(),
    notes: z.string().nullable(),
    requestedByUid: z.string().nullable(),
    createdAtMs: z.number().int().nullable(),
    updatedAtMs: z.number().int().nullable(),
    /** Active visit progress hint, only on status=active. */
    visitProgress: z.enum(['confirmed', 'enRoute', 'active', 'ended']).nullable(),
    /** AuntieOS back-references (null until AuntieOS writes them). */
    sourceBookingId: z.string().nullable(),
    sessionId: z.string().nullable(),
    /**
     * Vendor-parity (2026-07-02): a cancellation ask is PENDING on this visit.
     *
     * Pending, not "was ever asked for". Every client uses this flag to hide
     * the ask button and show the waiting banner, which is what pending means;
     * reading it as "ever asked" would leave a household that was declined
     * staring at a waiting banner it can never leave. A declined ask flips this
     * back to false so they can ask again, with `cancelRequestStatus` carrying
     * what happened.
     */
    cancelRequested: z.boolean(),
    /**
     * The cancellation ask (#438), or null when this visit has never had one.
     * `pending` while the office has not ruled; `accepted` once the visit has
     * been cancelled; `declined` when the office is keeping it on the schedule.
     *
     * A request written before #438 landed carries no status field at all --
     * those are the July backlog the issue is about -- so an old
     * `cancelRequestedAt` with nothing else reads as `pending` here.
     */
    cancelRequestStatus: z.enum(['pending', 'accepted', 'declined']).nullable(),
    /** Why the household asked. */
    cancelRequestReason: z.string().nullable(),
    /** What the office said when it accepted or declined. */
    cancelResponseNote: z.string().nullable(),
    /**
     * The kinfolk reschedule ask (#399 item 2), or null when this visit has
     * never had one. `pending` while the office has not ruled; `accepted` once
     * the visit has been moved to the proposed time; `declined` when it has
     * not. The proposed window and the operator's note survive the decision on
     * purpose, so the screen can say what was asked for and what came back
     * rather than just "declined".
     */
    rescheduleRequestStatus: z.enum(['pending', 'accepted', 'declined']).nullable(),
    rescheduleRequestedStartTimeMs: z.number().int().nullable(),
    rescheduleRequestedEndTimeMs: z.number().int().nullable(),
    rescheduleRequestReason: z.string().nullable(),
    /** What the office said when it accepted or declined. */
    rescheduleResponseNote: z.string().nullable(),
  })
  .strict();

export type BookingDto = z.infer<typeof BookingDtoSchema>;

export const EnvelopeDtoSchema = z
  .object({
    batchId: z.string().min(1),
    envelopeStatus: z.enum([
      'requested',
      'partiallyConfirmed',
      'confirmed',
      'inProgress',
      'completed',
      'cancelled',
    ]),
    pattern: z.enum(['individual', 'weekly']),
    serviceName: z.string().nullable(),
    kinIds: z.array(z.string()),
    kinNames: z.array(z.string()),
    notes: z.string().nullable(),
    visitCount: z.number().int().nonnegative(),
    confirmedCount: z.number().int().nonnegative(),
    completedCount: z.number().int().nonnegative(),
    firstStartTimeMs: z.number().int().nullable(),
    lastStartTimeMs: z.number().int().nullable(),
    kinCares: z.array(BookingDtoSchema),
  })
  .strict();

export type EnvelopeDto = z.infer<typeof EnvelopeDtoSchema>;
export type BlockBounds = { startTime: string; endTime: string };
/**
 * #1301: the business's current windows by id, so a block visit can be shown as
 * its window. Read through the same resolver `getBookingPolicy` and
 * `requestBooking` use. A failed read degrades to an empty map: the visit still
 * carries its stored label, it just has no hours to print.
 */
export async function loadBlocksById(firestore: Firestore): Promise<Map<string, BlockBounds>> {
  try {
    const snap = await firestore.collection('business_settings').doc('business_settings').get();
    const { policy } = resolveBookingPolicy(snap.data() ?? {});
    return new Map(policy.timeBlocks.map((b) => [b.id, { startTime: b.startTime, endTime: b.endTime }]));
  } catch {
    return new Map();
  }
}
function blockFieldsOf(data: Record<string, unknown>, blocksById: Map<string, BlockBounds>) {
  const label = stringOrNull(data['timeBlockLabel']);
  const id = stringOrNull(data['timeBlockId']);
  const bounds = id === null ? undefined : blocksById.get(id);
  return {
    timeBlockLabel: label,
    timeBlockStartTime: label === null ? null : (bounds?.startTime ?? null),
    timeBlockEndTime: label === null ? null : (bounds?.endTime ?? null),
  };
}
/**
 * One `kinCares/{id}` document as the portal reads it. `blocksById` (#1301)
 * supplies a block visit's window hours; without it the stored label still
 * shows, with no hours.
 */
export function kinCareToDto(
  id: string,
  data: Record<string, unknown>,
  batchId: string | null,
  kinfolkId: string,
  blocksById: Map<string, BlockBounds> = new Map(),
): BookingDto {
  const cancelStatus = cancelRequestStatusOf(data);
  return {
    id,
    batchId,
    kinfolkId,
    status: (data['status'] as BookingDto['status']) ?? 'requested',
    serviceType: stringOrNull(data['serviceType']) ?? stringOrNull(data['serviceName']),
    serviceId: stringOrNull(data['serviceId']),
    title: stringOrNull(data['title']),
    startTimeMs: tsMillis(data['startTime']),
    endTimeMs: tsMillis(data['endTime']),
    startTimePending: data['startTimePending'] === true,
    requestedDate: data['startTimePending'] === true ? stringOrNull(data['requestedDate']) : null,
    ...blockFieldsOf(data, blocksById),
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
    cancelRequested: cancelStatus === 'pending',
    cancelRequestStatus: cancelStatus,
    cancelRequestReason: stringOrNull(data['cancelRequestReason']),
    cancelResponseNote: stringOrNull(data['cancelResponseNote']),
    rescheduleRequestStatus: rescheduleStatusOf(data['rescheduleRequestStatus']),
    rescheduleRequestedStartTimeMs: tsMillis(data['rescheduleRequestedStartTime']),
    rescheduleRequestedEndTimeMs: tsMillis(data['rescheduleRequestedEndTime']),
    rescheduleRequestReason: stringOrNull(data['rescheduleRequestReason']),
    rescheduleResponseNote: stringOrNull(data['rescheduleResponseNote']),
  };
}
/** One `bookings/{batchId}` envelope with its visits, as the portal reads it. */
export function envelopeToDto(
  batchId: string,
  env: Record<string, unknown>,
  visits: BookingDto[],
): EnvelopeDto {
  const kinCares = [...visits].sort((a, b) => visitSortMs(a) - visitSortMs(b));
  return {
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
  };
}
/**
 * Reads one envelope and its visits back after a write, for the writer's reply.
 *
 * Never throws: the write has already committed, and a household must not be
 * told a booking failed because the read-back did. Null tells the client to
 * fall back to refetching the list, which is what it did before #1281.
 */
export async function readEnvelopeDto(
  firestore: Firestore,
  kinfolkId: string,
  batchId: string,
): Promise<EnvelopeDto | null> {
  try {
    const parentRef = firestore.doc(`families/${kinfolkId}/bookings/${batchId}`);
    const [parentSnap, visitsSnap, blocksById] = await Promise.all([
      parentRef.get(),
      parentRef.collection('kinCares').get(),
      loadBlocksById(firestore),
    ]);
    if (!parentSnap.exists) return null;
    const env = (parentSnap.data() ?? {}) as Record<string, unknown>;
    const visits = visitsSnap.docs.map((d) =>
      kinCareToDto(d.id, d.data() as Record<string, unknown>, stringOrNull((d.data() as Record<string, unknown>)['batchId']) ?? batchId, kinfolkId, blocksById),
    );
    return EnvelopeDtoSchema.parse(envelopeToDto(batchId, env, visits));
  } catch {
    return null;
  }
}
/** One visit read back after a write; null on any failure, same reasoning as {@link readEnvelopeDto}. */
export async function readVisitDto(
  firestore: Firestore,
  kinfolkId: string,
  batchId: string,
  visitId: string,
): Promise<BookingDto | null> {
  try {
    const [snap, blocksById] = await Promise.all([
      firestore.doc(`families/${kinfolkId}/bookings/${batchId}/kinCares/${visitId}`).get(),
      loadBlocksById(firestore),
    ]);
    if (!snap.exists) return null;
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    return BookingDtoSchema.parse(kinCareToDto(visitId, data, stringOrNull(data['batchId']) ?? batchId, kinfolkId, blocksById));
  } catch {
    return null;
  }
}
/**
 * #1098: where a visit sits in time for ordering. Its start when it has one; a
 * night awaiting its start time sorts at the END of its requested date in UTC,
 * after that day's timed visits (an overnight starts in the evening). This
 * callable reads no business zone, so the placement is approximate across a
 * day boundary; it only decides order, never which bucket a visit is in beyond
 * `isUpcoming` below. A visit with neither sorts as 0, as it always has.
 */
export function visitSortMs(b: BookingDto): number {
  if (b.startTimeMs != null) return b.startTimeMs;
  if (b.requestedDate) {
    const ms = Date.parse(`${b.requestedDate}T23:59:59.999Z`);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

/**
 * The stored reschedule state, or null for anything this contract does not
 * publish. An unrecognised string is null rather than passed through: the DTO
 * is `.strict()` and three clients switch on these three values.
 */
export function rescheduleStatusOf(v: unknown): 'pending' | 'accepted' | 'declined' | null {
  return v === 'pending' || v === 'accepted' || v === 'declined' ? v : null;
}
/**
 * The cancellation ask's state, healing the requests written before #438.
 *
 * `requestBookingCancellation` only ever stamped `cancelRequestedAt`; the
 * status field arrives with #438. A doc carrying the stamp and no status is a
 * request nobody has ruled on, so it reads as `pending` -- which is the whole
 * point of the issue, since those are the asks that have been sitting in
 * Firestore since July.
 */
export function cancelRequestStatusOf(data: Record<string, unknown>): 'pending' | 'accepted' | 'declined' | null {
  const explicit = data['cancelRequestStatus'];
  if (explicit === 'pending' || explicit === 'accepted' || explicit === 'declined') return explicit;
  return data['cancelRequestedAt'] ? 'pending' : null;
}
/** Prefers the doc's own `batchId` field; falls back to the parent doc id. */
export function resolveBatchId(
  doc: { ref?: { parent?: { parent?: { id?: string } | null } } },
  data: Record<string, unknown>,
): string | null {
  const fromField = stringOrNull(data['batchId']);
  if (fromField) return fromField;
  const fromParent = doc.ref?.parent?.parent?.id;
  return typeof fromParent === 'string' && fromParent.length > 0 ? fromParent : null;
}

export function stringOrNull(v: unknown): string | null { return typeof v === 'string' && v.length > 0 ? v : null; }
export function numberOr(v: unknown, fallback: number): number { return typeof v === 'number' ? v : fallback; }
export function tsMillis(v: unknown): number | null {
  if (v instanceof Timestamp) return v.toMillis();
  if (typeof v === 'number') return v;
  return null;
}
