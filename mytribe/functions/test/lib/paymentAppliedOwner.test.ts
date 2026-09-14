import { describe, it, expect } from 'vitest';
import {
  PAYMENT_APPLIED_OWNER_FIELD,
  paymentAppliedNoticeOwnedByWriter,
} from '../../src/lib/paymentAppliedOwner';

/**
 * #866: the one rule the invoice trigger reads to decide whether a write that
 * paid an invoice already has a sender. A stamp changed IN THIS WRITE means the
 * writer owns the notice. A stamp carried over from an earlier write means
 * nothing about this one.
 */
describe('paymentAppliedNoticeOwnedByWriter', () => {
  it('names the field every owner stamps', () => {
    expect(PAYMENT_APPLIED_OWNER_FIELD).toBe('paymentAppliedNoticeOwner');
  });

  it('is true when this write set a new owner', () => {
    expect(paymentAppliedNoticeOwnedByWriter(undefined, { paymentAppliedNoticeOwner: 'stripe:evt_1' })).toBe(true);
    expect(paymentAppliedNoticeOwnedByWriter({}, { paymentAppliedNoticeOwner: 'stripe:evt_1' })).toBe(true);
    expect(
      paymentAppliedNoticeOwnedByWriter(
        { paymentAppliedNoticeOwner: 'stripe:evt_1' },
        { paymentAppliedNoticeOwner: 'recordPayment:p2' },
      ),
    ).toBe(true);
  });

  it('is false when the owner is unchanged from before the write', () => {
    expect(
      paymentAppliedNoticeOwnedByWriter(
        { paymentAppliedNoticeOwner: 'stripe:evt_1' },
        { paymentAppliedNoticeOwner: 'stripe:evt_1' },
      ),
    ).toBe(false);
  });

  it('is false when no owner is stamped at all, or the stamp is not a real string', () => {
    expect(paymentAppliedNoticeOwnedByWriter({}, {})).toBe(false);
    expect(paymentAppliedNoticeOwnedByWriter(undefined, undefined)).toBe(false);
    expect(paymentAppliedNoticeOwnedByWriter({}, { paymentAppliedNoticeOwner: '' })).toBe(false);
    expect(paymentAppliedNoticeOwnedByWriter({}, { paymentAppliedNoticeOwner: 42 })).toBe(false);
  });
});
