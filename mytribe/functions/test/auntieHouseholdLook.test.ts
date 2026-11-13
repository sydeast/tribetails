import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildDbMock } from './_helpers/mockDb';
import { AUNTIE_ALLOWED_CALLABLES } from '../src/lib/auntieAccess';

/**
 * #1839, operator ruling 2026-11-12: the owner's own looks at a household write
 * NO Activity Log line; an Auntie's look writes ONE line in plain words, with
 * her name and the household's.
 *
 * Each household callable an Auntie can reach is called here as the owner and
 * as an Auntie, through its real handler. Only the resolver's line is asserted:
 * a handler that goes on to fail on the thin fixture has already resolved the
 * household (and written, or not written, its line) by then.
 */

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  writeAuditEntry: vi.fn(),
  resolveStaffIdentities: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntry }));
vi.mock('../src/lib/staffIdentity', () => ({ resolveStaffIdentities: mocks.resolveStaffIdentities }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__', delete: () => '__DELETE__' } };
});

const OWNER = { uid: 'owner-uid', token: { admin: true } };
const AUNTIE = { uid: 'aunt-uid', token: { staffRole: 'auntie' } };

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntry.mockReset();
  mocks.writeAuditEntry.mockResolvedValue('a1');
  mocks.resolveStaffIdentities.mockReset();
  mocks.resolveStaffIdentities.mockResolvedValue([
    { uid: 'aunt-uid', displayName: 'Jane Rivers', email: null, hasStaffRecord: true },
  ]);
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

function seed() {
  return buildDbMock({
    docs: {
      'clients/owner-uid': null,
      'clients/aunt-uid': null,
      'kinfolk/fam1': { firstName: 'Dre', lastName: 'East' },
      'families/fam1': { displayName: 'Dre East' },
      'kin_care_reports/tale1': { kinfolkId: 'fam1', mediaIds: [] },
    },
    queryDocs: {
      'families/fam1/members': [],
      'families/fam1/secondaryKinfolk': [],
    },
  });
}

const accessLines = () =>
  mocks.writeAuditEntry.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((e) => e['event'] === 'OPERATOR_CROSSTENANT_ACCESS');

type Handler = (req: never) => Promise<unknown>;
const PATHS: ReadonlyArray<{ name: string; load: () => Promise<Handler>; data: Record<string, unknown>; words: string }> = [
  {
    name: 'listMembers',
    load: async () => (await import('../src/portal/listMembers')).listMembersHandler as Handler,
    data: { kinfolkId: 'fam1' },
    words: 'Jane Rivers looked at the members of Kinfolk Dre East',
  },
  {
    name: 'listEmergencyContacts',
    load: async () => (await import('../src/portal/emergencyContacts')).listEmergencyContactsHandler as Handler,
    data: { kinfolkId: 'fam1' },
    words: 'Jane Rivers looked at the emergency contacts of Kinfolk Dre East',
  },
  {
    name: 'saveEmergencyContacts',
    load: async () => (await import('../src/portal/emergencyContacts')).saveEmergencyContactsHandler as Handler,
    data: { kinfolkId: 'fam1', contacts: [{ name: 'Rae Park', phone: '+1 805 555 0199' }] },
    words: 'Jane Rivers changed the emergency contacts of Kinfolk Dre East',
  },
  {
    name: 'getMyKinTaleMedia',
    load: async () => (await import('../src/portal/getMyKinTaleMedia')).getMyKinTaleMediaHandler as Handler,
    data: { kinfolkId: 'fam1', taleId: 'tale1' },
    words: 'Jane Rivers looked at KinTale photos of Kinfolk Dre East',
  },
  {
    name: 'listSecondaryKinfolk',
    load: async () => (await import('../src/portal/secondaryKinfolk')).listSecondaryKinfolkHandler as Handler,
    data: { kinfolkId: 'fam1' },
    words: 'Jane Rivers looked at the secondary Kinfolk of Kinfolk Dre East',
  },
  {
    name: 'saveSecondaryKinfolk',
    load: async () => (await import('../src/portal/secondaryKinfolk')).saveSecondaryKinfolkHandler as Handler,
    data: { kinfolkId: 'fam1', name: 'Lee Park', phone: '+1 805 555 0123' },
    words: 'Jane Rivers saved a secondary Kinfolk for Kinfolk Dre East',
  },
];

