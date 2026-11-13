import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({
  writeAuditEntryMock: vi.fn(),
  dbFn: vi.fn(),
  logEventMock: vi.fn(),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryMock }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventMock }));
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
  mocks.logEventMock.mockReset();
  sentry.captureFunctionError.mockReset();
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
    for (const k of ['VISIT_COMPLETED', 'UPDATE_KINFOLK', 'CONTENT_KINTALE_SENT', 'NOTIFICATION_NOT_SENT']) {
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
  /** Files holding a call whose kind is not a literal in its own arguments (a wrapper, or a kind worked out elsewhere). */
  indirect: Set<string>;
}

function scanClient(files: string[], callSite: RegExp): ClientScan {
  const kinds = new Set<string>();
  const indirect = new Set<string>();
  let calls = 0;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(callSite)) {
      calls += 1;
      const open = (m.index ?? 0) + m[0].length - 1;
      const found = [...argsFrom(text, open).matchAll(KEY_LITERAL)];
      for (const k of found) kinds.add(k[1]);
      if (found.length === 0) indirect.add(relative(REPO, f).split('\\').join('/'));
    }
  }
  return { calls, kinds, indirect };
}

const isTestPath = (p: string) => /[/\\](test|androidTest|commonTest|jvmTest)[/\\]/.test(p) || /\.test\.tsx?$/.test(p);

/**
 * Admin web: `logActivity({ actionType: '...' })`. The visit taps' `VISIT_${action}`
 * line left the web in #2037: the server writes it from the committed step.
 */
