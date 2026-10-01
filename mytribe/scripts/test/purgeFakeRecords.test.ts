import { describe, it, expect } from 'vitest';
import {
  assertPlanSafe,
  contactsOf,
  deleteOrder,
  describeTarget,
  parseArgs,
  planLines,
  planFingerprint,
  planProblems,
  resolveTarget,
  deployedTriggerModel,
  OWNER_CHECK_MARKER,
  type Plan,
} from '../purgeFakeRecords';

const BOTH = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' };

function plan(over: Partial<Plan> = {}): Plan {
  return {
    households: [],
    uids: [],
    docs: [],
    users: [],
    danglingClients: [],
    triggerSideEffects: [],
    triggerConflicts: [],
    trigger: { model: 'blind', line: 'Deployed onClientsWrite: not checked' },
    sendGate: { line: 'Household send gate (business_settings/business_settings.householdNotificationsLive): OFF (field not set): household notifications are NOT sent', raw: undefined, source: 'business_settings/business_settings' },
    ...over,
  };
}

describe('parseArgs (#1082)', () => {
  it('defaults to read only, no project, no --allow-prod', () => {
    expect(parseArgs([])).toEqual({ projectId: null, allowProd: false, apply: false, settleSeconds: null, confirm: null });
  });

  it('reads every flag', () => {
    expect(parseArgs(['--project', 'p1', '--allow-prod', '--apply', '--confirm', 'ABCDEF012345', '--settle-seconds', '3'])).toEqual({
      projectId: 'p1',
      allowProd: true,
      apply: true,
      settleSeconds: 3,
      confirm: 'abcdef012345',
    });
  });
  it('--apply without --confirm is refused, and --confirm must look like a fingerprint', () => {
    expect(() => parseArgs(['--allow-prod', '--apply'])).toThrow(/--apply needs --confirm/);
    expect(() => parseArgs(['--apply', '--confirm', 'yes'])).toThrow(/12-character plan fingerprint/);
  });

  it('--dry-run beats --apply in either order', () => {
    expect(parseArgs(['--apply', '--dry-run']).apply).toBe(false);
    expect(parseArgs(['--dry-run', '--apply']).apply).toBe(false);
  });

  it('--allow-prod alone never means apply', () => {
    expect(parseArgs(['--allow-prod']).apply).toBe(false);
  });

  it('refuses unknown flags and flags used as values', () => {
    expect(() => parseArgs(['--write'])).toThrow(/unknown arg/);
    expect(() => parseArgs(['--project', '--apply'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--settle-seconds', 'x'])).toThrow(/whole number/);
  });
});

describe('resolveTarget (#1082)', () => {
  it('is the emulator only when BOTH emulator hosts are set', () => {
    const t = resolveTarget(parseArgs(['--project', 'demo']), BOTH);
    expect(t).toEqual({ kind: 'emulator', firestoreHost: '127.0.0.1:8080', authHost: '127.0.0.1:9099', projectId: 'demo' });
    expect(describeTarget(t, false)).toBe('Target: EMULATOR firestore 127.0.0.1:8080 auth 127.0.0.1:9099, project demo - READ ONLY (writes nothing)');
  });

  it('refuses when exactly one emulator host is set, with or without --allow-prod', () => {
    expect(() => resolveTarget(parseArgs([]), { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' })).toThrow(/only one emulator host/);
    expect(() => resolveTarget(parseArgs(['--allow-prod']), { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' })).toThrow(/only one emulator host/);
  });

  it('refuses --allow-prod while the emulator hosts are set', () => {
    expect(() => resolveTarget(parseArgs(['--allow-prod']), BOTH)).toThrow(/refusing --allow-prod/);
  });

  it('refuses production without --allow-prod', () => {
    expect(() => resolveTarget(parseArgs(['--project', 'auntieos-ttpc']), {})).toThrow(/Pass --allow-prod/);
  });

  it('names production, its project and the mode', () => {
    const t = resolveTarget(parseArgs(['--project', 'auntieos-ttpc', '--allow-prod', '--apply', '--confirm', '0123456789ab']), {});
    expect(describeTarget(t, true)).toBe('Target: PRODUCTION, project auntieos-ttpc - APPLY (DELETES)');
  });
});

describe('contactsOf', () => {
  it('reads contact keys at any depth and address arrays, not free text', () => {
    const c = contactsOf('notifications/n1', {
      body: 'write to hello@tribetails.com',
      fromAddress: 'office@tribetails.com',
      data: { invitedEmail: 'x@a.test', kinfolkId: 'k1' },
      toAddresses: ['y@b.test', 'z@gmail.com'],
    });
    expect(c).toEqual([
      { field: 'data.invitedEmail', address: 'x@a.test' },
      { field: 'toAddresses[0]', address: 'y@b.test' },
      { field: 'toAddresses[1]', address: 'z@gmail.com' },
    ]);
  });

  it('counts an address-shaped displayName on a members row only', () => {
    expect(contactsOf('families/h/members/u', { displayName: 'a@x.test' })).toEqual([{ field: 'displayName', address: 'a@x.test' }]);
    expect(contactsOf('kinfolk/h', { displayName: 'a@x.com' })).toEqual([]);
  });
});

describe('planProblems / assertPlanSafe', () => {
  it('passes a plan whose every address is reserved', () => {
    const p = plan({
      docs: [{ path: 'kinfolk/h', reason: 'r', contacts: [{ field: 'email', address: 'a@x.test' }] }],
      users: [{ uid: 'u', email: 'a@x.test', disabled: false, reason: 'r' }],
    });
    expect(planProblems(p)).toEqual([]);
    expect(() => assertPlanSafe(p)).not.toThrow();
  });

  it('refuses a real-looking domain and names only the domain', () => {
    const p = plan({ docs: [{ path: 'families/h/members/u', reason: 'r', contacts: [{ field: 'displayName', address: 'jane@gmail.com' }] }] });
    expect(planProblems(p)).toEqual(['families/h/members/u displayName: real-looking domain gmail.com']);
    expect(() => assertPlanSafe(p)).toThrow(/REFUSED: 1 target/);
  });

  it('refuses each protected real account, docs and Auth users alike', () => {
    const p = plan({
      docs: [{ path: 'clients/a', reason: 'r', contacts: [{ field: 'email', address: 'catch@hanasamku.com' }] }],
      users: [
        { uid: 'b', email: 'e2e-admin@tribetails.com', disabled: false, reason: 'r' },
        { uid: 'c', email: 'pawsome@hanasamku.com', disabled: false, reason: 'r' },
        { uid: 'd', email: 'ops@tribetails.com', disabled: true, reason: 'r' },
      ],
    });
    expect(planProblems(p)).toHaveLength(4);
    expect(planProblems(p).every((s) => s.includes('PROTECTED'))).toBe(true);
  });
});

describe('planFingerprint', () => {
  it('depends only on the sorted paths and uids, and is printed last', () => {
    const a = plan({ docs: [{ path: 'kinfolk/a', reason: 'x', contacts: [] }, { path: 'kin/b', reason: 'y', contacts: [] }], users: [{ uid: 'u', email: null, disabled: false, reason: 'r' }] });
    const b = plan({ docs: [{ path: 'kin/b', reason: 'other', contacts: [] }, { path: 'kinfolk/a', reason: 'z', contacts: [] }], users: [{ uid: 'u', email: 'x@y.test', disabled: true, reason: 'q' }] });
    const c = plan({ docs: [{ path: 'kinfolk/a', reason: 'x', contacts: [] }], users: [{ uid: 'u', email: null, disabled: false, reason: 'r' }] });
    expect(planFingerprint(a)).toMatch(/^[0-9a-f]{12}$/);
    expect(planFingerprint(a)).toBe(planFingerprint(b));
    expect(planFingerprint(a)).not.toBe(planFingerprint(c));
    const lines = planLines(a);
    expect(lines[lines.length - 1]).toBe(`Plan fingerprint: ${planFingerprint(a)}  (2 document(s), 1 Auth user(s))`);
  });
});
describe('trigger conflicts', () => {
  it('refuse the run', () => {
    const p = plan({ triggerConflicts: ['deleting clients/u makes onClientsWrite clear kinfolk/h.uid, which holds another account (r), not u'] });
    expect(planProblems(p)).toEqual(['TRIGGER: deleting clients/u makes onClientsWrite clear kinfolk/h.uid, which holds another account (r), not u']);
    expect(() => assertPlanSafe(p)).toThrow(/REFUSED/);
  });
});
describe('deleteOrder', () => {
  it('deletes deepest first and households last', () => {
    expect(
      deleteOrder(['kinfolk/h', 'families/h', 'invoices/i', 'families/h/bookings/b', 'families/h/bookings/b/kinCares/v', 'invoices/i/payments/p', 'clients/u']),
    ).toEqual(['families/h/bookings/b/kinCares/v', 'families/h/bookings/b', 'invoices/i/payments/p', 'clients/u', 'invoices/i', 'families/h', 'kinfolk/h']);
  });
});

describe('planLines', () => {
  it('prints the send gate first and a WOULD REFUSE block when a target is real', () => {
    const lines = planLines(plan({ docs: [{ path: 'payments/p', reason: 'r', contacts: [{ field: 'email', address: 'a@yahoo.com' }] }] }));
    expect(lines[0]).toMatch(/^Household send gate \(business_settings\/business_settings\.householdNotificationsLive\): OFF/);
    expect(lines.join('\n')).toMatch(/WOULD REFUSE: 1 target/);
  });
});
describe('deployedTriggerModel (#1085)', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  it('assumes the blind trigger when there is no .release-state', () => {
    const r = deployedTriggerModel({ readReleaseState: () => null, showFileAt: () => OWNER_CHECK_MARKER });
    expect(r.model).toBe('blind');
    expect(r.line).toContain('no .release-state');
  });
  it('assumes the blind trigger when the released source cannot be read', () => {
    const r = deployedTriggerModel({ readReleaseState: () => `${SHA}\n`, showFileAt: () => null });
    expect(r.model).toBe('blind');
    expect(r.line).toContain('0123456');
  });
  it('reads the released commit, not the checkout: a release before the fix stays blind', () => {
    const r = deployedTriggerModel({ readReleaseState: () => SHA, showFileAt: () => "set({ uid: '' }, { merge: true })" });
    expect(r.model).toBe('blind');
    expect(r.line).toContain('predates #1085');
  });
  it('trusts the owner check once the released commit carries it', () => {
    let asked = '';
    const r = deployedTriggerModel({
      readReleaseState: () => `${SHA}\n`,
      showFileAt: (sha) => {
        asked = sha;
        return `if (snap.exists && ${OWNER_CHECK_MARKER}) {}`;
      },
    });
    expect(asked).toBe(SHA);
    expect(r.model).toBe('checks-owner');
  });
  it('prints the trigger line under the send gate', () => {
    const lines = planLines(plan({ trigger: { model: 'checks-owner', line: 'Deployed onClientsWrite: X' } }));
    expect(lines[1]).toBe('Deployed onClientsWrite: X');
  });
});