describe('#1839 household looks, per callable an Auntie can reach', () => {
  it('covers every allowlisted callable that resolves a household', () => {
    expect(PATHS.map((p) => p.name).sort()).toEqual([...allowlistedResolverCallers()].sort());
  });

  for (const path of PATHS) {
    it(`${path.name}: the owner's look writes no line`, async () => {
      mocks.dbFn.mockReturnValue(seed().db);
      const handler = await path.load();
      await handler({ data: path.data, auth: OWNER } as never).catch(() => undefined);
      expect(accessLines()).toEqual([]);
    });

    it(`${path.name}: an Auntie's look writes one plain line with her name`, async () => {
      mocks.dbFn.mockReturnValue(seed().db);
      const handler = await path.load();
      await handler({ data: path.data, auth: AUNTIE } as never).catch(() => undefined);
      const lines = accessLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        actorUid: 'aunt-uid',
        actorRole: 'AUNTIE',
        targetUid: 'fam1',
        familyId: 'fam1',
        description: path.words,
        payload: { function: path.name, kinfolkId: 'fam1', admin: false, staffRole: 'auntie' },
      });
    });
  }
});

/**
 * THE GUARD. The resolver can tell the owner from an Auntie only through the
 * `caller` it is handed, so every call to it in a file that serves a callable
 * an Auntie may invoke must pass `req.auth`. Forgetting it would silently drop
 * her lines, which is the failure this test exists to catch.
 */
const SRC = join(__dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/** The argument text of every `resolveKinfolkAccess(...)` call in `code`. */
function resolverCalls(code: string): string[] {
  const out: string[] = [];
  const re = /\bresolveKinfolkAccess\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const lineStart = code.lastIndexOf('\n', m.index) + 1;
    const line = code.slice(lineStart, m.index);
    if (/^\s*(\*|\/\/)/.test(line) || /function\s+$/.test(line) || /`$/.test(line)) continue;
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') depth--;
    }
    out.push(code.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

function filesWithResolverCalls(): Array<{ file: string; code: string; calls: string[] }> {
  return sourceFiles(SRC)
    .filter((f) => !f.endsWith(join('lib', 'resolveKinfolkAccess.ts')))
    .map((file) => {
      const code = readFileSync(file, 'utf8');
      return { file, code, calls: resolverCalls(code) };
    })
    .filter((f) => f.calls.length > 0);
}

function allowlistedResolverCallers(): Set<string> {
  const names = new Set<string>();
  for (const { code } of filesWithResolverCalls()) {
    for (const name of AUNTIE_ALLOWED_CALLABLES) {
      if (code.includes(`'${name}'`)) names.add(name);
    }
  }
  return names;
}

describe('#1839 guard: an Auntie-reachable resolver call passes the caller', () => {
  it('finds the resolver calls it guards (a scan that finds nothing proves nothing)', () => {
    expect(filesWithResolverCalls().length).toBeGreaterThan(10);
    expect(allowlistedResolverCallers().size).toBeGreaterThan(0);
  });

  it('every resolver call in a file serving an allowlisted callable ends with req.auth', () => {
    const missing: string[] = [];
    for (const { file, code, calls } of filesWithResolverCalls()) {
      const servesAuntie = [...AUNTIE_ALLOWED_CALLABLES].some((name) => code.includes(`'${name}'`));
      if (!servesAuntie) continue;
      for (const args of calls) {
        if (!/,\s*req\.auth\s*,?\s*$/.test(args)) missing.push(`${file.slice(SRC.length + 1)}: ${args.replace(/\s+/g, ' ').trim()}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
