import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({
  writeAuditEntryMock: vi.fn(),
  dbFn: vi.fn(),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryMock }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
const sentry = vi.hoisted(() => ({ captureFunctionError: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: sentry.captureFunctionError }));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));

import {
  AUDIT_EVENTS,
  SERVER_ONLY_AUDIT_EVENTS,
  SERVER_ONLY_EVENT_REFUSAL,
  isServerOnlyAuditEvent,
} from '../src/lib/auditEvents';
import { AUNTIE_LOGGABLE_EVENTS, logActivityHandler } from '../src/admin/logActivity';
import { wrapAdminCallable } from '../src/lib/wrapAdminCallable';

/**
 * #2162: the Activity Log kinds only the server writes are refused from every
 * client sign-in, the owner's included, on `logActivity`. Every other kind the
 * owner's apps write keeps working.
 *
 * The list lives in `src/lib/auditEvents.ts`. Two scans here keep it honest:
 * the server's own writers (every `AUDIT_EVENTS.X` emitted under `src/`), and
 * the lines the three admin clients send through `logActivity` today.
 */

const OWNER = { admin: true };
const AUNTIE = { staffRole: 'auntie' };
const BOTH = { admin: true, staffRole: 'auntie' };

function req(data: unknown, uid: string, token: Record<string, unknown>): CallableRequest<unknown> {
  return {
    data,
    auth: { uid, token } as never,
    rawRequest: {} as never,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

beforeEach(() => {
  process.env.AUNTIE_OPERATOR_UIDS = '';
  mocks.writeAuditEntryMock.mockReset();
  mocks.writeAuditEntryMock.mockResolvedValue('audit-entry-1');
  mocks.dbFn.mockReset();
  mocks.dbFn.mockReturnValue(buildDbMock({ docs: {} }).db);
});

const FUNCTIONS = join(__dirname, '..');
const REPO = join(FUNCTIONS, '..', '..');

function walk(dir: string, keep: (path: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'build' || name.startsWith('.')) return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p, keep) : keep(p) ? [p] : [];
  });
}

// ── The server's own writers ───────────────────────────────────────────────

/** Every key a file under `src/` emits as `AUDIT_EVENTS.X`, apart from the catalogue itself. */
function serverWrittenKinds(): Set<string> {
  const src = join(FUNCTIONS, 'src');
  const files = walk(src, (p) => p.endsWith('.ts') && !p.endsWith('.test.ts')).filter(
    (p) => relative(src, p) !== join('lib', 'auditEvents.ts'),
  );
  const kinds = new Set<string>();
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/AUDIT_EVENTS\.([A-Z][A-Z0-9_]*)/g)) kinds.add(m[1]);
  }
  return kinds;
}

describe('#2162 the server-only list matches the server writers', () => {
  const written = serverWrittenKinds();

  it('the scan sees the writers', () => {
    expect(written.size).toBeGreaterThan(100);
    expect(written.has('NOTIFICATION_DISPATCHED')).toBe(true);
    expect(written.has('BILLING_INVOICE_PAID')).toBe(true);
  });

  it('every kind a server writer emits is on the list', () => {
    // A failure here names a new server writer's kind. Add it to
    // SERVER_ONLY_AUDIT_EVENTS in src/lib/auditEvents.ts. If an admin client
    // also writes the same kind for the same act, one of the two lines is a
    // duplicate: keep the server's.
    expect([...written].filter((k) => !SERVER_ONLY_AUDIT_EVENTS.has(k)).sort()).toEqual([]);
  });

  it('every kind on the list still has a server writer', () => {
    expect([...SERVER_ONLY_AUDIT_EVENTS].filter((k) => !written.has(k)).sort()).toEqual([]);
  });

  it('every kind on the list is a declared key', () => {
    const declared = new Set<string>(Object.values(AUDIT_EVENTS));
    expect([...SERVER_ONLY_AUDIT_EVENTS].filter((k) => !declared.has(k))).toEqual([]);
  });

  it('keys declared ahead of a server writer stay open', () => {
    for (const k of ['VISIT_ARRIVED', 'UPDATE_KINFOLK', 'CONTENT_KINTALE_SENT', 'NOTIFICATION_NOT_SENT']) {
      expect(isServerOnlyAuditEvent(k)).toBe(false);
    }
  });

  it('matches whole keys only, never a prefix', () => {
    expect(isServerOnlyAuditEvent('AUTH_LOGIN_SUCCESS')).toBe(true);
    expect(isServerOnlyAuditEvent('AUTH_PASSWORD_CHANGED')).toBe(false);
    expect(isServerOnlyAuditEvent('AUTH_EMAIL_CHANGE_REQUESTED')).toBe(false);
    expect(isServerOnlyAuditEvent('NOTIFICATION_DISPATCHED_AGAIN')).toBe(false);
  });

  it('no line an Auntie may write is server-only', () => {
    expect([...AUNTIE_LOGGABLE_EVENTS].filter((k) => SERVER_ONLY_AUDIT_EVENTS.has(k))).toEqual([]);
  });
});

