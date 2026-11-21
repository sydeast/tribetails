/**
 * #2487: one small Tribe, as the writers store it, for the placeholder sweep.
 *
 * The household every notice is about ("The Rivera Home") has two Kin, two
 * invoices and two visits, and a second household sits beside it. Every name
 * and number is a distinct sentinel, so a sweep can assert the RIGHT value
 * filled a token (Rex, not the roster; INV-1001, not its neighbour) and that
 * nothing from the other household, or from the household's other records,
 * reached a message about this one.
 *
 * Every notice in the sweep is about Rex's visit `vis1` in request `bat1`, his
 * invoice `inv1` and his KinTale `tale1`. Biscuit, `inv2`, `vis2` and the whole
 * of `fam2` are decoys.
 */

/** 2026-12-03 15:00 UTC, a Thursday (9:00 AM in the business's zone). */
export const VISIT_MS = Date.UTC(2026, 11, 3, 15, 0, 0);
/** The decoy visit, a week later. */
export const DECOY_VISIT_MS = Date.UTC(2026, 11, 10, 15, 0, 0);

const ts = (ms: number) => ({ toMillis: () => ms, toDate: () => new Date(ms) });

export const WORLD = {
  businessName: 'Sample Care Co',
  householdName: 'The Rivera Home',
  primaryName: 'Maya Rivera',
  primaryEmail: 'catch@hanasamku.com',
  kinName: 'Rex',
  invoiceNumber: 'INV-1001',
  serviceName: 'Drop-in visit',
} as const;

/** Text that must never appear in a message about Rex's household and records. */
export const DECOYS: readonly string[] = [
  'Biscuit',
  'INV-1002',
  'INV-9009',
  'Decoy',
  'fam2',
  'inv2',
  'vis2',
  'Decoykin',
  'Other Person',
];

export const WORLD_DOCS: Record<string, Record<string, unknown>> = {
  'business_settings/business_settings': {
    businessName: WORLD.businessName,
    timeZone: 'America/Chicago',
    businessEmail: 'e2e-admin@tribetails.com',
    householdNotificationsLive: true,
  },
  'families/fam1': {
    displayName: WORLD.householdName,
    primaryUid: 'cli1',
    email: WORLD.primaryEmail,
  },
  'clients/cli1': { displayName: WORLD.primaryName, email: WORLD.primaryEmail, phone: '+15555550101' },
  'families/fam1/kin/k1': { name: 'Rex', status: 'active' },
  'families/fam1/kin/k2': { name: 'Biscuit', status: 'active' },
  'families/fam1/bookings/bat1': {
    kinNames: ['Rex'],
    serviceType: WORLD.serviceName,
    serviceName: WORLD.serviceName,
    notes: 'Back gate sticks.',
  },
  'families/fam1/bookings/bat1/kinCares/vis1': {
    kinNames: ['Rex'],
    serviceType: WORLD.serviceName,
    serviceName: WORLD.serviceName,
    startTime: ts(VISIT_MS),
  },
  'families/fam1/bookings/bat2/kinCares/vis2': {
    kinNames: ['Biscuit'],
    serviceType: WORLD.serviceName,
    startTime: ts(DECOY_VISIT_MS),
  },
  // A flat visit row, the shape `kin_care_sessions` keeps (`vis_{visitId}`).
  'kin_care_sessions/vis_vis1': { kinfolkId: 'fam1', kinNames: ['Rex'], startTime: ts(VISIT_MS) },
  'kin_care_sessions/vis_x9': { kinfolkId: 'fam2', kinNames: ['Decoykin'], startTime: ts(DECOY_VISIT_MS) },
  'kin_care_sessions/vis_vis2': { kinfolkId: 'fam1', kinNames: ['Biscuit'], startTime: ts(DECOY_VISIT_MS) },
  'invoices/inv1': {
    kinfolkId: 'fam1',
    kinfolkName: WORLD.householdName,
    invoiceNumber: WORLD.invoiceNumber,
    total: 68,
    amountDue: 68,
    dueDate: 'Dec 10, 2026',
    date: 'Dec 3, 2026',
    // A decoy: a visit from the other household listed on Rex's bill.
    sessionIds: ['vis_vis1', 'vis_x9'],
  },
  'invoices/inv2': {
    kinfolkId: 'fam1',
    invoiceNumber: 'INV-1002',
    total: 99,
    amountDue: 99,
    dueDate: 'Dec 20, 2026',
    sessionIds: ['vis_vis2'],
  },
  'invoices/inv9': { kinfolkId: 'fam2', invoiceNumber: 'INV-9009', total: 12, amountDue: 12 },
  'kin_care_reports/tale1': { kinfolkId: 'fam1', sessionId: 'vis_vis1', title: 'A sunny walk', status: 'SENT' },
  'families/fam2': { displayName: 'The Decoy Home', primaryUid: 'cli2' },
  'clients/cli2': { displayName: 'Other Person', email: 'pawsome@hanasamku.com' },
  'staff/owner1': { displayName: 'Owner', email: 'e2e-admin@tribetails.com' },
  'staff/auntie1': { displayName: 'June', email: 'e2e-admin@tribetails.com' },
};

export const WORLD_QUERIES: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = {
  kin: [
    { id: 'k1', data: { kinfolkId: 'fam1', name: 'Rex', status: 'active' } },
    { id: 'k2', data: { kinfolkId: 'fam1', name: 'Biscuit', status: 'active' } },
    { id: 'k9', data: { kinfolkId: 'fam2', name: 'Decoykin', status: 'active' } },
  ],
};
