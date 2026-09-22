import { describe, it, expect } from 'vitest';
import { Timestamp } from '../lib/firebaseAdmin';
import {
  describeTarget,
  parseArgs,
  planEmergencyContactMigration,
  planFamiliesEmergencyContacts,
  refuseRun,
} from '../backfillKinfolkEmergencyContacts';

const OTHER = { key: 'vetClinicId', label: 'Vet Clinic', value: 'clinic-1' };
const FAMILY_EC = [
  { key: 'emergencyContactName', label: 'Emergency Contact', value: ' Sam Ortiz ' },
  { key: 'emergencyContactPhone', label: 'Emergency Contact Phone', value: '(805) 555-0111' },
  { key: 'emergencyContactRelation', label: 'Emergency Contact Relation', value: 'Brother' },
];

describe('planFamiliesEmergencyContacts (the portal store the admin never read)', () => {
  it('has nothing to do when families customFields hold no emergencyContact key', () => {
    expect(planFamiliesEmergencyContacts({ customFields: [OTHER] }, { firstName: 'Dana' })).toBeNull();
    expect(planFamiliesEmergencyContacts({}, { firstName: 'Dana' })).toBeNull();
  });

  it('moves the copy into slot 1 when the kinfolk has none, dated by the families doc, and keeps every other field', () => {
    const ts = Timestamp.fromDate(new Date('2026-02-10T09:30:00Z'));
    const plan = planFamiliesEmergencyContacts({ updatedAt: ts, customFields: [OTHER, ...FAMILY_EC] }, { firstName: 'Dana' });
    expect(plan?.action).toBe('move');
    if (plan?.action !== 'move') return;
    expect(plan.contact).toMatchObject({ name: 'Sam Ortiz', phone: '+18055550111', relationship: 'Brother' });
    expect(plan.contact.recordedAt).toEqual(ts);
    expect(plan.contact.updatedAt).toEqual(ts);
    expect(plan.dateSource).toBe('families.updatedAt');
    expect(plan.keep).toEqual([OTHER]);
    expect(plan.stale.map((f) => f.key)).toEqual(['emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation']);
  });

  it('says the date is unknown rather than stamping the migration time', () => {
    const plan = planFamiliesEmergencyContacts({ customFields: FAMILY_EC }, { firstName: 'Dana' });
    expect(plan?.action === 'move' && plan.contact.recordedAt).toBeNull();
    expect(plan?.action === 'move' && plan.dateSource).toBeNull();
  });

  it('only strips when the kinfolk already holds contacts: the office copy is the newer decision', () => {
    const plan = planFamiliesEmergencyContacts(
      { customFields: [OTHER, ...FAMILY_EC] },
      { emergencyContacts: [{ name: 'Lee Park', phone: '+18055550177' }] },
    );
    expect(plan).toMatchObject({ action: 'strip', reason: 'kinfolk-has-contacts', keep: [OTHER] });
  });

  it("only strips when the kinfolk's own flat fields are migrating in the same run", () => {
    const plan = planFamiliesEmergencyContacts(
      { customFields: FAMILY_EC },
      { emergencyContactName: 'Rae Mercer', emergencyContactPhone: '8055550199' },
    );
    expect(plan).toMatchObject({ action: 'strip', reason: 'kinfolk-flat-wins', keep: [] });
  });

  it('strips half a record without inventing the other half, and keeps the values for the report', () => {
    const plan = planFamiliesEmergencyContacts({ customFields: [OTHER, FAMILY_EC[0]!] }, { firstName: 'Dana' });
    expect(plan).toMatchObject({ action: 'strip', reason: 'half-record', keep: [OTHER] });
    expect(plan?.stale[0]?.value).toBe(' Sam Ortiz ');
  });

  it('refuses to move the families copy over half a kinfolk record, and reports both values', () => {
    const plan = planFamiliesEmergencyContacts(
      { customFields: [OTHER, ...FAMILY_EC] },
      { firstName: 'Dana', emergencyContactName: 'Rae Mercer' },
    );
    expect(plan).toMatchObject({
      action: 'report',
      reason: 'kinfolk-half-record',
      kinfolkHalf: { name: 'Rae Mercer', phone: '' },
    });
    expect(plan?.stale.map((f) => f.value)).toEqual([' Sam Ortiz ', '(805) 555-0111', 'Brother']);
    expect(plan).not.toHaveProperty('keep');
  });

  it('reports a families doc with no kinfolk doc and plans no write for it', () => {
    expect(planFamiliesEmergencyContacts({ customFields: FAMILY_EC }, null)).toMatchObject({ action: 'report', reason: 'no-kinfolk-doc' });
  });
});

