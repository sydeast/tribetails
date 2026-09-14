import { describe, it, expect } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { parseArgs, planEmergencyContactMigration } from '../backfillKinfolkEmergencyContacts';

describe('parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toEqual({ mode: 'dry-run', allowProd: false, projectId: null });
  });
  it('applies only with --allow-prod, and --dry-run wins in either order', () => {
    expect(parseArgs(['--allow-prod']).mode).toBe('apply');
    expect(parseArgs(['--allow-prod', '--dry-run']).mode).toBe('dry-run');
    expect(parseArgs(['--dry-run', '--allow-prod']).mode).toBe('dry-run');
  });
  it('refuses an unknown arg and a valueless --project', () => {
    expect(() => parseArgs(['--wipe'])).toThrow(/unknown arg/);
    expect(() => parseArgs(['--project', '--dry-run'])).toThrow(/--project requires a value/);
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