// ── What the admin clients send ────────────────────────────────────────────

/** The text between the parenthesis at `open` and its match. */
function argsFrom(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

/** A stored key: SCREAMING_SNAKE with at least one underscore, so a status ("SUCCESS") is not one. */
const KEY_LITERAL = /["']([A-Z][A-Z0-9]*_[A-Z0-9_]+)["']/g;

interface ClientScan {
  calls: number;
  kinds: Set<string>;
}

function scanClient(files: string[], callSite: RegExp): ClientScan {
  const kinds = new Set<string>();
  let calls = 0;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(callSite)) {
      calls += 1;
      const open = (m.index ?? 0) + m[0].length - 1;
      for (const k of argsFrom(text, open).matchAll(KEY_LITERAL)) kinds.add(k[1]);
    }
  }
  return { calls, kinds };
}

const isTestPath = (p: string) => /[/\\](test|androidTest|commonTest|jvmTest)[/\\]/.test(p) || /\.test\.tsx?$/.test(p);

/** Admin web: `logActivity({ actionType: '...' })`, and the visit taps' `VISIT_${action}`. */
function scanAdminWeb(): ClientScan {
  const src = join(REPO, 'auntieos-admin', 'src');
  const files = walk(src, (p) => /\.tsx?$/.test(p) && !isTestPath(p));
  const scan = scanClient(files, /(?<![\w"'`])logActivity\(/g);
  const lifecycle = readFileSync(join(src, 'api', 'sessionsWrite.ts'), 'utf8');
  const union = /export type VisitLifecycleAction = ([^;]+);/.exec(lifecycle)?.[1] ?? '';
  for (const m of union.matchAll(/'([A-Z_]+)'/g)) scan.kinds.add(`VISIT_${m[1]}`);
  return scan;
}

/**
 * Android admin: `AuditLog.fire(...)`, `AuditLog.fireSync(...)`, and every
 * `logActivity(ActivityLogEntry(...))`, a receiver's or the repository's own.
 */
function scanAndroid(): ClientScan {
  const src = join(REPO, 'auntieos-admin', 'android', 'app', 'src', 'main');
  const files = walk(src, (p) => p.endsWith('.kt') && !isTestPath(p));
  return scanClient(files, /(?:AuditLog\.fire|AuditLog\.fireSync|(?<![\w"'`])logActivity)\(/g);
}

/** Desktop console: `AuditLog.fire(...)`, the booking screen's `audit(...)`, `dataSource.logActivity(...)`. */
function scanDesktop(): ClientScan {
  const src = join(REPO, 'auntieos-admin', 'web', 'composeApp', 'src');
  const files = walk(src, (p) => p.endsWith('.kt') && !isTestPath(p));
  return scanClient(files, /(?:AuditLog\.fire|(?<![\w.])audit|(?<![\w"'`])logActivity)\(/g);
}

const web = scanAdminWeb();
const android = scanAndroid();
const desktop = scanDesktop();
const clientKinds = [...new Set([...web.kinds, ...android.kinds, ...desktop.kinds])].sort();

describe('#2162 no admin client sends a server-only kind', () => {
  it('the scans see the call sites', () => {
    expect(web.calls).toBeGreaterThanOrEqual(2);
    expect(android.calls).toBeGreaterThanOrEqual(35);
    expect(desktop.calls).toBeGreaterThanOrEqual(10);
    for (const k of ['DRAFT_APPROVED', 'VISIT_ARRIVED', 'VISIT_UNDO_ARRIVAL']) expect(web.kinds).toContain(k);
    for (const k of ['RECORD_PAYMENT', 'VISIT_COMPLETED', 'SESSION_OFFICE_NOTE_ADDED', 'AUTH_PASSWORD_CHANGED']) {
      expect(android.kinds).toContain(k);
    }
    for (const k of ['GPS_START', 'APPROVE_BOOKING', 'UPDATE_SETTINGS', 'AUTH_EMAIL_CHANGE_REQUESTED']) {
      expect(desktop.kinds).toContain(k);
    }
  });

  it('admin web sends none', () => {
    expect([...web.kinds].filter(isServerOnlyAuditEvent)).toEqual([]);
  });

  it('Android admin sends none', () => {
    expect([...android.kinds].filter(isServerOnlyAuditEvent)).toEqual([]);
  });

  it('the desktop console sends none', () => {
    expect([...desktop.kinds].filter(isServerOnlyAuditEvent)).toEqual([]);
  });
});

// ── The callable ───────────────────────────────────────────────────────────

const serverOnly = [...SERVER_ONLY_AUDIT_EVENTS].sort();

describe('#2162 logActivity refuses the server-only kinds from every sign-in', () => {
  it.each(serverOnly)('refuses %s from the owner and writes nothing', async (actionType) => {
    await expect(logActivityHandler(req({ actionType }, 'owner-1', OWNER))).rejects.toMatchObject({
      code: 'permission-denied',
      message: SERVER_ONLY_EVENT_REFUSAL,
    });
    expect(mocks.writeAuditEntryMock).not.toHaveBeenCalled();
  });

  it.each(serverOnly)('refuses %s from an Auntie and writes nothing', async (actionType) => {
    await expect(logActivityHandler(req({ actionType }, 'auntie-1', AUNTIE))).rejects.toMatchObject({
      code: 'permission-denied',
      message: SERVER_ONLY_EVENT_REFUSAL,
    });
    expect(mocks.writeAuditEntryMock).not.toHaveBeenCalled();
  });

  it('refuses one from an account carrying both claims', async () => {
    await expect(
      logActivityHandler(req({ actionType: 'NOTIFICATION_RECEIVED' }, 'both-1', BOTH)),
    ).rejects.toMatchObject({ code: 'permission-denied', message: SERVER_ONLY_EVENT_REFUSAL });
    expect(mocks.writeAuditEntryMock).not.toHaveBeenCalled();
  });

  it('refuses before it reads anything', async () => {
    await expect(
      logActivityHandler(req({ actionType: 'BILLING_INVOICE_PAID' }, 'owner-1', OWNER)),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(mocks.dbFn).not.toHaveBeenCalled();
  });

  it('the sentence reaches the caller through the admin gate unchanged', async () => {
    const wrapped = wrapAdminCallable('logActivity', logActivityHandler);
    await expect(
      wrapped(req({ actionType: 'NOTIFICATION_DISPATCHED' }, 'owner-1', OWNER)),
    ).rejects.toMatchObject({ code: 'permission-denied', message: SERVER_ONLY_EVENT_REFUSAL });
    // What the gate does with any refused call, and all it does: one warn-level
    // failure line naming the function and the code, and no Sentry event.
    expect(mocks.writeAuditEntryMock).toHaveBeenCalledOnce();
    expect(mocks.writeAuditEntryMock.mock.calls[0][0]).toMatchObject({
      event: 'ERROR_FUNCTION_FAILURE',
      status: 'FAILURE',
      severity: 'warn',
      payload: expect.objectContaining({ function: 'logActivity', code: 'permission-denied' }),
    });
    expect(sentry.captureFunctionError).not.toHaveBeenCalled();
  });

  it('the sentence is plain: no key, no function name, no em dash', () => {
    expect(SERVER_ONLY_EVENT_REFUSAL).not.toMatch(/[A-Z]{2,}_|logActivity|activity_log|callable|server|—/i);
    expect(SERVER_ONLY_EVENT_REFUSAL).toMatch(/^[A-Z].*\.$/);
  });
});

describe('#2162 every other kind the owner writes still lands', () => {
  it('the client inventory is not empty', () => {
    expect(clientKinds.length).toBeGreaterThan(40);
  });

  it.each(clientKinds)('writes %s for the owner', async (actionType) => {
    await logActivityHandler(req({ actionType, description: 'line' }, 'owner-1', OWNER));
    expect(mocks.writeAuditEntryMock).toHaveBeenCalledOnce();
    expect(mocks.writeAuditEntryMock.mock.calls[0][0].event).toBe(actionType);
  });

  it('a kind nobody has used yet needs no list change', async () => {
    await logActivityHandler(req({ actionType: 'SOME_NEW_FEATURE_LINE' }, 'owner-1', OWNER));
    expect(mocks.writeAuditEntryMock.mock.calls[0][0].event).toBe('SOME_NEW_FEATURE_LINE');
  });

  it('an Auntie still writes her own lines', async () => {
    await logActivityHandler(req({ actionType: 'VISIT_ARRIVED' }, 'auntie-1', AUNTIE));
    expect(mocks.writeAuditEntryMock.mock.calls[0][0].event).toBe('VISIT_ARRIVED');
  });
});
