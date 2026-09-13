import { describe, it, expect } from 'vitest';
import {
  evaluateVisitLifecycle,
  lifecyclePatchFor,
  undoArrivalTarget,
  notificationEventFor,
  auditActionTypeFor,
  illegalLifecycleMessage,
  unreachableLifecycleMessage,
} from './visitLifecyclePatch';

/**
 * THE FIELD-SET ASSERTIONS ARE THE POINT OF THIS FILE, and they are written the
 * way Android's `UndoArrivalPatchTest.kt` writes them: exact keys, exact values,
 * and an explicit assertion on what is NOT in the patch. "Mirrors Android" is a
 * claim that is only worth anything if a diff that breaks it fails here.
 *
 * The reference on the other side is `KinCareRepository` :253-271 (the three
 * forward patches) and `KinCareSessionsScreen#undoArrivalPatch` (the #608 undo
 * shape, the one that clears `departedAt` too).
 */

const NOW = '2026-09-12T14:02:00Z';

describe('evaluateVisitLifecycle: the same machine the server runs, on the snapshot', () => {
  it('ON_MY_WAY applies from SCHEDULED only', () => {
    expect(evaluateVisitLifecycle({ status: 'SCHEDULED', action: 'ON_MY_WAY' })).toEqual({
      kind: 'apply',
      from: 'SCHEDULED',
      to: 'ON_MY_WAY',
    });
    expect(evaluateVisitLifecycle({ status: 'ARRIVED', action: 'ON_MY_WAY' })).toEqual({
      kind: 'illegal',
      from: 'ARRIVED',
      allowedFrom: ['SCHEDULED'],
    });
  });

  it('ARRIVED applies from SCHEDULED as well as ON_MY_WAY: no fake on-my-way', () => {
    expect(evaluateVisitLifecycle({ status: 'SCHEDULED', action: 'ARRIVED' })).toEqual({
      kind: 'apply',
      from: 'SCHEDULED',
      to: 'ARRIVED',
    });
    expect(evaluateVisitLifecycle({ status: 'ON_MY_WAY', action: 'ARRIVED' })).toEqual({
      kind: 'apply',
      from: 'ON_MY_WAY',
      to: 'ARRIVED',
    });
  });

  it('DEPARTED refuses a clock-out before a clock-in', () => {
    expect(evaluateVisitLifecycle({ status: 'SCHEDULED', action: 'DEPARTED' })).toEqual({
      kind: 'illegal',
      from: 'SCHEDULED',
      allowedFrom: ['ARRIVED'],
    });
  });

  // The guard that actually matters on a double tap: write NOTHING rather than
  // re-stamp the arrival and quietly move when the visit started.
  it('a second tap on an action already true is a no-op, not a refusal', () => {
    expect(evaluateVisitLifecycle({ status: 'ARRIVED', action: 'ARRIVED' })).toEqual({
      kind: 'noop',
      at: 'ARRIVED',
    });
    expect(evaluateVisitLifecycle({ status: 'DEPARTED', action: 'DEPARTED' })).toEqual({
      kind: 'noop',
      at: 'DEPARTED',
    });
    expect(evaluateVisitLifecycle({ status: 'SCHEDULED', action: 'UNDO_ARRIVAL' })).toEqual({
      kind: 'noop',
      at: 'SCHEDULED',
    });
  });

  it('UNDO_ARRIVAL rewinds to where the visit actually was', () => {
    expect(
      evaluateVisitLifecycle({ status: 'ARRIVED', action: 'UNDO_ARRIVAL', onMyWayAt: NOW }),
    ).toEqual({ kind: 'apply', from: 'ARRIVED', to: 'ON_MY_WAY' });
    expect(evaluateVisitLifecycle({ status: 'DEPARTED', action: 'UNDO_ARRIVAL' })).toEqual({
      kind: 'apply',
      from: 'DEPARTED',
      to: 'SCHEDULED',
    });
    expect(undoArrivalTarget('   ')).toBe('SCHEDULED');
    expect(undoArrivalTarget(undefined)).toBe('SCHEDULED');
  });

  // COMPLETED / CANCELLED are not a wrong step in this machine, they are
  // outside it: `transitionBookingStatus` owns them and the rules refuse them.
  it('a terminal or unreadable status is unreachable, not illegal', () => {
    expect(evaluateVisitLifecycle({ status: 'COMPLETED', action: 'UNDO_ARRIVAL' })).toEqual({
      kind: 'unreachable',
      raw: 'COMPLETED',
    });
    expect(evaluateVisitLifecycle({ status: 'CANCELLED', action: 'ARRIVED' })).toEqual({
      kind: 'unreachable',
      raw: 'CANCELLED',
    });
    expect(evaluateVisitLifecycle({ status: undefined, action: 'ARRIVED' })).toEqual({
      kind: 'unreachable',
      raw: '',
    });
  });
});

