import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/firestoreAdmin', () => ({ db: vi.fn(), auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { cancellationDispatches } from '../src/triggers/onBookingsWrite';

/**
 * The cancellation ask (vendor-parity 2026-07-02) and the answer to it (#438).
 * The trigger is a thin shell; this pure table is the behavior under test.
 */
describe('cancellationDispatches', () => {
  it('a fresh ask tells the office', () => {
    const out = cancellationDispatches(
      { status: 'confirmed' },
      { status: 'confirmed', cancelRequestedAt: 1, cancelRequestStatus: 'pending', cancelRequestReason: 'Away' },
    );
    expect(out).toEqual([{ key: 'kincare.cancel.requested', extra: { reason: 'Away' } }]);
  });

  it('an ask written before the status field existed still tells the office', () => {
    const out = cancellationDispatches(
      { status: 'confirmed' },
      { status: 'confirmed', cancelRequestedAt: 1 },
    );
    expect(out.map((d) => d.key)).toEqual(['kincare.cancel.requested']);
  });

  it('asking again after a decline is a new ask, not silence', () => {
    // The stamp was already there, so a first-appearance test would miss this
    // entirely and the second ask would reach nobody.
    const out = cancellationDispatches(
      { status: 'confirmed', cancelRequestedAt: 1, cancelRequestStatus: 'declined' },
      { status: 'confirmed', cancelRequestedAt: 2, cancelRequestStatus: 'pending' },
    );
    expect(out.map((d) => d.key)).toEqual(['kincare.cancel.requested']);
  });

  it('a decline tells the household, with the operator’s reason', () => {
    const out = cancellationDispatches(
      { status: 'confirmed', cancelRequestedAt: 1, cancelRequestStatus: 'pending', cancelRequestReason: 'Away' },
      {
        status: 'confirmed',
        cancelRequestedAt: 1,
        cancelRequestStatus: 'declined',
        cancelRequestReason: 'Away',
        cancelResponseNote: 'Inside the 48-hour window.',
      },
    );
    expect(out).toEqual([
      {
        key: 'kincare.cancel.declined',
        extra: { note: 'Inside the 48-hour window.', reason: 'Away' },
      },
    ]);
  });

  it('an accept sends nothing of its own', () => {
    // The visit goes to cancelled, and kincare.booking.cancel already reaches
    // the household. A second key here would tell them the same news twice.
    const out = cancellationDispatches(
      { status: 'confirmed', cancelRequestedAt: 1, cancelRequestStatus: 'pending' },
      { status: 'cancelled', cancelRequestedAt: 1, cancelRequestStatus: 'accepted' },
    );
    expect(out).toEqual([]);
  });

  it('an unrelated edit on a visit with a pending ask sends nothing', () => {
    const out = cancellationDispatches(
      { status: 'confirmed', cancelRequestedAt: 1, cancelRequestStatus: 'pending' },
      { status: 'confirmed', cancelRequestedAt: 1, cancelRequestStatus: 'pending', notes: 'Gate code 4321' },
    );
    expect(out).toEqual([]);
  });

  it('a visit that never carried an ask sends nothing', () => {
    expect(cancellationDispatches(undefined, { status: 'requested' })).toEqual([]);
  });
});