describe('parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toEqual({ mode: 'dry-run', allowProd: false, emulatorApply: false, projectId: null });
  });
  it('applies only with --allow-prod, and --dry-run wins in either order', () => {
    expect(parseArgs(['--allow-prod']).mode).toBe('apply');
    expect(parseArgs(['--allow-prod', '--dry-run']).mode).toBe('dry-run');
    expect(parseArgs(['--dry-run', '--allow-prod']).mode).toBe('dry-run');
  });
  // #893 item 4.
  it('applies only with --emulator-apply too, and --dry-run wins in either order', () => {
    expect(parseArgs(['--emulator-apply'])).toEqual({ mode: 'apply', allowProd: false, emulatorApply: true, projectId: null });
    expect(parseArgs(['--emulator-apply', '--dry-run']).mode).toBe('dry-run');
    expect(parseArgs(['--dry-run', '--emulator-apply']).mode).toBe('dry-run');
  });
  it('refuses an unknown arg and a valueless --project', () => {
    expect(() => parseArgs(['--wipe'])).toThrow(/unknown arg/);
    expect(() => parseArgs(['--project', '--dry-run'])).toThrow(/--project requires a value/);
  });
});

describe('describeTarget and refuseRun (#829 review)', () => {
  const EMU = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' };
  const CREDS = { GOOGLE_APPLICATION_CREDENTIALS: '/tmp/sa.json' };

  it('names the project and says emulator or production on every run', () => {
    expect(describeTarget(parseArgs(['--project', 'demo']), EMU)).toBe(
      'TARGET: project demo, Firestore EMULATOR at 127.0.0.1:8080, DRY-RUN',
    );
    expect(describeTarget(parseArgs(['--allow-prod']), { GCLOUD_PROJECT: 'auntieos-ttpc', ...CREDS })).toBe(
      'TARGET: project auntieos-ttpc, PRODUCTION Firestore, APPLY',
    );
    expect(describeTarget(parseArgs([]), {})).toBe('TARGET: project (from credentials), PRODUCTION Firestore, DRY-RUN');
    // #893 item 4.
    expect(describeTarget(parseArgs(['--emulator-apply']), EMU)).toBe(
      'TARGET: project (from credentials), Firestore EMULATOR at 127.0.0.1:8080, APPLY',
    );
  });

  it('refuses --allow-prod while FIRESTORE_EMULATOR_HOST is set, even with --dry-run and credentials', () => {
    expect(refuseRun(parseArgs(['--allow-prod']), { ...EMU, ...CREDS })).toMatch(/refusing --allow-prod while FIRESTORE_EMULATOR_HOST is set/);
    expect(refuseRun(parseArgs(['--allow-prod', '--dry-run']), EMU)).toMatch(/refusing --allow-prod/);
  });

  it('lets a dry run go anywhere, and a production write only with credentials', () => {
    expect(refuseRun(parseArgs([]), EMU)).toBeNull();
    expect(refuseRun(parseArgs([]), {})).toBeNull();
    expect(refuseRun(parseArgs(['--allow-prod']), {})).toMatch(/GOOGLE_APPLICATION_CREDENTIALS/);
    expect(refuseRun(parseArgs(['--allow-prod']), CREDS)).toBeNull();
  });

  // #893 item 4.
  it('--emulator-apply refuses without the emulator, refuses alongside --allow-prod, and needs no credentials', () => {
    expect(refuseRun(parseArgs(['--emulator-apply']), {})).toMatch(/--emulator-apply requires FIRESTORE_EMULATOR_HOST/);
    expect(refuseRun(parseArgs(['--emulator-apply']), CREDS)).toMatch(/--emulator-apply requires FIRESTORE_EMULATOR_HOST/);
    expect(refuseRun(parseArgs(['--allow-prod', '--emulator-apply']), EMU)).toMatch(/pass one of --allow-prod or --emulator-apply, not both/);
    expect(refuseRun(parseArgs(['--emulator-apply']), EMU)).toBeNull();
  });
});

