import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  initialWizardState,
  newSlot,
  toggleDay,
  clearDays,
  selectedDays,
  applyServiceToTemplate,
  addTemplateSlot,
  removeTemplateSlot,
  updateTemplateSlot,
  addDayVisit,
  removeDayVisit,
  updateDayVisit,
  buildVisits,
  bookingSubmission,
  callableConflictCode,
  isOverridableBusyRefusal,
  plannedDayCount,
  plannedDayIsos,
  plannedServiceNames,
  plannedVisitTimes,
  wizardTotal,
  BOOKING_BUSY_CONFLICT_CODE,
  COMPANY_HOLIDAY_CONFLICT_CODE,
  rateToCents,
  formatCents,
  stepBlocker,
  firstBlockedStep,
  canAdvance,
  stepIndex,
  WIZARD_STEPS,
  MAX_VISITS,
  type WizardState,
} from './bookingWizard';
import { type ServiceOption } from './newBooking';

// Pinned: every time in this file is a LOCAL wall clock, and an unpinned zone
// would make the epoch-ms assertions machine-dependent (the AO-18 convention
// every date suite in this tree follows).
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const PAST = Date.parse('2020-01-01T00:00:00Z');

function ready(over: Partial<WizardState> = {}): WizardState {
  const base = initialWizardState();
  return {
    ...base,
    kinfolkId: 'kf1',
    serviceName: 'Dog Walk',
    template: [newSlot({ time: '09:00', serviceName: 'Dog Walk' })],
    ...over,
  };
}

const OPTIONS: ServiceOption[] = [
  { name: 'Dog Walk', rate: '25', durationMinutes: null },
  { name: 'The Peek-In', rate: '15.00', durationMinutes: null },
  { name: 'Consultation', rate: '', durationMinutes: null },
];

