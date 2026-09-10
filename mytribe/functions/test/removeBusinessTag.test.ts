import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({
  writeAuditEntry: vi.fn().mockResolvedValue('audit-1'),
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { removeBusinessTagHandler, BUSINESS_SETTINGS_DOC } from '../src/admin/removeBusinessTag';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'auntie-1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } } as any) : undefined,
  } as unknown as CallableRequest<unknown>;
}

/** A vocabulary row as `business_settings` stores it. */
function def(name: string) {
  return { name, color: { token: 'teal', css: 'var(--color-accent)' }, icon: '' };
}

/**
 * The whole world this callable can see: both directory collections and the
 * single settings doc. `kinfolk` and `kin` deliberately carry the SAME tag name
 * so every test proves the two vocabularies stay independent.
 */
function world(opts: {
  kinfolk?: Array<{ id: string; tags?: unknown }>;
  kin?: Array<{ id: string; tags?: unknown }>;
  householdTags?: unknown;
  petTags?: unknown;
}) {
  const kinfolk = opts.kinfolk ?? [];
  const kin = opts.kin ?? [];
  return buildDbMock({
    docs: {
      [BUSINESS_SETTINGS_DOC]: {
        householdTags: opts.householdTags ?? [],
        petTags: opts.petTags ?? [],
      },
    },
    queryDocs: {
      kinfolk: kinfolk.map((r) => ({ id: r.id, data: { tags: r.tags } })),
      kin: kin.map((r) => ({ id: r.id, data: { tags: r.tags } })),
    },
  });
}

/** The `tags` array a write left on a doc. */
function tagsWrittenTo(ctx: ReturnType<typeof buildDbMock>, path: string): unknown {
  return ctx.writes.find((w) => w.path === path)?.data['tags'];
}

describe('removeBusinessTag', () => {
  it('strips the tag off every household AND drops the vocabulary row', async () => {
    const ctx = world({
      kinfolk: [
        { id: 'kf1', tags: ['VIP', 'Meds Needed'] },
        { id: 'kf2', tags: ['Meds Needed'] },
        { id: 'kf3', tags: ['VIP'] },
      ],
      householdTags: [def('VIP'), def('Meds Needed')],
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await removeBusinessTagHandler(req({ scope: 'household', name: 'Meds Needed' }));

    expect(res).toEqual({
      ok: true,
      scope: 'household',
      name: 'Meds Needed',
      recordsTouched: 2,
      vocabRemoved: true,
    });
    expect(tagsWrittenTo(ctx, 'kinfolk/kf1')).toEqual(['VIP']);
    expect(tagsWrittenTo(ctx, 'kinfolk/kf2')).toEqual([]);
    // Untouched: it never carried the tag, so it must not be rewritten at all.
    expect(ctx.writes.some((w) => w.path === 'kinfolk/kf3')).toBe(false);
    expect(ctx.writes.find((w) => w.path === BUSINESS_SETTINGS_DOC)?.data['householdTags']).toEqual([
      def('VIP'),
    ]);
  });

  it('matches assignments case-insensitively, the same rule the chips resolve by', async () => {
    const ctx = world({
      kinfolk: [
        { id: 'kf1', tags: ['vip'] },
        { id: 'kf2', tags: ['  VIP  '] },
      ],
      householdTags: [def('VIP')],
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await removeBusinessTagHandler(req({ scope: 'household', name: 'vIp' }));

    expect(res.recordsTouched).toBe(2);
    expect(tagsWrittenTo(ctx, 'kinfolk/kf1')).toEqual([]);
    expect(tagsWrittenTo(ctx, 'kinfolk/kf2')).toEqual([]);
    expect(res.vocabRemoved).toBe(true);
  });

  it('leaves the other vocabulary and its collection alone when a name exists in both', async () => {
    const ctx = world({
      kinfolk: [{ id: 'kf1', tags: ['Meds Needed'] }],
      kin: [{ id: 'k1', tags: ['Meds Needed'] }],
      householdTags: [def('Meds Needed')],
      petTags: [def('Meds Needed')],
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await removeBusinessTagHandler(req({ scope: 'pet', name: 'Meds Needed' }));

    expect(res.recordsTouched).toBe(1);
    expect(tagsWrittenTo(ctx, 'kin/k1')).toEqual([]);
    expect(ctx.writes.some((w) => w.path.startsWith('kinfolk/'))).toBe(false);
    const settings = ctx.writes.find((w) => w.path === BUSINESS_SETTINGS_DOC);
    expect(settings?.data['petTags']).toEqual([]);
    // The household list is not in the patch at all, so a merge cannot clobber it.
    expect(settings?.data).not.toHaveProperty('householdTags');
  });

  it('still strips assignments when the vocabulary row is already gone', async () => {
    const ctx = world({
      kinfolk: [{ id: 'kf1', tags: ['Orphaned'] }],
      householdTags: [def('VIP')],
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await removeBusinessTagHandler(req({ scope: 'household', name: 'Orphaned' }));

    expect(res.recordsTouched).toBe(1);
    expect(res.vocabRemoved).toBe(false);
    expect(tagsWrittenTo(ctx, 'kinfolk/kf1')).toEqual([]);
    // Nothing to change in the vocabulary, so the settings doc is not rewritten.
    expect(ctx.writes.some((w) => w.path === BUSINESS_SETTINGS_DOC)).toBe(false);
  });

  it('drops the vocabulary row even when nothing carries the tag', async () => {
    const ctx = world({ kinfolk: [{ id: 'kf1', tags: ['VIP'] }], householdTags: [def('Unused')] });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await removeBusinessTagHandler(req({ scope: 'household', name: 'Unused' }));

    expect(res).toMatchObject({ recordsTouched: 0, vocabRemoved: true });
    expect(ctx.writes.some((w) => w.path === 'kinfolk/kf1')).toBe(false);
  });

  it('ignores non-string entries in a malformed tags array instead of throwing', async () => {
    const ctx = world({
      kinfolk: [{ id: 'kf1', tags: ['VIP', 7, null, 'Meds Needed'] }],
      householdTags: [def('Meds Needed')],
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await removeBusinessTagHandler(req({ scope: 'household', name: 'Meds Needed' }));

    expect(res.recordsTouched).toBe(1);
    expect(tagsWrittenTo(ctx, 'kinfolk/kf1')).toEqual(['VIP']);
  });

  it('records the cascade in the audit trail with the ids it touched', async () => {
    const ctx = world({
      kinfolk: [{ id: 'kf1', tags: ['VIP'] }, { id: 'kf2', tags: ['VIP'] }],
      householdTags: [def('VIP')],
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await removeBusinessTagHandler(req({ scope: 'household', name: 'VIP' }));

    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const entry = (writeAuditEntry as any).mock.calls[0][0];
    expect(entry.event).toBe('BUSINESS_TAG_REMOVED');
    expect(entry.payload).toMatchObject({
      scope: 'household',
      name: 'VIP',
      recordsTouched: 2,
      recordIds: ['kf1', 'kf2'],
    });
  });

  it('refuses an unauthenticated caller before reading anything', async () => {
    const ctx = world({ kinfolk: [{ id: 'kf1', tags: ['VIP'] }], householdTags: [def('VIP')] });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      removeBusinessTagHandler(req({ scope: 'household', name: 'VIP' }, null)),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses an unknown scope and a blank name', async () => {
    const ctx = world({ householdTags: [def('VIP')] });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      removeBusinessTagHandler(req({ scope: 'kinfolk', name: 'VIP' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(
      removeBusinessTagHandler(req({ scope: 'household', name: '   ' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.writes).toHaveLength(0);
  });
});
