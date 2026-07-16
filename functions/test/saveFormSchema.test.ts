import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: vi.fn(),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({
  writeAuditEntry: vi.fn().mockResolvedValue('audit-1'),
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: { serverTimestamp: () => '__TS__', delete: () => '__DEL__' },
  };
});

import { saveFormSchemaHandler } from '../src/admin/saveFormSchema';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';
import { logEvent } from '../src/lib/logger';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (logEvent as any).mockClear();
  (writeAuditEntry as any).mockClear();
});

const NO_AUTH = Symbol('no-auth');

function req(data: unknown, uid: string | typeof NO_AUTH = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid !== NO_AUTH
      ? ({ uid: uid as string, token: { admin: true } as any } as any)
      : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function validSchema(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tribeProfile',
    name: 'Tribe Profile',
    description: 'Editable family info',
    version: 0,
    sections: [
      {
        title: 'About',
        description: null,
        fields: [
          {
            key: 'familyName',
            label: 'Family name',
            type: 'text',
            required: true,
            helperText: null,
            placeholder: null,
            options: null,
            defaultValue: null,
            group: null,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('saveFormSchema', () => {
  it('SAD: unauthenticated rejected', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(
      saveFormSchemaHandler(req({ schema: validSchema() }, NO_AUTH)),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('SAD: missing schema arg rejected', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(saveFormSchemaHandler(req({}))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('SAD: empty sections rejected', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(
      saveFormSchemaHandler(req({ schema: validSchema({ sections: [] }) })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('SAD: missing required field key rejected', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    const broken = validSchema();
    (broken.sections[0].fields[0] as any).key = '';
    await expect(
      saveFormSchemaHandler(req({ schema: broken })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('SAD: bad type enum rejected', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    const broken = validSchema();
    (broken.sections[0].fields[0] as any).type = 'color-picker';
    await expect(
      saveFormSchemaHandler(req({ schema: broken })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('SAD: duplicate field keys within a section rejected', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    const broken = validSchema();
    broken.sections[0].fields.push({
      key: 'familyName', // dup
      label: 'Other',
      type: 'text',
      required: false,
      helperText: null,
      placeholder: null,
      options: null,
      defaultValue: null,
      group: null,
    } as any);
    await expect(
      saveFormSchemaHandler(req({ schema: broken })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('SAD: select field without options rejected', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    const broken = validSchema();
    (broken.sections[0].fields[0] as any).type = 'select';
    (broken.sections[0].fields[0] as any).options = null;
    await expect(
      saveFormSchemaHandler(req({ schema: broken })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('SAD: multiselect field with empty options array rejected', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    const broken = validSchema();
    (broken.sections[0].fields[0] as any).type = 'multiselect';
    (broken.sections[0].fields[0] as any).options = [];
    await expect(
      saveFormSchemaHandler(req({ schema: broken })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('SAD: XSS — <script> in label rejected as non-plaintext', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    const broken = validSchema();
    (broken.sections[0].fields[0] as any).label = '<script>alert(1)</script>';
    await expect(
      saveFormSchemaHandler(req({ schema: broken })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('SAD: XSS — newline-injected option rejected as non-plaintext', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    const broken = validSchema();
    (broken.sections[0].fields[0] as any).type = 'select';
    (broken.sections[0].fields[0] as any).options = ['ok', 'bad\noption'];
    await expect(
      saveFormSchemaHandler(req({ schema: broken })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('SAD: validation_failed log emitted on bad input (w/ schemaId)', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    const broken = validSchema();
    (broken.sections[0].fields[0] as any).type = 'bogus';
    await expect(
      saveFormSchemaHandler(req({ schema: broken })),
    ).rejects.toThrow();
    const calls = (logEvent as any).mock.calls.map((c: any[]) => c[0]);
    const validationLog = calls.find(
      (c: any) => c.event === 'portal.formSchema.validation_failed',
    );
    expect(validationLog).toBeDefined();
    expect(validationLog.severity).toBe('warn');
    expect(validationLog.extra.schemaId).toBe('tribeProfile');
    expect(validationLog.extra.validationErrors.length).toBeGreaterThan(0);
  });

  it('HAPPY: creates new schema with version=1 + createdAt + createdBy', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveFormSchemaHandler(req({ schema: validSchema() }));
    expect(res).toEqual({ ok: true, id: 'tribeProfile', version: 1 });
    const write = ctx.writes.find((w) => w.path === 'formSchemas/tribeProfile');
    expect(write).toBeDefined();
    expect(write?.data.version).toBe(1);
    expect(write?.data.id).toBe('tribeProfile');
    expect(write?.data.name).toBe('Tribe Profile');
    expect(write?.data.createdBy).toBe('admin1');
    expect(write?.data.updatedBy).toBe('admin1');
    expect((write?.data.sections as any[])[0].fields[0].key).toBe('familyName');
  });

  it('HAPPY: persists appliesTo when provided (placement target for 1C)', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await saveFormSchemaHandler(req({ schema: validSchema({ id: 'kinCustom', appliesTo: 'KIN' }) }));
    const write = ctx.writes.find((w) => w.path === 'formSchemas/kinCustom');
    expect(write?.data.appliesTo).toBe('KIN');
  });

  it('HAPPY: persists KINTALE placement (Phase 14 composer target)', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await saveFormSchemaHandler(req({ schema: validSchema({ id: 'taleCustom', appliesTo: 'KINTALE' }) }));
    const write = ctx.writes.find((w) => w.path === 'formSchemas/taleCustom');
    expect(write?.data.appliesTo).toBe('KINTALE');
  });

  it('HAPPY: appliesTo defaults to NONE when omitted (global schema)', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await saveFormSchemaHandler(req({ schema: validSchema() }));
    const write = ctx.writes.find((w) => w.path === 'formSchemas/tribeProfile');
    expect(write?.data.appliesTo).toBe('NONE');
  });

  it('SAD: bad appliesTo enum rejected', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(
      saveFormSchemaHandler(req({ schema: validSchema({ appliesTo: 'PLANET' }) })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('HAPPY: bumps version on update + no createdAt overwrite', async () => {
    const ctx = buildDbMock({
      docs: {
        'formSchemas/tribeProfile': {
          id: 'tribeProfile',
          name: 'old name',
          version: 3,
          sections: [],
          createdAt: 'preserved',
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveFormSchemaHandler(
      req({ schema: validSchema({ name: 'Updated', version: 99 }) }), // client version ignored
    );
    expect(res.version).toBe(4); // bumped from 3
    const write = ctx.writes.find((w) => w.path === 'formSchemas/tribeProfile');
    expect(write?.data.version).toBe(4);
    expect(write?.data.name).toBe('Updated');
    expect(write?.data.createdBy).toBeUndefined(); // not re-stamped
    expect(write?.data.updatedBy).toBe('admin1');
  });

  it('HAPPY: defaults version to 0 on update when current doc has no version field', async () => {
    const ctx = buildDbMock({
      docs: {
        'formSchemas/tribeProfile': { id: 'tribeProfile', name: 'x', sections: [] },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveFormSchemaHandler(req({ schema: validSchema() }));
    expect(res.version).toBe(1); // 0 + 1
  });

  it('HAPPY: writes SAVE_FORM_SCHEMA audit entry with version/section/field counts', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const schema = validSchema({
      sections: [
        {
          title: 'A',
          description: null,
          fields: [
            { key: 'k1', label: 'L1', type: 'text', required: true, helperText: null, placeholder: null, options: null, defaultValue: null, group: null },
            { key: 'k2', label: 'L2', type: 'email', required: false, helperText: null, placeholder: null, options: null, defaultValue: null, group: null },
          ],
        },
        {
          title: 'B',
          description: null,
          fields: [
            { key: 'k3', label: 'L3', type: 'checkbox', required: false, helperText: null, placeholder: null, options: null, defaultValue: null, group: null },
          ],
        },
      ],
    });
    await saveFormSchemaHandler(req({ schema }));
    const auditCalls = (writeAuditEntry as any).mock.calls.map((c: any[]) => c[0]);
    const entry = auditCalls.find(
      (a: any) => a.event === 'SAVE_FORM_SCHEMA',
    );
    expect(entry).toBeDefined();
    expect(entry.actorUid).toBe('admin1');
    expect(entry.actorRole).toBe('AUNTIE');
    expect(entry.payload.schemaId).toBe('tribeProfile');
    expect(entry.payload.version).toBe(1);
    expect(entry.payload.sectionsCount).toBe(2);
    expect(entry.payload.fieldsCount).toBe(3);
    expect(entry.payload.isCreate).toBe(true);
  });

  it('HAPPY: emits portal.formSchema.saved log on success', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await saveFormSchemaHandler(req({ schema: validSchema() }));
    const calls = (logEvent as any).mock.calls.map((c: any[]) => c[0]);
    const saved = calls.find((c: any) => c.event === 'portal.formSchema.saved');
    expect(saved).toBeDefined();
    expect(saved.severity).toBe('info');
    expect(saved.extra.schemaId).toBe('tribeProfile');
    expect(saved.extra.version).toBe(1);
    expect(saved.extra.sectionCount).toBe(1);
    expect(saved.extra.fieldCount).toBe(1);
  });

  it('HAPPY: select field with non-empty options accepted', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const schema = validSchema();
    (schema.sections[0].fields[0] as any).type = 'select';
    (schema.sections[0].fields[0] as any).options = ['A', 'B', 'C'];
    const res = await saveFormSchemaHandler(req({ schema }));
    expect(res.ok).toBe(true);
    const write = ctx.writes.find((w) => w.path === 'formSchemas/tribeProfile');
    expect((write?.data.sections as any[])[0].fields[0].options).toEqual(['A', 'B', 'C']);
  });

  it('HAPPY: concurrent saves get distinct version numbers (no silent clobber)', async () => {
    // Custom db w/ a transaction shim that simulates serialized atomic
    // execution: read current state, run callback fully, then commit to
    // shared store before next transaction starts. Verifies that two
    // overlapping save() calls observe v1 + v2, not v1 + v1.
    const state: { current: Record<string, unknown> | null } = { current: null };
    const writes: Array<{ data: Record<string, unknown> }> = [];

    let txnTail: Promise<unknown> = Promise.resolve();
    const customDb: any = {
      collection: () => ({
        doc: () => makeRef(),
      }),
      runTransaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
        // Serialize transactions: each waits for the previous to commit.
        const prev = txnTail;
        let release: () => void = () => {};
        txnTail = new Promise<void>((r) => { release = r; });
        await prev;
        try {
          const tx = {
            get: async (_ref: any) => ({
              exists: state.current != null,
              data: () => state.current ?? undefined,
            }),
            set: (_ref: any, data: Record<string, unknown>) => {
              state.current = { ...(state.current ?? {}), ...data };
              writes.push({ data });
            },
            update: () => {},
            delete: () => { state.current = null; },
            create: (_ref: any, data: Record<string, unknown>) => {
              state.current = data;
              writes.push({ data });
            },
          };
          return await fn(tx);
        } finally {
          release();
        }
      },
    };
    function makeRef() {
      return { id: 'tribeProfile', path: 'formSchemas/tribeProfile' };
    }
    mocks.dbFn.mockReturnValue(customDb);

    const [res1, res2] = await Promise.all([
      saveFormSchemaHandler(req({ schema: validSchema() })),
      saveFormSchemaHandler(req({ schema: validSchema({ name: 'Second' }) })),
    ]);

    const versions = [res1.version, res2.version].sort();
    expect(versions).toEqual([1, 2]); // distinct — no silent clobber
    expect(writes).toHaveLength(2);
    const writtenVersions = writes.map((w) => w.data.version).sort();
    expect(writtenVersions).toEqual([1, 2]);
  });
});