describe('planEmergencyContactMigration', () => {
  it('moves the flat triple into slot 0, dated by the doc updatedAt string, never now', () => {
    const plan = planEmergencyContactMigration({
      emergencyContactName: ' Rae Mercer ',
      emergencyContactPhone: '805-555-0199',
      emergencyContactRelation: 'Sister',
      updatedAt: '2026-03-02T10:00:00.000Z',
    });
    expect(plan.action).toBe('migrate');
    if (plan.action !== 'migrate') return;
    expect(plan.contact).toMatchObject({ name: 'Rae Mercer', phone: '+18055550199', relationship: 'Sister' });
    expect(plan.contact.recordedAt?.toDate().toISOString()).toBe('2026-03-02T10:00:00.000Z');
    expect(plan.contact.updatedAt).toEqual(plan.contact.recordedAt);
    expect(plan.dateSource).toBe('updatedAt');
  });

  it('accepts a Timestamp updatedAt and falls back to joinDate, then null', () => {
    const ts = Timestamp.fromDate(new Date('2026-04-01T00:00:00Z'));
    const a = planEmergencyContactMigration({ emergencyContactName: 'Rae', emergencyContactPhone: '8055550199', updatedAt: ts });
    expect(a.action === 'migrate' && a.contact.recordedAt).toEqual(ts);
    const b = planEmergencyContactMigration({ emergencyContactName: 'Rae', emergencyContactPhone: '8055550199', joinDate: '2025-11-20' });
    expect(b.action === 'migrate' && b.dateSource).toBe('joinDate');
    const c = planEmergencyContactMigration({ emergencyContactName: 'Rae', emergencyContactPhone: '8055550199' });
    expect(c.action === 'migrate' && c.contact.recordedAt).toBeNull();
  });

  it('an empty relationship becomes null', () => {
    const p = planEmergencyContactMigration({ emergencyContactName: 'Rae', emergencyContactPhone: '8055550199', emergencyContactRelation: '  ' });
    expect(p.action === 'migrate' && p.contact.relationship).toBeNull();
  });

  it('carries an unparseable phone as typed and flags it', () => {
    const p = planEmergencyContactMigration({ emergencyContactName: 'Rae', emergencyContactPhone: 'ask neighbour' });
    expect(p.action === 'migrate' && p.contact.phone).toBe('ask neighbour');
    expect(p.action === 'migrate' && p.phoneCarriedAsTyped).toBe(true);
  });

  it('skips a doc that already has the array, and one with nothing to move', () => {
    expect(planEmergencyContactMigration({ emergencyContactName: 'Rae', emergencyContactPhone: '8055550199', emergencyContacts: [{ name: 'Lee', phone: '+18055550177' }] })).toEqual({ action: 'skip', reason: 'already-has-array' });
    expect(planEmergencyContactMigration({ firstName: 'Dana' })).toEqual({ action: 'skip', reason: 'no-flat-fields' });
  });

  it('reports half a record for a person instead of inventing the other half', () => {
    expect(planEmergencyContactMigration({ emergencyContactName: 'Rae' })).toEqual({ action: 'report', reason: 'phone-missing' });
    expect(planEmergencyContactMigration({ emergencyContactPhone: '8055550199' })).toEqual({ action: 'report', reason: 'name-missing' });
  });
});
