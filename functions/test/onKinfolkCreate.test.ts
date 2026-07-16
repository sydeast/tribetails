import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  logEvent: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEvent.mockReset();
});

import { onKinfolkCreate, onKinfolkCreateHandler } from '../src/triggers/onKinfolkCreate';
import {
  buildFamilyProvisionDoc,
  deriveKinfolkDisplayName,
  isAlreadyExistsError,
  planFamilyProvision,
  PROVISIONED_BY_ON_KINFOLK_CREATE,
} from '../src/triggers/familyProvision';

/** Realistic AuntieOS kinfolk doc (shape per seed_test_sandbox KinfolkDoc). */
function kinfolkDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: '6',
    businessName: '',
    displayName: '',
    firstName: 'Nora',
    lastName: 'Halbrook',
    email: 'nora@example.com',
    phoneNumber: '+15550100199',
    status: 'active',
    ...overrides,
  };
}

/** Minimal db mock with a create() that can be told the doc already exists. */
function buildCreateDbMock(opts: { alreadyExists?: boolean } = {}) {
  const creates: Array<{ path: string; data: Record<string, unknown> }> = [];
  const db = {
    doc: (path: string) => ({
      create: vi.fn(async (data: Record<string, unknown>) => {
        if (opts.alreadyExists) {
          const err = new Error('6 ALREADY_EXISTS: entity already exists') as Error & {
            code: number;
          };
          err.code = 6;
          throw err;
        }
        creates.push({ path, data });
      }),
    }),
  };
  return { db, creates };
}

function makeEvent(kinfolkId: string, data: Record<string, unknown> | undefined) {
  return { params: { kinfolkId }, data: data ? { data: () => data } : undefined };
}

describe('onKinfolkCreate: exports', () => {
  it('exports the trigger', () => {
    expect(onKinfolkCreate).toBeDefined();
  });
});

describe('deriveKinfolkDisplayName precedence', () => {
  it('prefers the denormalized displayName', () => {
    expect(
      deriveKinfolkDisplayName('6', kinfolkDoc({ displayName: 'Halbrook Household', businessName: 'B Corp' })),
    ).toBe('Halbrook Household');
  });

  it('falls back to businessName when displayName is blank', () => {
    expect(deriveKinfolkDisplayName('6', kinfolkDoc({ displayName: '  ', businessName: 'B Corp' }))).toBe(
      'B Corp',
    );
  });

  it('falls back to firstName + lastName (inviteKinfolkToPortal compose)', () => {
    expect(deriveKinfolkDisplayName('6', kinfolkDoc())).toBe('Nora Halbrook');
    expect(deriveKinfolkDisplayName('6', kinfolkDoc({ lastName: '' }))).toBe('Nora');
  });

  it('falls back to email, then "Tribe {id}" (never empty)', () => {
    expect(
      deriveKinfolkDisplayName('6', kinfolkDoc({ firstName: '', lastName: '' })),
    ).toBe('nora@example.com');
    expect(
      deriveKinfolkDisplayName('6', kinfolkDoc({ firstName: '', lastName: '', email: ' ' })),
    ).toBe('Tribe 6');
  });
});

describe('buildFamilyProvisionDoc — inviteKinfolkToPortal envelope shape', () => {
  it('replicates the invite envelope fields plus provenance (timestamps writer-added)', () => {
    const doc = buildFamilyProvisionDoc('6', kinfolkDoc(), PROVISIONED_BY_ON_KINFOLK_CREATE);
    expect(doc).toEqual({
      displayName: 'Nora Halbrook',
      primaryUid: '',
      themeConfigRef: 'families/6/themeConfig/active',
      flags: { tribePinSet: false, tribePinChangePending: false, unverified: false },
      provisionedBy: 'onKinfolkCreate',
    });
  });
});

describe('planFamilyProvision', () => {
  it('provisions a real kinfolk', () => {
    const plan = planFamilyProvision('6', kinfolkDoc(), PROVISIONED_BY_ON_KINFOLK_CREATE);
    expect(plan.action).toBe('provision');
    if (plan.action !== 'provision') throw new Error('expected provision');
    expect(plan.familyId).toBe('6');
    expect(plan.doc.provisionedBy).toBe('onKinfolkCreate');
  });

  it('skips isTestData kinfolk', () => {
    const plan = planFamilyProvision('6', kinfolkDoc({ isTestData: true }), 'onKinfolkCreate');
    expect(plan).toEqual({ action: 'skip', reason: 'test_data' });
  });

  it('is deterministic: replanning yields an identical plan', () => {
    const a = planFamilyProvision('6', kinfolkDoc(), 'onKinfolkCreate');
    const b = planFamilyProvision('6', kinfolkDoc(), 'onKinfolkCreate');
    expect(a).toEqual(b);
  });
});

describe('isAlreadyExistsError', () => {
  it('matches gRPC code 6 and string code, nothing else', () => {
    expect(isAlreadyExistsError({ code: 6 })).toBe(true);
    expect(isAlreadyExistsError({ code: 'already-exists' })).toBe(true);
    expect(isAlreadyExistsError({ code: 5 })).toBe(false);
    expect(isAlreadyExistsError(new Error('boom'))).toBe(false);
    expect(isAlreadyExistsError(undefined)).toBe(false);
  });
});

describe('onKinfolkCreateHandler', () => {
  it('creates families/{kinfolkId} with the envelope shape + server timestamps', async () => {
    const ctx = buildCreateDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);

    await onKinfolkCreateHandler(makeEvent('6', kinfolkDoc()));

    expect(ctx.creates).toHaveLength(1);
    expect(ctx.creates[0].path).toBe('families/6');
    expect(ctx.creates[0].data).toEqual({
      displayName: 'Nora Halbrook',
      primaryUid: '',
      themeConfigRef: 'families/6/themeConfig/active',
      flags: { tribePinSet: false, tribePinChangePending: false, unverified: false },
      provisionedBy: 'onKinfolkCreate',
      createdAt: '__SERVER_TS__',
      updatedAt: '__SERVER_TS__',
    });
  });

  it('is idempotent: an ALREADY_EXISTS create is swallowed, never clobbers', async () => {
    const ctx = buildCreateDbMock({ alreadyExists: true });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(onKinfolkCreateHandler(makeEvent('6', kinfolkDoc()))).resolves.toBeUndefined();
    expect(ctx.creates).toHaveLength(0);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'family.provision.skipped',
        extra: expect.objectContaining({ reason: 'already_exists' }),
      }),
    );
  });

  it('rethrows non-already-exists create failures (Cloud Functions retry semantics)', async () => {
    mocks.dbFn.mockReturnValue({
      doc: () => ({
        create: vi.fn(async () => {
          const err = new Error('unavailable') as Error & { code: number };
          err.code = 14;
          throw err;
        }),
      }),
    });
    await expect(onKinfolkCreateHandler(makeEvent('6', kinfolkDoc()))).rejects.toThrow('unavailable');
  });

  it('skips isTestData kinfolk without touching Firestore', async () => {
    const ctx = buildCreateDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);

    await onKinfolkCreateHandler(makeEvent('test-kinfolk-001', kinfolkDoc({ isTestData: true })));
    expect(ctx.creates).toHaveLength(0);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'family.provision.skipped',
        extra: expect.objectContaining({ reason: 'test_data' }),
      }),
    );
  });

  it('no-ops on an empty snapshot', async () => {
    const ctx = buildCreateDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    await onKinfolkCreateHandler(makeEvent('6', undefined));
    expect(ctx.creates).toHaveLength(0);
  });
});
