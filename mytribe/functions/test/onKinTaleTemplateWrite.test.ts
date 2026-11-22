import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #1892: creating, archiving, restoring and deleting a KinTale template left no
 * Activity Log line. The admin clients write `kintale_templates` directly, so
 * the line comes from the committed write (`onKinTaleTemplateWrite`).
 */

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  authFn: vi.fn(),
  logEventFn: vi.fn(),
  writeAuditFn: vi.fn(),
  lines: [] as Array<Record<string, any>>,
  ids: new Set<string>(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: mocks.authFn, getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditFn }));

import {
  onKinTaleTemplateWriteHandler,
  templateWriterUidOf,
  type KinTaleTemplateWriteEvent,
} from '../src/triggers/onKinTaleTemplateWrite';
import {
  kinTaleTemplateChangeOf,
  kinTaleTemplateWords,
  TEMPLATE_NAME_MAX,
} from '../src/lib/kinTaleTemplateAudit';
import { isServerOnlyAuditEvent } from '../src/lib/auditEvents';

const TEMPLATE = {
  name: 'Dog walk',
  isActive: true,
  isDefault: false,
  archived: false,
  archivedAt: '',
  checklistItems: [{ key: 'walk', text: 'Long walk', scope: 'PER_PET', order: 0 }],
  createdAt: '2026-11-11T18:13:00.000Z',
  updatedAt: '2026-11-11T18:13:00.000Z',
};

function snap(data: Record<string, unknown> | undefined) {
  return { exists: data !== undefined, data: () => data };
}

function event(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  extra: Partial<KinTaleTemplateWriteEvent> = {},
): KinTaleTemplateWriteEvent {
  return {
    id: 'evt-1',
    params: { templateId: 'tpl-1' },
    authType: 'unknown',
    authId: 'owner1',
    data: { before: snap(before), after: snap(after) },
    ...extra,
  } as unknown as KinTaleTemplateWriteEvent;
}

beforeEach(() => {
  process.env.AUNTIE_OPERATOR_UIDS = '';
  mocks.lines.length = 0;
  mocks.ids.clear();
  mocks.logEventFn.mockReset();
  mocks.writeAuditFn.mockReset().mockImplementation(async (args: Record<string, any>) => {
    if (typeof args.docId === 'string') {
      if (mocks.ids.has(args.docId)) return args.docId;
      mocks.ids.add(args.docId);
    }
    mocks.lines.push(args);
    return args.docId ?? `auto-${mocks.lines.length}`;
  });
  mocks.authFn.mockReset().mockReturnValue({
    getUser: vi.fn(async (uid: string) => {
      if (uid === 'owner1') return { uid, customClaims: { admin: true } };
      if (uid === 'auntie1') return { uid, customClaims: { staffRole: 'auntie' } };
      const err = new Error('no user') as Error & { code: string };
      err.code = 'auth/user-not-found';
      throw err;
    }),
  });
  mocks.dbFn.mockReset().mockReturnValue(buildDbMock({ docs: {} }).db);
});

describe('#1892 each template change leaves one line in words', () => {
  it('create', async () => {
    await onKinTaleTemplateWriteHandler(event(undefined, TEMPLATE));
    expect(mocks.lines).toHaveLength(1);
    const line = mocks.lines[0]!;
    expect(line.event).toBe('KINTALE_TEMPLATE_CREATED');
    expect(line.description).toBe('Created the KinTale template "Dog walk"');
    expect(line.actorUid).toBe('owner1');
    expect(line.actorRole).toBe('AUNTIE');
    expect(line.targetUid).toBe('tpl-1');
    expect(line.targetCollection).toBe('kintale_templates');
    expect(line.payload).toEqual({ templateId: 'tpl-1', change: 'created', admin: true, staffRole: null });
    expect(line.status).toBe('SUCCESS');
  });

  it('archive, restore, archive again, delete: the walk\'s five steps, five lines', async () => {
    const archived = { ...TEMPLATE, archived: true, archivedAt: 'x', updatedAt: 'x' };
    const restored = { ...TEMPLATE, archived: false, archivedAt: '', updatedAt: 'y' };
    await onKinTaleTemplateWriteHandler(event(undefined, TEMPLATE, { id: 'e1' }));
    await onKinTaleTemplateWriteHandler(event(TEMPLATE, archived, { id: 'e2' }));
    await onKinTaleTemplateWriteHandler(event(archived, restored, { id: 'e3' }));
    await onKinTaleTemplateWriteHandler(event(restored, archived, { id: 'e4' }));
    await onKinTaleTemplateWriteHandler(event(archived, undefined, { id: 'e5' }));
    expect(mocks.lines.map((l) => l.event)).toEqual([
      'KINTALE_TEMPLATE_CREATED',
      'KINTALE_TEMPLATE_ARCHIVED',
      'KINTALE_TEMPLATE_RESTORED',
      'KINTALE_TEMPLATE_ARCHIVED',
      'KINTALE_TEMPLATE_DELETED',
    ]);
    expect(mocks.lines.map((l) => l.description)).toEqual([
      'Created the KinTale template "Dog walk"',
      'Archived the KinTale template "Dog walk"',
      'Restored the KinTale template "Dog walk"',
      'Archived the KinTale template "Dog walk"',
      'Deleted the KinTale template "Dog walk"',
    ]);
    expect(mocks.lines[4]!.severity).toBe('warn');
  });

  it('an editor save', async () => {
    await onKinTaleTemplateWriteHandler(event(TEMPLATE, { ...TEMPLATE, name: 'Dog walk, long', updatedAt: 'z' }));
    expect(mocks.lines[0]!.event).toBe('KINTALE_TEMPLATE_SAVED');
    expect(mocks.lines[0]!.description).toBe('Saved the KinTale template "Dog walk, long"');
  });

  it('a checklist edit counts, whatever key order the client wrote', async () => {
    const after = { ...TEMPLATE, checklistItems: [{ order: 0, scope: 'PER_PET', text: 'Short walk', key: 'walk' }] };
    expect(kinTaleTemplateChangeOf(TEMPLATE, after)).toBe('saved');
    const reordered = { ...TEMPLATE, checklistItems: [{ order: 0, scope: 'PER_PET', text: 'Long walk', key: 'walk' }] };
    expect(kinTaleTemplateChangeOf(TEMPLATE, reordered)).toBeNull();
  });

  it("names an Auntie's change as hers", async () => {
    await onKinTaleTemplateWriteHandler(event(undefined, TEMPLATE, { authId: 'auntie1' }));
    expect(mocks.lines[0]!.actorUid).toBe('auntie1');
    expect(mocks.lines[0]!.payload).toMatchObject({ admin: false, staffRole: 'auntie' });
  });

  it('a template with no name', async () => {
    await onKinTaleTemplateWriteHandler(event(undefined, { ...TEMPLATE, name: '  ' }));
    expect(mocks.lines[0]!.description).toBe('Created a KinTale template');
  });

  it('a very long name is cut', () => {
    const words = kinTaleTemplateWords('saved', 'x'.repeat(300));
    expect(words.length).toBeLessThan(TEMPLATE_NAME_MAX + 40);
    expect(words.endsWith('..."')).toBe(true);
  });
});

