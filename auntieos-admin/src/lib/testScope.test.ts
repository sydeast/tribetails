import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyTestScope,
  isSuppressedInTestMode,
  setTestScope,
  SCOPED_BY_KINFOLK,
  SUPPRESSED_IN_TEST_MODE,
} from './testScope';
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

/**
 * The other half of the sandbox contract: collections a test admin can never
 * read AND cannot be scoped into, so the only honest behaviour is an empty
 * result rather than a red "Missing or insufficient permissions" banner.
 *
 * `training_documents` (The Den's Tribal Intel) was in NEITHER set, so a
 * sandbox operator opening that screen got the raw permission error. It cannot
 * be scoped into range either way: `web/firestore.rules:633` reads
 * `allow read: if isAuntie();` with no isTestAdmin branch, so no predicate can
 * buy a permission the rule never grants, and the doc carries no `kinfolkId`
 * to scope BY (its household FKs are `targetKinfolkId`/`targetKinId`, and the
 * pre-spec-23 migrated rows carry neither). MyTribe's own rules suite already
 * pins the denial: testAdminSandbox.test.ts:238.
 */
describe('isSuppressedInTestMode', () => {
  beforeEach(() => setTestScope(null));

  it('suppresses training_documents for a test admin, so Tribal Intel reads empty and NOT an error', () => {
    setTestScope('test-kinfolk-001');
    expect(isSuppressedInTestMode('training_documents')).toBe(true);
  });

  it('leaves training_documents queryable for the operator, who holds isAuntie', () => {
    // No suppression without a test claim: the operator must still see real rows.
    expect(isSuppressedInTestMode('training_documents')).toBe(false);
  });

  it('is never both suppressed and scoped: the two sets cannot overlap', () => {
    // A path in both would be queried under a predicate AND expected to resolve
    // empty, which is incoherent. Suppression means "do not query at all".
    for (const path of SUPPRESSED_IN_TEST_MODE) {
      expect(SCOPED_BY_KINFOLK.has(path)).toBe(false);
    }
  });

  it('does not suppress a collection a test admin can genuinely read', () => {
    setTestScope('test-kinfolk-001');
    expect(isSuppressedInTestMode('invoices')).toBe(false);
    expect(isSuppressedInTestMode('kinfolk')).toBe(false);
  });

  it('suppresses the four comms logs, which the rules deny a test admin outright', () => {
    // sms_messages / emails / calls_log / voicemails are each
    // `allow read, write: if isAuntie()` with NO isTestAdmin branch, so every
    // read by a sandbox account is denied no matter what predicate the query
    // carries. The recipient context panel queries all four, so without this a
    // sandbox login turns the panel into four red permission banners for data
    // that simply does not apply to that account type.
    setTestScope('test-kinfolk-001');
    for (const path of ['sms_messages', 'emails', 'calls_log', 'voicemails']) {
      expect(isSuppressedInTestMode(path)).toBe(true);
    }
  });
  it('suppresses exactly the collections rules deny a test admin outright', () => {
    // Do not diverge without re-auditing firestore.rules: an entry added here
    // by mistake silently blanks a screen the sandbox is allowed to see.
    expect([...SUPPRESSED_IN_TEST_MODE].sort()).toEqual(
      [
        'activity_log',
        'booking_time_slots',
        'calls_log',
        'emails',
        'sms_messages',
        'training_documents',
        'voicemails',
      ].sort(),
    );
  });
});