function scanAdminWeb(): ClientScan {
  const src = join(REPO, 'auntieos-admin', 'src');
  const files = walk(src, (p) => /\.tsx?$/.test(p) && !isTestPath(p));
  return scanClient(files, /(?<![\w"'`])logActivity\(/g);
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

/**
 * Desktop console: `AuditLog.fire(...)`, the booking screen's `audit(...)`,
 * `dataSource.logActivity(...)`, and the household edit's kind, which
 * `clientHouseholdAuditAction` works out in `KinfolkSave.kt`.
 */
function scanDesktop(): ClientScan {
  const src = join(REPO, 'auntieos-admin', 'web', 'composeApp', 'src');
  const files = walk(src, (p) => p.endsWith('.kt') && !isTestPath(p));
  const scan = scanClient(files, /(?:AuditLog\.fire|(?<![\w.])audit|(?<![\w"'`])logActivity)\(/g);
  const save = readFileSync(
    join(src, 'commonMain', 'kotlin', 'com', 'tribetails', 'auntieos', 'web', 'screens', 'directory', 'KinfolkSave.kt'),
    'utf8',
  );
  const household = /fun clientHouseholdAuditAction\([^)]*\)[^\n]*/.exec(save)?.[0] ?? '';
  for (const m of household.matchAll(KEY_LITERAL)) scan.kinds.add(m[1]);
  return scan;
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
    expect(web.kinds).toContain('DRAFT_APPROVED');
    for (const k of ['RECORD_PAYMENT', 'VISIT_COMPLETED', 'SESSION_OFFICE_NOTE_ADDED', 'AUTH_PASSWORD_CHANGED']) {
      expect(android.kinds).toContain(k);
    }
    for (const k of ['GPS_START', 'APPROVE_BOOKING', 'UPDATE_SETTINGS', 'AUTH_EMAIL_CHANGE_REQUESTED', 'UPDATE_KINFOLK']) {
      expect(desktop.kinds).toContain(k);
    }
  });

  it('every call whose kind is not written in its own arguments is a known one', () => {
    // The scans read the kind from the call's own arguments. These files hold
    // a call that passes it on instead: the wrappers themselves, the data
    // sources' pass-through overrides, the booking screen's `audit` helper,
    // the draft approval's `audit` step (its caller's lambda is scanned), and
    // the kind worked out elsewhere (`clientHouseholdAuditAction` on desktop,
    // read above). A new file
    // here is a new indirect sender: read where its kind comes from, make the
    // scan see it, then add the file.
    const D = 'auntieos-admin/web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web';
    expect([...web.indirect].sort()).toEqual(['auntieos-admin/src/api/activityLog.ts']);
    expect([...android.indirect].sort()).toEqual([
      'auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/admin/AuditLog.kt',
      'auntieos-admin/android/app/src/main/java/com/tribetails/auntieos/data/repository/AuntieRepository.kt',
    ]);
    expect([...desktop.indirect].sort()).toEqual(
      [
        `${D}/data/AuditLog.kt`,
        `${D}/data/AuntieDataSource.kt`,
        `${D}/data/FirestoreClient.kt`,
        `${D}/screens/booking/BookingScreen.kt`,
        `${D}/screens/booking/BookingViewModel.kt`,
        `${D}/screens/communicate/ApproveSend.kt`,
        `${D}/screens/directory/KinfolkEditScreen.kt`,
        `${D}/screens/settings/SettingsScreen.kt`,
      ].sort(),
    );
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

  const failureLine = {
    event: 'ERROR_FUNCTION_FAILURE',
    status: 'FAILURE',
    severity: 'warn',
    payload: expect.objectContaining({ function: 'logActivity', code: 'permission-denied' }),
  };
  const wrapped = wrapAdminCallable('logActivity', logActivityHandler);

  it('from the owner, the sentence reaches the caller through the admin gate and no failure line is written', async () => {
    await expect(
      wrapped(req({ actionType: 'NOTIFICATION_DISPATCHED' }, 'owner-1', OWNER)),
    ).rejects.toMatchObject({ code: 'permission-denied', message: SERVER_ONLY_EVENT_REFUSAL });
    // An older build's copy of a line the server already wrote is not a
    // failure: nothing for the daily error digest, no Sentry event. The
    // refusal is still logged at warn, naming the kind.
    expect(mocks.writeAuditEntryMock).not.toHaveBeenCalled();
    expect(sentry.captureFunctionError).not.toHaveBeenCalled();
    expect(mocks.logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'warn',
        event: 'logActivity.serverOnlyRefused',
        uid: 'owner-1',
        extra: { actionType: 'NOTIFICATION_DISPATCHED', caretaker: false },
      }),
    );
    expect(mocks.logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'warn', event: 'logActivity.failure', errorCode: 'permission-denied' }),
    );
  });

  it.each(['SAVE_FORM_SCHEMA', 'DELETE_FORM_SCHEMA', 'RESCHEDULE_BOOKING', 'APPROVE_BOOKING_SERIES', 'CANCEL_BOOKING_SERIES'])(
    'an older build of the owner\'s apps sending %s gets the refusal and adds nothing to the digest',
    async (actionType) => {
      await expect(wrapped(req({ actionType }, 'owner-1', OWNER))).rejects.toMatchObject({
        code: 'permission-denied',
        message: SERVER_ONLY_EVENT_REFUSAL,
      });
      expect(mocks.writeAuditEntryMock).not.toHaveBeenCalled();
    },
  );

  it('from an Auntie, the same refusal still writes the failure line', async () => {
    await expect(
      wrapped(req({ actionType: 'NOTIFICATION_DISPATCHED' }, 'auntie-1', AUNTIE)),
    ).rejects.toMatchObject({ code: 'permission-denied', message: SERVER_ONLY_EVENT_REFUSAL });
    expect(mocks.writeAuditEntryMock).toHaveBeenCalledOnce();
    expect(mocks.writeAuditEntryMock.mock.calls[0][0]).toMatchObject(failureLine);
    expect(mocks.logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'logActivity.serverOnlyRefused', extra: { actionType: 'NOTIFICATION_DISPATCHED', caretaker: true } }),
    );
  });

  it('from an account carrying both claims, the refusal still writes the failure line', async () => {
    await expect(wrapped(req({ actionType: 'NOTIFICATION_DISPATCHED' }, 'both-1', BOTH))).rejects.toMatchObject({
      message: SERVER_ONLY_EVENT_REFUSAL,
    });
    expect(mocks.writeAuditEntryMock).toHaveBeenCalledOnce();
    expect(mocks.writeAuditEntryMock.mock.calls[0][0]).toMatchObject(failureLine);
  });

  it('an Auntie refused a line that is not hers still writes the failure line', async () => {
    expect(AUNTIE_LOGGABLE_EVENTS.has('RECORD_PAYMENT')).toBe(false);
    expect(isServerOnlyAuditEvent('RECORD_PAYMENT')).toBe(false);
    await expect(wrapped(req({ actionType: 'RECORD_PAYMENT' }, 'auntie-1', AUNTIE))).rejects.toMatchObject({
      code: 'permission-denied',
      message: 'This is not available to caretaker accounts.',
    });
    expect(mocks.writeAuditEntryMock).toHaveBeenCalledOnce();
    expect(mocks.writeAuditEntryMock.mock.calls[0][0]).toMatchObject(failureLine);
  });

  it('a household sign-in refused at the admin gate still writes the failure line', async () => {
    await expect(wrapped(req({ actionType: 'NOTIFICATION_DISPATCHED' }, 'household-1', {}))).rejects.toMatchObject({
      code: 'permission-denied',
      message: 'Admin claim required.',
    });
    expect(mocks.writeAuditEntryMock).toHaveBeenCalledOnce();
    expect(mocks.writeAuditEntryMock.mock.calls[0][0]).toMatchObject(failureLine);
    expect(mocks.logEventMock).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'logActivity.serverOnlyRefused' }));
  });

  it('the sentence is plain: no key, no function name, no em dash', () => {
    expect(SERVER_ONLY_EVENT_REFUSAL).not.toMatch(/[A-Z]{2,}_|logActivity|activity_log|callable|server|—/i);
    expect(SERVER_ONLY_EVENT_REFUSAL).toMatch(/^[A-Z].*\.$/);
  });
});

describe('#2162 every other kind the owner writes still lands', () => {
  it('the client inventory is not empty', () => {
    // #2037 took the four clock steps off the clients (the server writes them).
    expect(clientKinds.length).toBeGreaterThan(35);
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
    await logActivityHandler(req({ actionType: 'VISIT_COMPLETED' }, 'auntie-1', AUNTIE));
    expect(mocks.writeAuditEntryMock.mock.calls[0][0].event).toBe('VISIT_COMPLETED');
  });
});