describe('wizard steps', () => {
  it('is the five steps the PNGs name, in the PNGs order', () => {
    expect(WIZARD_STEPS.map((s) => s.label)).toEqual([
      'Select Kinfolk & Kin',
      'Choose Service',
      'Schedule Dates',
      'Invoice Options',
      'Review & Confirm',
    ]);
  });

  it('indexes every step key', () => {
    expect(WIZARD_STEPS.map((s) => stepIndex(s.key))).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('day selection snapshots the template', () => {
  it('copies the Daily Visit Schedule onto a newly picked day', () => {
    const state = toggleDay(ready(), '2026-08-03');
    expect(state.plans).toHaveLength(1);
    expect(state.plans[0]?.visits.map((v) => ({ time: v.time, serviceName: v.serviceName }))).toEqual([
      { time: '09:00', serviceName: 'Dog Walk' },
    ]);
  });

  it('gives the copy its OWN ids, so editing a day never edits the template', () => {
    const state = toggleDay(ready(), '2026-08-03');
    expect(state.plans[0]?.visits[0]?.id).not.toBe(state.template[0]?.id);
  });

  it('leaves an already-picked day alone when the template changes afterwards', () => {
    // The mock's own caption: "Changes will only be applied to new dates you
    // select." A template edit that rewrote a tuned day would lose the tuning
    // with no undo.
    let state = toggleDay(ready(), '2026-08-03');
    const slotId = state.template[0]!.id;
    state = updateTemplateSlot(state, slotId, { time: '17:00' });
    expect(state.plans[0]?.visits[0]?.time).toBe('09:00');
    state = toggleDay(state, '2026-08-05');
    const later = state.plans.find((p) => p.dayIso === '2026-08-05');
    expect(later?.visits[0]?.time).toBe('17:00');
  });

  it('keeps the picked days in ascending order however they were clicked', () => {
    let state = toggleDay(ready(), '2026-08-10');
    state = toggleDay(state, '2026-08-03');
    state = toggleDay(state, '2026-08-07');
    expect(state.plans.map((p) => p.dayIso)).toEqual(['2026-08-03', '2026-08-07', '2026-08-10']);
  });

  it('unpicking a day drops it and its per-visit edits', () => {
    let state = toggleDay(ready(), '2026-08-03');
    state = toggleDay(state, '2026-08-03');
    expect(state.plans).toEqual([]);
    expect(selectedDays(state).size).toBe(0);
  });

  it('Clear all empties the selection', () => {
    let state = toggleDay(ready(), '2026-08-03');
    state = toggleDay(state, '2026-08-04');
    expect(clearDays(state).plans).toEqual([]);
  });
});

describe('service pick', () => {
  it('retargets template rows that still carry the previous default', () => {
    const state = applyServiceToTemplate(ready(), OPTIONS[1]!);
    expect(state.serviceName).toBe('The Peek-In');
    expect(state.template[0]?.serviceName).toBe('The Peek-In');
  });

  it('leaves a row the operator gave its OWN service alone', () => {
    let state = ready();
    state = updateTemplateSlot(state, state.template[0]!.id, { serviceName: 'House Sit' });
    state = applyServiceToTemplate(state, OPTIONS[1]!);
    expect(state.template[0]?.serviceName).toBe('House Sit');
  });
});

describe('multiple visits per day', () => {
  it('adds a second template row seeded from the first', () => {
    let state = ready();
    state = updateTemplateSlot(state, state.template[0]!.id, { location: 'Back gate' });
    state = addTemplateSlot(state);
    expect(state.template).toHaveLength(2);
    expect(state.template[1]?.location).toBe('Back gate');
    expect(state.template[1]?.serviceName).toBe('Dog Walk');
  });

  it('refuses to remove the last template row: a day with no visits is not a booking', () => {
    const state = ready();
    expect(removeTemplateSlot(state, state.template[0]!.id).template).toHaveLength(1);
  });

  it('removes a template row once there is more than one', () => {
    let state = addTemplateSlot(ready());
    state = removeTemplateSlot(state, state.template[0]!.id);
    expect(state.template).toHaveLength(1);
  });

  it('adds and removes a visit on ONE day without touching the others', () => {
    let state = toggleDay(ready(), '2026-08-03');
    state = toggleDay(state, '2026-08-04');
    state = addDayVisit(state, '2026-08-03');
    expect(state.plans[0]?.visits).toHaveLength(2);
    expect(state.plans[1]?.visits).toHaveLength(1);
    state = removeDayVisit(state, '2026-08-03', state.plans[0]!.visits[1]!.id);
    expect(state.plans[0]?.visits).toHaveLength(1);
  });

  it('refuses to remove a day\'s last visit', () => {
    const state = toggleDay(ready(), '2026-08-03');
    const only = state.plans[0]!.visits[0]!.id;
    expect(removeDayVisit(state, '2026-08-03', only).plans[0]?.visits).toHaveLength(1);
  });
});

describe('buildVisits', () => {
  it('sends one visit per planned slot, ascending by instant', () => {
    let state = toggleDay(ready(), '2026-08-05');
    state = toggleDay(state, '2026-08-03');
    const visits = buildVisits(state);
    expect(visits).toHaveLength(2);
    expect(visits[0]!.startTimeMs).toBeLessThan(visits[1]!.startTimeMs);
    expect(visits[0]!.startTimeMs).toBe(new Date(2026, 7, 3, 9, 0, 0, 0).getTime());
  });

  it('carries a DIFFERENT time and service per visit, which the single-page form could not', () => {
    let state = toggleDay(ready(), '2026-08-03');
    state = addDayVisit(state, '2026-08-03');
    const [first, second] = state.plans[0]!.visits;
    state = updateDayVisit(state, '2026-08-03', second!.id, {
      time: '16:30',
      serviceName: 'The Peek-In',
    });
    const visits = buildVisits(state);
    expect(visits.map((v) => v.serviceName)).toEqual(['Dog Walk', 'The Peek-In']);
    expect(visits[0]!.startTimeMs).toBe(new Date(2026, 7, 3, 9, 0).getTime());
    expect(visits[1]!.startTimeMs).toBe(new Date(2026, 7, 3, 16, 30).getTime());
    expect(first!.time).toBe('09:00');
  });

  it('sends a per-visit location, and null (never blank) when there is none', () => {
    let state = toggleDay(ready(), '2026-08-03');
    state = addDayVisit(state, '2026-08-03');
    state = updateDayVisit(state, '2026-08-03', state.plans[0]!.visits[0]!.id, {
      location: '  Back gate  ',
    });
    state = updateDayVisit(state, '2026-08-03', state.plans[0]!.visits[1]!.id, { location: '   ' });
    const visits = buildVisits(state);
    expect(visits[0]!.location).toBe('Back gate');
    expect(visits[1]!.location).toBeNull();
  });

  it('sends serviceId null (present, not omitted) for a typed-in service', () => {
    // ADR-0003 follow-up: the generated CreateMultiDateBookingRequestArgsVisit
    // always carries the key (readModel.ts refuses a field that is both
    // .nullable() and .optional()), so `null` is how "this did not come from
    // the catalog" travels now. The server's real parser (HandlerArgs, kept
    // unexported and unchanged) accepts an omitted key and an explicit null
    // identically, so this is a wire-shape change, not a behavior change.
    const state = toggleDay(ready(), '2026-08-03');
    expect(buildVisits(state)[0]).toHaveProperty('serviceId', null);
  });

  it('expands a weekly recurrence with the template applied to every date', () => {
    const state = ready({
      mode: 'weekly',
      startDateIso: '2026-08-03', // a Monday
      weeklyDays: [1, 3],
      weeks: 2,
    });
    const visits = buildVisits(state);
    expect(visits).toHaveLength(4);
    expect(new Set(visits.map((v) => v.serviceName))).toEqual(new Set(['Dog Walk']));
  });

  it('expands EVERY template row across the recurrence, so two visits a day repeat as two', () => {
    let state = ready({ mode: 'weekly', startDateIso: '2026-08-03', weeklyDays: [1], weeks: 2 });
    state = addTemplateSlot(state);
    state = updateTemplateSlot(state, state.template[1]!.id, { time: '17:00' });
    const visits = buildVisits(state);
    expect(visits).toHaveLength(4);
    // Interleaved by instant, not grouped by template row.
    expect(visits.map((v) => new Date(v.startTimeMs).getHours())).toEqual([9, 17, 9, 17]);
  });

  it('is empty before anything is picked, in either mode', () => {
    expect(buildVisits(ready())).toEqual([]);
    expect(buildVisits(ready({ mode: 'weekly' }))).toEqual([]);
  });
});

describe('day counts for the review copy', () => {
  it('counts distinct days, not visits', () => {
    let state = toggleDay(ready(), '2026-08-03');
    state = addDayVisit(state, '2026-08-03');
    state = toggleDay(state, '2026-08-04');
    expect(buildVisits(state)).toHaveLength(3);
    expect(plannedDayCount(state)).toBe(2);
  });

  it('counts the distinct days a recurrence lands on', () => {
    const state = ready({ mode: 'weekly', startDateIso: '2026-08-03', weeklyDays: [1, 3], weeks: 2 });
    expect(plannedDayCount(state)).toBe(4);
  });

  it('lists the picked days ascending for the availability warnings', () => {
    let state = toggleDay(ready(), '2026-08-10');
    state = toggleDay(state, '2026-08-03');
    expect(plannedDayIsos(state)).toEqual(['2026-08-03', '2026-08-10']);
  });

  // DEFECT 2. This used to be `[startDateIso]`, which is why nothing downstream
  // -- not the warnings, not the closure gate -- could see occurrences 2..n.
  it('EXPANDS a weekly recurrence to every day it lands on, not just the start', () => {
    const state = ready({ mode: 'weekly', startDateIso: '2026-08-03', weeklyDays: [1], weeks: 4 });
    expect(plannedDayIsos(state)).toEqual([
      '2026-08-03',
      '2026-08-10',
      '2026-08-17',
      '2026-08-24',
    ]);
    expect(plannedDayCount(state)).toBe(4);
  });
});

describe('the concrete visit times the warnings work over', () => {
  // DEFECT 3. The dialog used to cross every selected DAY with every time used
  // anywhere in the plan, so it named visits the request will never contain.
  it('pairs each day with ITS OWN times, never every time in the plan', () => {
    let state = toggleDay(ready(), '2026-08-03');
    state = toggleDay(state, '2026-08-04');
    state = updateDayVisit(state, '2026-08-04', state.plans[1]!.visits[0]!.id, { time: '19:00' });
    expect(plannedVisitTimes(state)).toEqual([
      { dayIso: '2026-08-03', time: '09:00' },
      { dayIso: '2026-08-04', time: '19:00' },
    ]);
  });

  it('says a repeated day-and-time once, however many visits share it', () => {
    let state = toggleDay(ready(), '2026-08-03');
    state = addDayVisit(state, '2026-08-03');
    expect(buildVisits(state)).toHaveLength(2);
    expect(plannedVisitTimes(state)).toEqual([{ dayIso: '2026-08-03', time: '09:00' }]);
  });

  it('covers every occurrence of a recurrence, at every template time', () => {
    let state = ready({ mode: 'weekly', startDateIso: '2026-08-03', weeklyDays: [1], weeks: 2 });
    state = addTemplateSlot(state);
    state = updateTemplateSlot(state, state.template[1]!.id, { time: '17:00' });
    expect(plannedVisitTimes(state)).toEqual([
      { dayIso: '2026-08-03', time: '09:00' },
      { dayIso: '2026-08-03', time: '17:00' },
      { dayIso: '2026-08-10', time: '09:00' },
      { dayIso: '2026-08-10', time: '17:00' },
    ]);
  });
});

describe('the services Review reports', () => {
  // DEFECT 4. Review rendered `state.serviceName`, the step-2 DEFAULT, while
  // days already snapshotted keep the service they were added with.
  it('reads the BUILT visits, so a back-edit cannot make Review disagree with the payload', () => {
    let state = toggleDay(ready({ serviceName: 'Dog Walk' }), '2026-08-03');
    // Back to step 2 and pick something else: the template changes, the day does
    // not, and the payload still carries the day's own service.
    state = applyServiceToTemplate(state, {
      name: 'The Peek-In',
      rate: '15.00',
      durationMinutes: null,
    });
    expect(state.serviceName).toBe('The Peek-In');
    expect(buildVisits(state).map((v) => v.serviceName)).toEqual(['Dog Walk']);
    expect(plannedServiceNames(state)).toEqual(['Dog Walk']);
  });

  it('names every distinct service once, in visit order', () => {
    let state = toggleDay(ready(), '2026-08-03');
    state = addDayVisit(state, '2026-08-03');
    state = updateDayVisit(state, '2026-08-03', state.plans[0]!.visits[1]!.id, {
      serviceName: 'Consultation',
      time: '17:00',
    });
    state = toggleDay(state, '2026-08-04');
    expect(plannedServiceNames(state)).toEqual(['Dog Walk', 'Consultation']);
  });

  it('is empty when nothing is planned yet', () => {
    expect(plannedServiceNames(ready())).toEqual([]);
  });
});

describe('the submission, and the one refusal an operator may override', () => {
  // DEFECT 1. `overrideBusyConflict` had ZERO occurrences under src/ outside the
  // generated contract: the server honored a flag no web caller ever sent.
  it('sends the override ONLY on an explicit Create anyway', () => {
    const state = toggleDay(ready(), '2026-08-03');
    expect(bookingSubmission(state)).not.toHaveProperty('overrideBusyConflict');
    expect(bookingSubmission(state, true).overrideBusyConflict).toBe(true);
  });

  it('carries the whole payload, so a new callable field cannot be silently dropped', () => {
    let state = toggleDay(ready({ kinIds: ['k1'], notes: '  gate code 1234  ' }), '2026-08-03');
    state = { ...state, communication: { emailConfirmation: true, timeVisibility: false } };
    expect(bookingSubmission(state, true)).toEqual({
      kinfolkId: 'kf1',
      kinIds: ['k1'],
      notes: 'gate code 1234',
      pattern: 'individual',
      visits: buildVisits(state),
      billing: { mode: 'new-invoice' },
      communication: { emailConfirmation: true, timeVisibility: false },
      overrideBusyConflict: true,
    });
  });

  it('reads the server code off details, not off the message text', () => {
    expect(callableConflictCode({ details: { code: BOOKING_BUSY_CONFLICT_CODE } })).toBe(
      BOOKING_BUSY_CONFLICT_CODE,
    );
    expect(callableConflictCode(new Error('booking_busy_conflict'))).toBe('');
    expect(callableConflictCode(null)).toBe('');
    expect(callableConflictCode({ details: 'nope' })).toBe('');
  });

  it('offers the override for a busy clash, never for a company closure', () => {
    const busy = { details: { code: BOOKING_BUSY_CONFLICT_CODE } };
    const closed = { details: { code: COMPANY_HOLIDAY_CONFLICT_CODE } };
    expect(isOverridableBusyRefusal(busy, false)).toBe(true);
    // A closure guard has no override server-side by design, so offering one
    // would be offering a submit that cannot succeed.
    expect(isOverridableBusyRefusal(closed, false)).toBe(false);
    // And never twice: an override that already failed is a losing move.
    expect(isOverridableBusyRefusal(busy, true)).toBe(false);
  });
});

describe('totals', () => {
  it('parses a rate however the operator typed it', () => {
    expect(rateToCents('25')).toBe(2500);
    expect(rateToCents('15.00')).toBe(1500);
    expect(rateToCents('$25')).toBe(2500);
    expect(rateToCents('1,250')).toBe(125000);
    expect(rateToCents('')).toBeNull();
    expect(rateToCents('  ')).toBeNull();
    expect(rateToCents('free')).toBeNull();
    expect(rateToCents('-5')).toBeNull();
  });

  it('sums the priced visits', () => {
    let state = ready({ serviceName: 'The Peek-In' });
    state = updateTemplateSlot(state, state.template[0]!.id, { serviceName: 'The Peek-In' });
    state = toggleDay(state, '2026-08-03');
    state = toggleDay(state, '2026-08-04');
    // The review PNG's own arithmetic: two Peek-Ins at $15 read as $30.00.
    expect(wizardTotal(state, OPTIONS)).toEqual({ cents: 3000, unpriced: [] });
    expect(formatCents(3000)).toBe('$30.00');
  });

  it('NAMES an unpriced service rather than adding it as zero', () => {
    let state = toggleDay(ready(), '2026-08-03');
    state = addDayVisit(state, '2026-08-03');
    state = updateDayVisit(state, '2026-08-03', state.plans[0]!.visits[1]!.id, {
      serviceName: 'Consultation',
    });
    const total = wizardTotal(state, OPTIONS);
    expect(total.cents).toBe(2500);
    expect(total.unpriced).toEqual(['Consultation']);
  });

  it('names a service that is not on the rate card at all', () => {
    let state = toggleDay(ready(), '2026-08-03');
    state = updateDayVisit(state, '2026-08-03', state.plans[0]!.visits[0]!.id, {
      serviceName: 'Something Bespoke',
    });
    expect(wizardTotal(state, OPTIONS).unpriced).toEqual(['Something Bespoke']);
  });

  it('names each unpriced service once, however many visits use it', () => {
    let state = ready({ serviceName: 'Consultation' });
    state = updateTemplateSlot(state, state.template[0]!.id, { serviceName: 'Consultation' });
    state = toggleDay(state, '2026-08-03');
    state = toggleDay(state, '2026-08-04');
    expect(wizardTotal(state, OPTIONS).unpriced).toEqual(['Consultation']);
  });
});

describe('step gating', () => {
  const NOW = new Date(2026, 7, 1, 12, 0).getTime();

  it('blocks step 1 until a household is picked, and says so', () => {
    expect(stepBlocker(initialWizardState(), 'client', NOW)).toBe('Pick a household first.');
    expect(canAdvance(ready(), 'client', NOW)).toBe(true);
  });

  it('blocks step 2 until a service is picked', () => {
    expect(stepBlocker(ready({ serviceName: '' }), 'service', NOW)).toBe('Pick a service first.');
  });

  it('blocks step 3 with no dates, and names the mode\'s own missing piece', () => {
    expect(stepBlocker(ready(), 'dates', NOW)).toBe('Pick at least one date.');
    expect(stepBlocker(ready({ mode: 'weekly' }), 'dates', NOW)).toBe(
      'Pick a start date and at least one weekday.',
    );
  });

  it('blocks a visit whose service was cleared', () => {
    let state = toggleDay(ready(), '2026-08-03');
    state = updateDayVisit(state, '2026-08-03', state.plans[0]!.visits[0]!.id, { serviceName: '' });
    expect(stepBlocker(state, 'dates', NOW)).toBe('Every visit needs a service.');
  });

  it('refuses a past visit with the SAME one-minute grace the callable applies', () => {
    const state = toggleDay(ready(), '2026-08-03');
    expect(stepBlocker(state, 'dates', PAST)).toBeNull();
    const wayLater = new Date(2027, 0, 1).getTime();
    expect(stepBlocker(state, 'dates', wayLater)).toBe('Every visit has to be in the future.');
  });

  it('catches a recurrence longer than the callable will accept, before the round trip', () => {
    const state = ready({
      mode: 'weekly',
      startDateIso: '2026-08-03',
      weeklyDays: [0, 1, 2, 3, 4, 5, 6],
      weeks: 12,
    });
    const blocker = stepBlocker(state, 'dates', NOW);
    expect(blocker).toMatch(new RegExp(`most a single request can carry is ${MAX_VISITS}`));
    expect(blocker).toMatch(/That is 84 visits/);
  });

  it('never blocks the Invoice or Review steps: both have a valid default', () => {
    const state = toggleDay(ready(), '2026-08-03');
    expect(stepBlocker(state, 'invoice', NOW)).toBeNull();
    expect(stepBlocker(state, 'review', NOW)).toBeNull();
  });

  it('reports the FIRST blocked step, so Review cannot be reached over a hole three steps back', () => {
    // Clearing the household after picking dates is the real path: Back, edit,
    // then Next Next Next would otherwise sail straight past it.
    let state = toggleDay(ready(), '2026-08-03');
    state = { ...state, kinfolkId: '' };
    expect(firstBlockedStep(state, NOW)).toBe('client');
  });

  it('reports no blocked step once every requirement is met', () => {
    const state = toggleDay(ready(), '2026-08-03');
    expect(firstBlockedStep(state, NOW)).toBeNull();
  });

  // DEFECT 2. `plannedDayIsos` used to answer `[startDateIso]` in weekly mode, so
  // a closure on any occurrence after the first was invisible until the server
  // refused the whole batch at submit.
  it('refuses a company closure on ANY generated day, not just the start date', () => {
    const state = ready({
      mode: 'weekly',
      startDateIso: '2026-08-03',
      weeklyDays: [1],
      weeks: 4,
    });
    // Week 3 of the recurrence: 2026-08-03, -10, -17, -24.
    const closed = (iso: string) => (iso === '2026-08-17' ? 'Founders Day' : null);
    expect(stepBlocker(state, 'dates', NOW, closed)).toBe(
      'Aug 17 is closed for Founders Day. The business will refuse that date, so pick another.',
    );
    expect(firstBlockedStep(state, NOW, closed)).toBe('dates');
    // And nothing is refused when no day is closed.
    expect(stepBlocker(state, 'dates', NOW)).toBeNull();
  });

  it('refuses a closed day picked individually too, with the same sentence', () => {
    const state = toggleDay(ready(), '2026-08-03');
    expect(stepBlocker(state, 'dates', NOW, () => 'Founders Day')).toBe(
      'Aug 3 is closed for Founders Day. The business will refuse that date, so pick another.',
    );
  });
});