describe('#1892 writes that are not a line', () => {
  it('a stamp-only write', () => {
    expect(kinTaleTemplateChangeOf(TEMPLATE, { ...TEMPLATE, updatedAt: 'later' })).toBeNull();
  });

  it('the default flag leaving a sibling (web batch, Android and desktop per-sibling writes)', () => {
    const wasDefault = { ...TEMPLATE, isDefault: true };
    expect(kinTaleTemplateChangeOf(wasDefault, { ...wasDefault, isDefault: false })).toBeNull();
    expect(kinTaleTemplateChangeOf(wasDefault, { ...wasDefault, isDefault: false, updatedAt: 'z' })).toBeNull();
  });

  it('taking the default is a save', () => {
    expect(kinTaleTemplateChangeOf(TEMPLATE, { ...TEMPLATE, isDefault: true, updatedAt: 'z' })).toBe('saved');
  });

  it('a restore that also gives up the default reads as a restore', () => {
    const archived = { ...TEMPLATE, isDefault: true, archived: true };
    expect(kinTaleTemplateChangeOf(archived, { ...TEMPLATE, isDefault: false })).toBe('restored');
  });

  it('nothing before and nothing after', async () => {
    await onKinTaleTemplateWriteHandler(event(undefined, undefined));
    expect(mocks.writeAuditFn).not.toHaveBeenCalled();
  });

  it('a redelivered event writes no second line', async () => {
    await onKinTaleTemplateWriteHandler(event(undefined, TEMPLATE, { id: 'same' }));
    await onKinTaleTemplateWriteHandler(event(undefined, TEMPLATE, { id: 'same' }));
    expect(mocks.lines).toHaveLength(1);
  });
});

describe('#1892 who the line names', () => {
  it('a server write is the system\'s', async () => {
    await onKinTaleTemplateWriteHandler(event(undefined, TEMPLATE, { authType: 'service_account', authId: 'sa@x' }));
    expect(mocks.lines[0]!.actorRole).toBe('SYSTEM');
    expect(mocks.lines[0]!.actorUid).toBeUndefined();
  });

  it('an id Auth has no user for is not a person', async () => {
    await onKinTaleTemplateWriteHandler(event(undefined, TEMPLATE, { authId: 'not-a-signed-in-user' }));
    expect(mocks.lines[0]!.actorRole).toBe('SYSTEM');
  });

  it('claims that cannot be read still name the writer', async () => {
    mocks.authFn.mockReturnValue({ getUser: vi.fn().mockRejectedValue(new Error('unavailable')) });
    await onKinTaleTemplateWriteHandler(event(undefined, TEMPLATE, { authId: 'owner1' }));
    expect(mocks.lines[0]!.actorUid).toBe('owner1');
    expect(mocks.lines[0]!.actorRole).toBe('AUNTIE');
  });

  it('templateWriterUidOf', () => {
    expect(templateWriterUidOf({ authType: 'unknown', authId: 'u1' })).toBe('u1');
    expect(templateWriterUidOf({ authType: 'service_account', authId: 'sa' })).toBeNull();
    expect(templateWriterUidOf({ authType: 'system' })).toBeNull();
    expect(templateWriterUidOf({ authType: 'unknown', authId: ' ' })).toBeNull();
  });
});

describe('#1892 a failed line write', () => {
  it('is logged and thrown, so the trigger retries and Sentry sees it', async () => {
    mocks.writeAuditFn.mockRejectedValue(new Error('chain busy'));
    await expect(onKinTaleTemplateWriteHandler(event(undefined, TEMPLATE))).rejects.toThrow('chain busy');
    expect(mocks.logEventFn).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error', event: 'audit.write.failed' }),
    );
  });
});

describe('#1892 the lines are the server\'s', () => {
  it.each([
    'KINTALE_TEMPLATE_CREATED',
    'KINTALE_TEMPLATE_SAVED',
    'KINTALE_TEMPLATE_ARCHIVED',
    'KINTALE_TEMPLATE_RESTORED',
    'KINTALE_TEMPLATE_DELETED',
  ])('%s cannot be written through logActivity', (k) => {
    expect(isServerOnlyAuditEvent(k)).toBe(true);
  });
});
