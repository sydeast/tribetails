import { describe, it, expect } from 'vitest';
import {
  VISIT_LIFECYCLE_ACTIONS,
  allowedFromForLifecycle,
  evaluateVisitLifecycle,
  illegalLifecycleMessage,
  notificationEventFor,
  undoArrivalTarget,
} from '../src/lib/visitLifecycle';

/**
 * The in-visit state machine, tested as a pure module so the legality question
 * has one answer and the handler cannot give it a second, slightly different
 * one. Mirrors `bookingTransitions.test.ts`'s shape.
 *
 * EVERY ALLOWED-FROM ROW HERE IS ANDROID'S. If one of these assertions has to
 * change, the change is a divergence from `HomeScreen.kt#TodayVisitCardView`'s
 * `LifecycleButton` enablement and should be argued as one, not absorbed.
 */

describe('the allowed-from sets are the Android ones', () => {
  it('On my way only from SCHEDULED', () => {
    expect(allowedFromForLifecycle('ON_MY_WAY')).toEqual(['SCHEDULED']);
  });

  // Android enables "Arrived" at SCHEDULED as well as ON_MY_WAY: an Auntie
  // already at the door has no on-my-way to declare and is not made to fake one.
  it('Arrived from SCHEDULED as well as ON_MY_WAY, so on-my-way stays skippable', () => {
    expect(allowedFromForLifecycle('ARRIVED')).toEqual(['SCHEDULED', 'ON_MY_WAY']);
  });

  it('Departed only from ARRIVED, which is the clock-out-before-clock-in refusal', () => {
    expect(allowedFromForLifecycle('DEPARTED')).toEqual(['ARRIVED']);
  });

  it('Undo arrival from ARRIVED or DEPARTED', () => {
    expect(allowedFromForLifecycle('UNDO_ARRIVAL')).toEqual(['ARRIVED', 'DEPARTED']);
  });
});

describe('the happy paths', () => {
  it('SCHEDULED -> ON_MY_WAY', () => {
    expect(evaluateVisitLifecycle({ currentStatus: 'SCHEDULED', action: 'ON_MY_WAY' })).toEqual({
      kind: 'apply',
      from: 'SCHEDULED',
      to: 'ON_MY_WAY',
    });
  });

  it('ON_MY_WAY -> ARRIVED (clock in)', () => {
    expect(evaluateVisitLifecycle({ currentStatus: 'ON_MY_WAY', action: 'ARRIVED' })).toEqual({
      kind: 'apply',
      from: 'ON_MY_WAY',
      to: 'ARRIVED',
    });
  });

  it('SCHEDULED -> ARRIVED, skipping on-my-way', () => {
    expect(evaluateVisitLifecycle({ currentStatus: 'SCHEDULED', action: 'ARRIVED' })).toEqual({
      kind: 'apply',
      from: 'SCHEDULED',
      to: 'ARRIVED',
    });
  });

  it('ARRIVED -> DEPARTED (clock out)', () => {
    expect(evaluateVisitLifecycle({ currentStatus: 'ARRIVED', action: 'DEPARTED' })).toEqual({
      kind: 'apply',
      from: 'ARRIVED',
      to: 'DEPARTED',
    });
  });

  it('reads a stored status case-insensitively and through the CANCELED/REJECTED aliases', () => {
    expect(evaluateVisitLifecycle({ currentStatus: 'scheduled', action: 'ARRIVED' })).toMatchObject({
      kind: 'apply',
    });
    // The aliases fold to CANCELLED, which is terminal, so the clock refuses.
    expect(evaluateVisitLifecycle({ currentStatus: 'CANCELED', action: 'ARRIVED' })).toMatchObject({
      kind: 'illegal',
      from: 'CANCELLED',
    });
  });
});

describe('clocking out of a visit nobody clocked into', () => {
  it('refuses from SCHEDULED, naming where a clock-out is legal from', () => {
    const d = evaluateVisitLifecycle({ currentStatus: 'SCHEDULED', action: 'DEPARTED' });
    expect(d).toEqual({
      kind: 'illegal',
      from: 'SCHEDULED',
      action: 'DEPARTED',
      allowedFrom: ['ARRIVED'],
    });
  });

  it('refuses from ON_MY_WAY too: being on the way is not being there', () => {
    expect(evaluateVisitLifecycle({ currentStatus: 'ON_MY_WAY', action: 'DEPARTED' })).toMatchObject({
      kind: 'illegal',
      from: 'ON_MY_WAY',
    });
  });
});

