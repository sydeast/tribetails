import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/firestoreAdmin', () => ({ db: vi.fn(), auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { assignmentDispatches } from '../src/triggers/onBookingsWrite';

/**
 * Vendor-parity (2026-07-02): staff assignment notifications. The trigger is a
 * thin shell; this pure table is the behavior under test.
 */
describe('assignmentDispatches', () => {
  it('first assignment fires assignment.assigned to the new auntie', () => {
    const out = assignmentDispatches(
      { status: 'confirmed' },
      { status: 'confirmed', assignedAuntieUid: 'a1' },
      [],
    );
    expect(out).toEqual([{ key: 'assignment.assigned', auntieUid: 'a1', extra: {} }]);
  });

  it('reassignment notifies both aunties (assigned to new, changed to old)', () => {
    const out = assignmentDispatches(
      { status: 'confirmed', assignedAuntieUid: 'a1' },
      { status: 'confirmed', assignedAuntieUid: 'a2' },
      [],
    );
    expect(out).toEqual([
      { key: 'assignment.assigned', auntieUid: 'a2', extra: {} },
      { key: 'assignment.changed', auntieUid: 'a1', extra: { changeKind: 'reassigned' } },
    ]);
  });

  it('unassignment notifies only the previous auntie', () => {
    const out = assignmentDispatches(
      { status: 'confirmed', assignedAuntieUid: 'a1' },
      { status: 'confirmed' },
      [],
    );
    expect(out).toEqual([
      { key: 'assignment.changed', auntieUid: 'a1', extra: { changeKind: 'unassigned' } },
    ]);
  });

  it('cancellation of an assigned visit notifies the current auntie', () => {
    const out = assignmentDispatches(
      { status: 'confirmed', assignedAuntieUid: 'a1' },
      { status: 'cancelled', assignedAuntieUid: 'a1' },
      [],
    );
    expect(out).toEqual([
      { key: 'assignment.changed', auntieUid: 'a1', extra: { changeKind: 'cancelled' } },
    ]);
  });

  it('detail edit on an assigned confirmed visit notifies the current auntie', () => {
    const out = assignmentDispatches(
      { status: 'confirmed', assignedAuntieUid: 'a1', startTime: null },
      { status: 'confirmed', assignedAuntieUid: 'a1' },
      ['startTime'],
    );
    expect(out).toEqual([
      {
        key: 'assignment.changed',
        auntieUid: 'a1',
        extra: { changeKind: 'updated', changedFields: ['startTime'] },
      },
    ]);
  });

  it('no assignment, no dispatches (cancel/edit on unassigned visits stays quiet)', () => {
    expect(assignmentDispatches({ status: 'confirmed' }, { status: 'cancelled' }, [])).toEqual([]);
    expect(assignmentDispatches({ status: 'confirmed' }, { status: 'confirmed' }, ['notes'])).toEqual([]);
  });

  it('a write that both reassigns and edits fields does not double-notify the new auntie', () => {
    const out = assignmentDispatches(
      { status: 'confirmed', assignedAuntieUid: 'a1' },
      { status: 'confirmed', assignedAuntieUid: 'a2' },
      ['startTime'],
    );
    expect(out.map((d) => d.key)).toEqual(['assignment.assigned', 'assignment.changed']);
    expect(out.find((d) => d.auntieUid === 'a2')!.key).toBe('assignment.assigned');
  });
});
