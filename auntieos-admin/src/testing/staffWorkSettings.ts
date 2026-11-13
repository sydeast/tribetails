/**
 * #2164 test fixtures: who is signed in, and what `getStaffWorkSettings`
 * answers an Auntie. The reply carries KinCare names and lengths and never a
 * rate, and tag names with no color or icon, exactly as the server builds it
 * (mytribe/functions/src/admin/staffWorkSettings.ts).
 */
export const OWNER_SEAT = { uid: 'owner-1', caretaker: false } as const;
export const AUNTIE_SEAT = { uid: 'auntie-1', caretaker: true } as const;

export const STAFF_WORK_REPLY = {
  services: [
    { id: 'Long walk', durationMinutes: '45' },
    { id: 'Drop-in', durationMinutes: '20' },
  ],
  timeZone: 'America/Denver',
  timeBlocks: [
    { id: 'morning', label: 'Morning', startTime: '08:00', endTime: '11:00', active: true },
    { id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', active: true },
  ],
  allowTimeBlockBooking: true,
  allowSpecificTimeBooking: true,
  defaultBookingMode: 'SPECIFIC_TIME',
  requireArrivalDepartureVerification: true,
  kinTaleRequired: false,
  // #2186: the tag suggestions, by name only. No color, no icon.
  householdTagNames: ['VIP', 'Gate code'],
  kinTagNames: ['Reactive', 'On meds'],
};

/** A `call` stand-in that answers only the staff read, as the app's real stub refuses everything else. */
export async function staffOnlyCall(name: string): Promise<unknown> {
  if (name === 'getStaffWorkSettings') return STAFF_WORK_REPLY;
  throw new Error(`${name} is not stubbed in this test`);
}