describe('a double clock-in is a no-op, which is what protects the stamped time', () => {
  it('ARRIVED + Arrived writes nothing', () => {
    expect(evaluateVisitLifecycle({ currentStatus: 'ARRIVED', action: 'ARRIVED' })).toEqual({
      kind: 'noop',
      at: 'ARRIVED',
    });
  });

  it('so does a double clock-out and a double on-my-way', () => {
    expect(evaluateVisitLifecycle({ currentStatus: 'DEPARTED', action: 'DEPARTED' })).toEqual({
      kind: 'noop',
      at: 'DEPARTED',
    });
    expect(evaluateVisitLifecycle({ currentStatus: 'ON_MY_WAY', action: 'ON_MY_WAY' })).toEqual({
      kind: 'noop',
      at: 'ON_MY_WAY',
    });
  });

  it('undoing an arrival that is not there is granted, not refused', () => {
    expect(
      evaluateVisitLifecycle({ currentStatus: 'SCHEDULED', action: 'UNDO_ARRIVAL' }),
    ).toEqual({ kind: 'noop', at: 'SCHEDULED' });
    expect(
      evaluateVisitLifecycle({ currentStatus: 'ON_MY_WAY', action: 'UNDO_ARRIVAL' }),
    ).toEqual({ kind: 'noop', at: 'ON_MY_WAY' });
  });
});

describe('a terminal visit has a closed clock', () => {
  for (const status of ['COMPLETED', 'CANCELLED'] as const) {
    for (const action of VISIT_LIFECYCLE_ACTIONS) {
      it(`${action} is illegal from ${status}`, () => {
        expect(evaluateVisitLifecycle({ currentStatus: status, action })).toMatchObject({
          kind: 'illegal',
          from: status,
        });
      });
    }
  }

  // A visit that has been clocked out cannot be clocked back in by pressing
  // Arrived: the operator undoes first. Android offers exactly that pair of
  // controls on a DEPARTED card and no re-arrival.
  it('Arrived is illegal from DEPARTED: undo first', () => {
    expect(evaluateVisitLifecycle({ currentStatus: 'DEPARTED', action: 'ARRIVED' })).toMatchObject({
      kind: 'illegal',
      from: 'DEPARTED',
    });
  });
});

describe('an unreadable status is refused, never guessed', () => {
  // `raw` is the stored value VERBATIM, whitespace included, because it is what
  // the refusal message and the audit entry quote back: an operator debugging a
  // row whose status is three spaces needs to see three spaces.
  it.each([
    ['', ''],
    ['   ', '   '],
    ['IN_PROGRESS', 'IN_PROGRESS'],
  ])('status %j is unknown-status', (stored, raw) => {
    expect(evaluateVisitLifecycle({ currentStatus: stored, action: 'ARRIVED' })).toEqual({
      kind: 'unknown-status',
      raw,
    });
  });

  it('a missing status field is unknown-status, not SCHEDULED', () => {
    expect(evaluateVisitLifecycle({ currentStatus: undefined, action: 'ARRIVED' })).toEqual({
      kind: 'unknown-status',
      raw: '',
    });
  });
});

describe('undo puts the visit back where it actually was', () => {
  it('to ON_MY_WAY when an on-my-way was declared', () => {
    expect(undoArrivalTarget('2026-08-24T09:00:00Z')).toBe('ON_MY_WAY');
    expect(
      evaluateVisitLifecycle({
        currentStatus: 'ARRIVED',
        action: 'UNDO_ARRIVAL',
        onMyWayAt: '2026-08-24T09:00:00Z',
      }),
    ).toEqual({ kind: 'apply', from: 'ARRIVED', to: 'ON_MY_WAY' });
  });

  it('to SCHEDULED when none was, blank and absent alike', () => {
    expect(undoArrivalTarget('')).toBe('SCHEDULED');
    expect(undoArrivalTarget('   ')).toBe('SCHEDULED');
    expect(undoArrivalTarget(undefined)).toBe('SCHEDULED');
    expect(undoArrivalTarget(42)).toBe('SCHEDULED');
    expect(
      evaluateVisitLifecycle({ currentStatus: 'DEPARTED', action: 'UNDO_ARRIVAL' }),
    ).toEqual({ kind: 'apply', from: 'DEPARTED', to: 'SCHEDULED' });
  });
});

describe('what the operator is told, and who gets notified', () => {
  it('an illegal message names both ends', () => {
    expect(illegalLifecycleMessage('DEPARTED', 'SCHEDULED', ['ARRIVED'])).toBe(
      'Cannot clock out of this visit while it is SCHEDULED. Allowed from: ARRIVED.',
    );
  });

  // Ports VisitNotifier.Event: three forward events, and deliberately none for
  // an undo -- a "never mind" push is worse than silence.
  it('the three forward actions each declare a household event, undo declares none', () => {
    expect(notificationEventFor('ON_MY_WAY')).toBe('on_my_way');
    expect(notificationEventFor('ARRIVED')).toBe('arrived');
    expect(notificationEventFor('DEPARTED')).toBe('departed');
    expect(notificationEventFor('UNDO_ARRIVAL')).toBeNull();
  });
});
