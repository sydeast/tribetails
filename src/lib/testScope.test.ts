import { beforeEach, describe, expect, it } from 'vitest';
import { applyTestScope, setTestScope, SCOPED_BY_KINFOLK } from './testScope';
import { type CollectionSpec } from './firestore';

/**
 * Guards the sandbox-scoping defect found by driving the LIVE app on
 * 2026-07-20: every collection query in this app read the whole collection with
 * no `kinfolkId` predicate, so a Stage-0I test admin (who holds `testTribeId`,
 * NOT `isAuntie`) was permission-denied on every screen. Home, Invoices and
 * Directory all rendered "Missing or insufficient permissions".
 *
 * `gate.ts` already parsed the claim and the shell already rendered the sandbox
 * banner from it — the scoping simply never reached the query layer. The android
 * tree has done this correctly all along via `scopedByKinfolk`; this is that
 * rule, enforced centrally so a screen CANNOT forget it.
 */
describe('applyTestScope', () => {
  const spec: CollectionSpec = { path: 'invoices', order: ['createdAt', 'desc'], max: 200 };

  beforeEach(() => setTestScope(null));

  it('is a no-op for the operator (no test claim)', () => {
    expect(applyTestScope(spec)).toEqual(spec);
  });

  it('adds the kinfolkId predicate for a test admin', () => {
    setTestScope('test-kinfolk-001');
    expect(applyTestScope(spec).filters).toEqual([['kinfolkId', '==', 'test-kinfolk-001']]);
  });

  it('preserves order, max and path while scoping', () => {
    setTestScope('test-kinfolk-001');
    const out = applyTestScope(spec);
    expect(out.path).toBe('invoices');
    expect(out.order).toEqual(['createdAt', 'desc']);
    expect(out.max).toBe(200);
  });

  it('keeps a screen-supplied filter alongside the scope predicate', () => {
    setTestScope('test-kinfolk-001');
    const withFilter: CollectionSpec = { ...spec, filters: [['status', '==', 'open']] };
    expect(applyTestScope(withFilter).filters).toEqual([
      ['status', '==', 'open'],
      ['kinfolkId', '==', 'test-kinfolk-001'],
    ]);
  });

  it('does NOT scope collections that carry no kinfolkId', () => {
    // Global config. Scoping these by kinfolkId would return zero rows rather
    // than deny, which is the silent-empty failure this app exists to avoid.
    setTestScope('test-kinfolk-001');
    for (const path of ['kintale_templates', 'booking_time_slots', 'training_documents']) {
      expect(applyTestScope({ ...spec, path }).filters).toBeUndefined();
    }
  });

  it('scopes exactly the collections the android tree scopes', () => {
    // Parity with AuntieRepository.scopedByKinfolk, which went through the
    // 2026-07-18 sandbox permission audit. Do not diverge without re-auditing.
    expect([...SCOPED_BY_KINFOLK].sort()).toEqual(
      ['invoices', 'kin', 'kin_care_reports', 'kin_care_sessions', 'media_files', 'payments', 'visit_logs'].sort(),
    );
  });

  it('scopes kinfolk by DOCUMENT ID, not by a kinfolkId field', () => {
    // A kinfolk doc has no kinfolkId of its own; its doc id IS the tribe id.
    // Verified live 2026-07-20: Directory's Kin tab loaded (kin carries
    // kinfolkId) while its Kinfolk tab was denied for exactly this reason.
    setTestScope('test-kinfolk-001');
    const out = applyTestScope({ path: 'kinfolk', order: ['lastName', 'asc'], max: 500 });
    expect(out.filters).toEqual([['__name__', '==', 'test-kinfolk-001']]);
  });

  it('does not scope kinfolk for the operator', () => {
    expect(applyTestScope({ path: 'kinfolk', order: ['lastName', 'asc'], max: 500 }).filters).toBeUndefined();
  });

  it('is idempotent, so a re-render cannot stack duplicate predicates', () => {
    setTestScope('test-kinfolk-001');
    expect(applyTestScope(applyTestScope(spec)).filters).toEqual([
      ['kinfolkId', '==', 'test-kinfolk-001'],
    ]);
  });
});
