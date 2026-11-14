import { describe, it, expect } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { BookingDtoSchema, kinCareToDto } from '../src/lib/portalBookingDto';

/**
 * #2029: a request the office declined read CANCELLED on the portal Schedule
 * and on its booking page. A decline and a cancellation share the `cancelled`
 * status on the visit; only the `requestDeclinedAt` stamp that
 * `manageBookingSeries` CANCEL writes on a decline (#533) tells them apart, and
 * no portal read carried it. `requestDeclinedAtMs` is that stamp, projected
 * only while the visit still reads cancelled.
 */
const DECLINED_AT = 1_763_000_000_000;

function visit(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    status: 'requested',
    startTime: Timestamp.fromMillis(1_763_500_000_000),
    endTime: Timestamp.fromMillis(1_763_503_600_000),
    kinIds: ['k1'],
    ...extra,
  };
}

describe('requestDeclinedAtMs (#2029)', () => {
  it('carries the decline stamp on a declined request', () => {
    const dto = kinCareToDto(
      'v1',
      visit({ status: 'cancelled', requestDeclinedAt: Timestamp.fromMillis(DECLINED_AT) }),
      'b1',
      'kf1',
    );
    expect(dto.status).toBe('cancelled');
    expect(dto.requestDeclinedAtMs).toBe(DECLINED_AT);
    expect(BookingDtoSchema.parse(dto).requestDeclinedAtMs).toBe(DECLINED_AT);
  });

  it('is null on a visit cancelled without a decline (the household or the office cancelled it)', () => {
    const dto = kinCareToDto('v1', visit({ status: 'cancelled' }), 'b1', 'kf1');
    expect(dto.requestDeclinedAtMs).toBeNull();
  });

  it('is null once a declined request has been approved again', () => {
    const dto = kinCareToDto(
      'v1',
      visit({ status: 'confirmed', requestDeclinedAt: Timestamp.fromMillis(DECLINED_AT) }),
      'b1',
      'kf1',
    );
    expect(dto.requestDeclinedAtMs).toBeNull();
  });

  it('is null on a request still waiting', () => {
    expect(kinCareToDto('v1', visit({}), 'b1', 'kf1').requestDeclinedAtMs).toBeNull();
  });

  it('is refused by the schema when it is missing, so no read can drop it', () => {
    const dto = kinCareToDto('v1', visit({}), 'b1', 'kf1') as unknown as Record<string, unknown>;
    const { requestDeclinedAtMs: _dropped, ...rest } = dto;
    expect(BookingDtoSchema.safeParse(rest).success).toBe(false);
  });
});