describe('lifecyclePatchFor writes Android field set, field for field', () => {
  it('ON_MY_WAY: status, onMyWayAt, updatedAt, and no ETA unless one was declared', () => {
    expect(lifecyclePatchFor({ action: 'ON_MY_WAY', to: 'ON_MY_WAY', nowIso: NOW })).toEqual({
      status: 'ON_MY_WAY',
      onMyWayAt: NOW,
      updatedAt: NOW,
    });
  });

  it('ON_MY_WAY carries etaMinutesAway when the operator declared one', () => {
    expect(
      lifecyclePatchFor({ action: 'ON_MY_WAY', to: 'ON_MY_WAY', nowIso: NOW, etaMinutes: 20 }),
    ).toEqual({ status: 'ON_MY_WAY', onMyWayAt: NOW, updatedAt: NOW, etaMinutesAway: 20 });
  });

  // `KinCareRepository#markSessionArrived` sends visitRouteId = "" and lets
  // tracking fill it in later. A 0-minute ETA on the other hand would put
  // "arriving in 0 minutes" in the household's push, so it is never written.
  it('ARRIVED: status, arrivedAt, visitRouteId, updatedAt', () => {
    expect(lifecyclePatchFor({ action: 'ARRIVED', to: 'ARRIVED', nowIso: NOW })).toEqual({
      status: 'ARRIVED',
      arrivedAt: NOW,
      visitRouteId: '',
      updatedAt: NOW,
    });
  });

  it('DEPARTED: status, departedAt, updatedAt, and nothing else', () => {
    expect(lifecyclePatchFor({ action: 'DEPARTED', to: 'DEPARTED', nowIso: NOW })).toEqual({
      status: 'DEPARTED',
      departedAt: NOW,
      updatedAt: NOW,
    });
  });

  it('UNDO_ARRIVAL clears arrivedAt, departedAt and all three arrival-evidence fields', () => {
    const patch = lifecyclePatchFor({ action: 'UNDO_ARRIVAL', to: 'ON_MY_WAY', nowIso: NOW });
    expect(patch).toEqual({
      status: 'ON_MY_WAY',
      arrivedAt: '',
      departedAt: '',
      arrivalDistanceMeters: '',
      arrivalAccuracyMeters: '',
      arrivalLocationCheckedAt: '',
      updatedAt: NOW,
    });
  });

  // The undo's NOT-cleared list, asserted rather than assumed. `onMyWayAt` is
  // the leg being rewound TO; `completedAt` is terminal and fenced by the rules;
  // `etaMinutesAway` is left alone to match Android.
  it('UNDO_ARRIVAL leaves onMyWayAt, completedAt and etaMinutesAway alone', () => {
    const patch = lifecyclePatchFor({ action: 'UNDO_ARRIVAL', to: 'SCHEDULED', nowIso: NOW });
    expect(Object.keys(patch)).not.toContain('onMyWayAt');
    expect(Object.keys(patch)).not.toContain('completedAt');
    expect(Object.keys(patch)).not.toContain('etaMinutesAway');
  });

  // The rules fence this, but a patch that even tried would be a bug worth
  // catching here rather than at a permission-denied banner.
  it('no action ever writes a terminal status or completedAt', () => {
    for (const action of ['ON_MY_WAY', 'ARRIVED', 'DEPARTED', 'UNDO_ARRIVAL'] as const) {
      const patch = lifecyclePatchFor({ action, to: 'ARRIVED', nowIso: NOW });
      expect(Object.keys(patch)).not.toContain('completedAt');
      expect(['COMPLETED', 'CANCELLED']).not.toContain(patch.status);
    }
  });
});

describe('what each action declares afterwards', () => {
  it('the three forward actions notify; an undo notifies nobody', () => {
    expect(notificationEventFor('ON_MY_WAY')).toBe('on_my_way');
    expect(notificationEventFor('ARRIVED')).toBe('arrived');
    expect(notificationEventFor('DEPARTED')).toBe('departed');
    expect(notificationEventFor('UNDO_ARRIVAL')).toBeNull();
  });

  // Android's own strings, so one activity feed reads the same whichever app
  // the Auntie had in her hand.
  it('audit actionTypes match Android and satisfy logActivity SCREAMING_SNAKE rule', () => {
    expect(auditActionTypeFor('ON_MY_WAY')).toBe('VISIT_ON_MY_WAY');
    expect(auditActionTypeFor('ARRIVED')).toBe('VISIT_ARRIVED');
    expect(auditActionTypeFor('DEPARTED')).toBe('VISIT_DEPARTED');
    expect(auditActionTypeFor('UNDO_ARRIVAL')).toBe('VISIT_UNDO_ARRIVAL');
    for (const action of ['ON_MY_WAY', 'ARRIVED', 'DEPARTED', 'UNDO_ARRIVAL'] as const) {
      expect(auditActionTypeFor(action)).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});

describe('the sentences the operator reads', () => {
  it('an illegal action names both ends', () => {
    expect(illegalLifecycleMessage('DEPARTED', 'SCHEDULED', ['ARRIVED'])).toBe(
      'Cannot clock out of this visit while it is SCHEDULED. Allowed from: ARRIVED.',
    );
  });

  it('an unreachable status is named, and a blank one is described', () => {
    expect(unreachableLifecycleMessage('ARRIVED', 'COMPLETED')).toBe(
      'Cannot clock in to this visit: this visit is COMPLETED.',
    );
    expect(unreachableLifecycleMessage('ARRIVED', '')).toBe(
      'Cannot clock in to this visit: this visit has no status on file.',
    );
  });
});
