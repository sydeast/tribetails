import { describe, expect, it } from 'vitest';
import { mergeEnvelope, patchVisit } from './bookingsCache';
import type {
  GetMyBookingsResult,
  GetMyBookingsResultEnvelope,
  GetMyBookingsResultLiveVisit,
} from '../contracts/bookingContracts.generated';
/** #1281: the cache write a booking callable's reply goes through. */
function visit(id: string, startTimeMs: number, overrides: Partial<GetMyBookingsResultLiveVisit> = {}): GetMyBookingsResultLiveVisit {
  return {
    id, batchId: 'b-new', kinfolkId: 'fam1', status: 'requested', serviceType: 'Walk', serviceLabel: 'Walk', serviceId: null, title: 'Walk', startTimeMs,
    endTimeMs: null, startTimePending: false, requestedDate: null, timeBlockLabel: null, timeBlockStartTime: null,
    timeBlockEndTime: null, kinIds: [], kinNames: [], auntieDisplayName: null,
    auntieAvatarUrl: null, notes: null, requestedByUid: null, createdAtMs: null, updatedAtMs: null, visitProgress: null,
    sourceBookingId: null, sessionId: null, cancelRequested: false, cancelRequestStatus: null, cancelRequestReason: null,
    cancelResponseNote: null, rescheduleRequestStatus: null, rescheduleRequestedStartTimeMs: null,
    rescheduleRequestedEndTimeMs: null, rescheduleRequestReason: null, rescheduleResponseNote: null, address: null, kinTaleId: null, invoiceId: null, ...overrides,
  };
}
function envelope(batchId: string, kinCares: GetMyBookingsResultLiveVisit[]): GetMyBookingsResultEnvelope {
  return {
    batchId, envelopeStatus: 'requested', pattern: 'individual', serviceName: 'Walk', kinIds: [], kinNames: [], notes: null,
    visitCount: kinCares.length, confirmedCount: 0, completedCount: 0,
    firstStartTimeMs: kinCares[0]?.startTimeMs ?? null, lastStartTimeMs: kinCares.at(-1)?.startTimeMs ?? null, kinCares,
  };
}
const existing = visit('v-old', 2_000, { batchId: 'b-old', status: 'confirmed' });
const base: GetMyBookingsResult = {
  liveVisit: null,
  upcoming: [existing],
  recent: [],
  envelopes: [envelope('b-old', [existing])],
};
describe('mergeEnvelope', () => {
  it('adds the new visits to Upcoming in time order and keeps every booking already listed', () => {
    const next = mergeEnvelope(base, envelope('b-new', [visit('v1', 1_000), visit('v2', 3_000)]));
    expect(next.upcoming.map((v) => v.id)).toEqual(['v1', 'v-old', 'v2']);
    expect(next.envelopes.map((e) => e.batchId)).toEqual(['b-new', 'b-old']);
  });
  it('is idempotent: merging the same envelope twice lists it once', () => {
    const env = envelope('b-new', [visit('v1', 1_000)]);
    const next = mergeEnvelope(mergeEnvelope(base, env), env);
    expect(next.upcoming.filter((v) => v.id === 'v1')).toHaveLength(1);
    expect(next.envelopes.filter((e) => e.batchId === 'b-new')).toHaveLength(1);
  });
});
describe('patchVisit', () => {
  it('replaces the visit in Upcoming and inside its envelope', () => {
    const asked = { ...existing, rescheduleRequestStatus: 'pending' as const };
    const next = patchVisit(base, asked);
    expect(next.upcoming[0]!.rescheduleRequestStatus).toBe('pending');
    expect(next.envelopes[0]!.kinCares[0]!.rescheduleRequestStatus).toBe('pending');
  });
});
