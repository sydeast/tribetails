import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';
import { installOptimisticTransactions } from './_helpers/optimisticTransaction';

/**
 * #2204 / #2205: tags change one named tag at a time against the list as
 * stored, so no client can lose a tag added elsewhere or bring a deleted one
 * back by sending the list it read.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({
  writeAuditEntry: vi.fn().mockResolvedValue('audit-1'),
}));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));

import {
  changeBusinessTagsHandler,
  applyTagChanges,
  Args,
  BUSINESS_SETTINGS_DOC,
  TAG_EXISTS_CODE,
  TAG_MISSING_CODE,
  TOO_MANY_TAGS_CODE,
} from '../src/admin/changeBusinessTags';
import { removeBusinessTagHandler } from '../src/admin/removeBusinessTag';
import { saveBusinessSettingsHandler } from '../src/admin/saveBusinessSettings';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';
import { wrapAdminCallable } from '../src/lib/wrapAdminCallable';
import { AUNTIE_ALLOWED_CALLABLES } from '../src/lib/auntieAccess';
import { AUDIT_EVENTS, SERVER_ONLY_AUDIT_EVENTS } from '../src/lib/auditEvents';
import { TAGS_SAVE_ONE_AT_A_TIME } from '../src/lib/businessSettingsChecks';

const TEAL = { token: 'teal', css: 'var(--color-accent)' };
const GOLD = { token: 'gold', css: 'var(--color-gold)' };
const def = (name: string, color = TEAL, icon = '') => ({ name, color, icon });

function req(data: unknown, uid: string | null = 'owner-1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } } as any) : undefined,
  } as unknown as CallableRequest<unknown>;
}

const add = (name: string, scope: 'household' | 'pet' = 'household', color = TEAL, icon = '') => ({
  action: 'add' as const,
  scope,
  name,
  color,
  icon,
});
const style = (name: string, scope: 'household' | 'pet' = 'household', color = GOLD, icon = '⭐') => ({
  action: 'style' as const,
  scope,
  name,
  color,
  icon,
});

let docs: Record<string, any>;
let ctx: ReturnType<typeof buildDbMock>;
function world(stored: Record<string, unknown>) {
  docs = { [BUSINESS_SETTINGS_DOC]: { businessName: 'Tribe Tails', ...stored } };
  ctx = buildDbMock({ docs, writeThrough: true });
  mocks.dbFn.mockReturnValue(ctx.db);
}
const stored = (field: string) => docs[BUSINESS_SETTINGS_DOC][field];
const names = (field: string) => (stored(field) as Array<{ name: string }>).map((r) => r.name);

async function refusalOf(p: Promise<unknown>): Promise<{ code: string; message: string; details: any }> {
  try {
    await p;
  } catch (e) {
    return e as any;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

describe('changeBusinessTags: add', () => {
  it('adds one name to the list as stored, keeping every tag already there', async () => {
    world({ householdTags: [def('VIP'), def('Slow pay')], petTags: [def('Reactive')] });
    const res = await changeBusinessTagsHandler(req({ changes: [add('Gate code')] }));
    expect(names('householdTags')).toEqual(['VIP', 'Slow pay', 'Gate code']);
    expect(stored('petTags')).toEqual([def('Reactive')]);
    expect(res.householdTags).toEqual([def('VIP'), def('Slow pay'), def('Gate code')]);
    expect(res.petTags).toEqual([def('Reactive')]);
    expect(stored('updatedBy')).toBe('owner-1');
  });

  it('#2205: a tag added to the stored list after the panel loaded is kept', async () => {
    // The panel read ['VIP']; another device has since added 'Slow pay'.
    world({ householdTags: [def('VIP'), def('Slow pay')] });
    await changeBusinessTagsHandler(req({ changes: [add('Gate code')] }));
    expect(names('householdTags')).toEqual(['VIP', 'Slow pay', 'Gate code']);
  });

  it('#2205: a tag deleted after the panel loaded does not come back', async () => {
    // The panel read ['VIP', 'Slow pay']; 'Slow pay' has since been deleted.
    world({ householdTags: [def('VIP')] });
    await changeBusinessTagsHandler(req({ changes: [add('Gate code')] }));
    expect(names('householdTags')).toEqual(['VIP', 'Gate code']);
  });

  it('#2204: an add on an empty-looking panel never replaces the list', async () => {
    // Admin Android used to send a list of one when the list had not loaded.
    world({ householdTags: [def('VIP'), def('Slow pay'), def('Gate code')] });
    await changeBusinessTagsHandler(req({ changes: [add('Keys under mat')] }));
    expect(names('householdTags')).toEqual(['VIP', 'Slow pay', 'Gate code', 'Keys under mat']);
  });

  it('refuses a name already on the list, in any casing, in plain words, and writes nothing', async () => {
    world({ householdTags: [def('VIP')] });
    const before = JSON.stringify(docs);
    const err = await refusalOf(changeBusinessTagsHandler(req({ changes: [add('  vip ')] })));
    expect(err.code).toBe('failed-precondition');
    expect(err.message).toBe('A "VIP" tag already exists.');
    expect(err.details).toMatchObject({ code: TAG_EXISTS_CODE, scope: 'household', name: 'vip' });
    expect(JSON.stringify(docs)).toBe(before);
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('the two lists are independent: the same name may sit on both', async () => {
    world({ householdTags: [def('Meds Needed')], petTags: [] });
    await changeBusinessTagsHandler(req({ changes: [add('Meds Needed', 'pet')] }));
    expect(names('petTags')).toEqual(['Meds Needed']);
    expect(names('householdTags')).toEqual(['Meds Needed']);
  });

  it('normalizes the name the way every client does', async () => {
    world({ householdTags: [] });
    await changeBusinessTagsHandler(req({ changes: [add('  Slow   pay ')] }));
    expect(names('householdTags')).toEqual(['Slow pay']);
  });

  it('refuses past 200 tags', async () => {
    world({ householdTags: Array.from({ length: 200 }, (_, i) => def(`T${i}`)) });
    const err = await refusalOf(changeBusinessTagsHandler(req({ changes: [add('One more')] })));
    expect(err.details.code).toBe(TOO_MANY_TAGS_CODE);
    expect(err.message).toBe('That is more than 200 tags.');
  });

  it('works on a document with no list yet', async () => {
    world({});
    await changeBusinessTagsHandler(req({ changes: [add('VIP', 'pet')] }));
    expect(names('petTags')).toEqual(['VIP']);
    expect(stored('householdTags')).toBeUndefined();
  });
});

describe('changeBusinessTags: style (colour and emoji)', () => {
  it('changes only the colour and emoji of the named tag, keeping its stored name', async () => {
    world({ householdTags: [def('VIP'), { ...def('Slow pay'), legacy: 1 }] });
    await changeBusinessTagsHandler(req({ changes: [style('slow pay')] }));
    expect(stored('householdTags')).toEqual([def('VIP'), { name: 'Slow pay', color: GOLD, icon: '⭐', legacy: 1 }]);
  });

  it('#2205: a stale Settings screen recolouring a deleted tag is refused, never re-creates it', async () => {
    world({ householdTags: [def('VIP')] });
    const err = await refusalOf(changeBusinessTagsHandler(req({ changes: [style('Slow pay')] })));
    expect(err.code).toBe('failed-precondition');
    expect(err.details.code).toBe(TAG_MISSING_CODE);
    expect(err.message).toMatch(/The tag list changed since this screen opened.*Reload and try again\./);
    expect(names('householdTags')).toEqual(['VIP']);
  });
});

describe('changeBusinessTags: one Save carrying several changes', () => {
  it('applies them in order across both lists in one write', async () => {
    world({ householdTags: [def('VIP')], petTags: [def('Reactive')] });
    await changeBusinessTagsHandler(
      req({ changes: [add('Slow pay'), style('VIP'), add('On meds', 'pet'), style('On meds', 'pet')] }),
    );
    expect(stored('householdTags')).toEqual([def('VIP', GOLD, '⭐'), def('Slow pay')]);
    expect(stored('petTags')).toEqual([def('Reactive'), def('On meds', GOLD, '⭐')]);
    expect(ctx.writes.filter((w: { path: string }) => w.path === BUSINESS_SETTINGS_DOC)).toHaveLength(1);
  });

  it('one refusal writes nothing at all', async () => {
    world({ householdTags: [def('VIP')], petTags: [] });
    const before = JSON.stringify(docs);
    await refusalOf(changeBusinessTagsHandler(req({ changes: [add('Slow pay'), add('slow PAY')] })));
    expect(JSON.stringify(docs)).toBe(before);
  });

  it('writes the audit line, a server-only kind', async () => {
    world({ householdTags: [] });
    await changeBusinessTagsHandler(req({ changes: [add('VIP')] }));
    const entry = (writeAuditEntry as any).mock.calls[0][0];
    expect(entry.event).toBe(AUDIT_EVENTS.BUSINESS_TAGS_CHANGED);
    expect(entry.payload).toEqual({ changes: [{ action: 'add', scope: 'household', name: 'VIP' }] });
    expect(entry.description).toBe('Added the tag "VIP" to the household tag list');
    expect(SERVER_ONLY_AUDIT_EVENTS.has(AUDIT_EVENTS.BUSINESS_TAGS_CHANGED)).toBe(true);
  });
});

describe('changeBusinessTags: concurrency (optimistic transactions)', () => {
  it('two clients adding at once both land', async () => {
    world({ householdTags: [def('VIP')] });
    let landed = false;
    const tx = installOptimisticTransactions(ctx.db, docs, {
      onRead: (path, attempt) => {
        // The other device's add lands between this save's read and its commit.
        if (path !== BUSINESS_SETTINGS_DOC || attempt !== 1 || landed) return;
        landed = true;
        docs[BUSINESS_SETTINGS_DOC] = {
          ...docs[BUSINESS_SETTINGS_DOC],
          householdTags: [...docs[BUSINESS_SETTINGS_DOC].householdTags, def('Slow pay')],
        };
      },
    });
    const res = await changeBusinessTagsHandler(req({ changes: [add('Gate code')] }));
    expect(names('householdTags')).toEqual(['VIP', 'Slow pay', 'Gate code']);
    expect(res.householdTags).toEqual([def('VIP'), def('Slow pay'), def('Gate code')]);
    expect(tx.attempts()).toBe(2);
  });

  it('two clients adding the same name at once: the second is refused, the list holds it once', async () => {
    world({ householdTags: [] });
    let landed = false;
    installOptimisticTransactions(ctx.db, docs, {
      onRead: (path, attempt) => {
        if (path !== BUSINESS_SETTINGS_DOC || attempt !== 1 || landed) return;
        landed = true;
        docs[BUSINESS_SETTINGS_DOC] = { ...docs[BUSINESS_SETTINGS_DOC], householdTags: [def('VIP')] };
      },
    });
    const err = await refusalOf(changeBusinessTagsHandler(req({ changes: [add('vip')] })));
    expect(err.details.code).toBe(TAG_EXISTS_CODE);
    expect(names('householdTags')).toEqual(['VIP']);
  });

  it('a delete landing mid-save is not undone by the add', async () => {
    world({ householdTags: [def('VIP'), def('Slow pay')] });
    let landed = false;
    installOptimisticTransactions(ctx.db, docs, {
      onRead: (path, attempt) => {
        if (path !== BUSINESS_SETTINGS_DOC || attempt !== 1 || landed) return;
        landed = true;
        docs[BUSINESS_SETTINGS_DOC] = { ...docs[BUSINESS_SETTINGS_DOC], householdTags: [def('VIP')] };
      },
    });
    await changeBusinessTagsHandler(req({ changes: [add('Gate code')] }));
    expect(names('householdTags')).toEqual(['VIP', 'Gate code']);
  });
});

describe('removeBusinessTag: the vocabulary drop is transactional (#2205)', () => {
  it('a tag added between its read and its write is kept', async () => {
    docs = {
      [BUSINESS_SETTINGS_DOC]: { householdTags: [def('VIP'), def('Slow pay')], petTags: [] },
    };
    ctx = buildDbMock({ docs, writeThrough: true, queryDocs: { kinfolk: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    let landed = false;
    const tx = installOptimisticTransactions(ctx.db, docs, {
      onRead: (path, attempt) => {
        if (path !== BUSINESS_SETTINGS_DOC || attempt !== 1 || landed) return;
        landed = true;
        docs[BUSINESS_SETTINGS_DOC] = {
          ...docs[BUSINESS_SETTINGS_DOC],
          householdTags: [...docs[BUSINESS_SETTINGS_DOC].householdTags, def('Gate code')],
        };
      },
    });
    const res = await removeBusinessTagHandler(req({ scope: 'household', name: 'Slow pay' }));
    expect(res.vocabRemoved).toBe(true);
    expect(names('householdTags')).toEqual(['VIP', 'Gate code']);
    expect(tx.attempts()).toBe(2);
  });
});

describe('saveBusinessSettings: a whole tag list never replaces the stored one (old clients)', () => {
  it('a stale list from an old build is refused and nothing is written', async () => {
    // The old panel read ['VIP', 'Slow pay']; since then 'Slow pay' was deleted
    // and 'Gate code' added. Its add of 'Keys' would put 'Slow pay' back and lose 'Gate code'.
    world({ householdTags: [def('VIP'), def('Gate code')] });
    const before = JSON.stringify(docs);
    const err = await refusalOf(
      saveBusinessSettingsHandler(req({ changes: { householdTags: [def('VIP'), def('Slow pay'), def('Keys')] } })),
    );
    expect(err.code).toBe('invalid-argument');
    expect(err.message).toBe(TAGS_SAVE_ONE_AT_A_TIME);
    expect(err.details).toMatchObject({ code: 'settings_refused', field: 'householdTags' });
    expect(JSON.stringify(docs)).toBe(before);
  });

  it('an old Android add before load (a list of one) is refused', async () => {
    world({ petTags: [def('Reactive'), def('On meds')] });
    const err = await refusalOf(saveBusinessSettingsHandler(req({ changes: { petTags: [def('Shy')] } })));
    expect(err.message).toBe(TAGS_SAVE_ONE_AT_A_TIME);
    expect(names('petTags')).toEqual(['Reactive', 'On meds']);
  });

  it('a whole-list save refused alongside other fields writes none of them', async () => {
    world({ householdTags: [def('VIP')] });
    await refusalOf(
      saveBusinessSettingsHandler(req({ changes: { businessName: 'New', householdTags: [] } })),
    );
    expect(stored('businessName')).toBe('Tribe Tails');
    expect(names('householdTags')).toEqual(['VIP']);
  });

  it('the list as stored, echoed back with another field, is left out of the write', async () => {
    world({ householdTags: [def('VIP')], updatedAt: '2026-11-01T00:00:00.000Z', updatedBy: 'x' });
    // Key order differs from what is stored; it is still the same list.
    const echoed = [{ icon: '', color: { css: TEAL.css, token: TEAL.token }, name: 'VIP' }];
    await saveBusinessSettingsHandler(req({ changes: { businessName: 'New name', householdTags: echoed } }));
    expect(stored('businessName')).toBe('New name');
    const write = ctx.writes.find((w: { path: string }) => w.path === BUSINESS_SETTINGS_DOC);
    expect(write?.data).not.toHaveProperty('householdTags');
  });

  it('an echo of the stored lists alone writes nothing and keeps the stamp', async () => {
    world({ householdTags: [def('VIP')], updatedAt: '2026-11-01T00:00:00.000Z', updatedBy: 'x' });
    const res = await saveBusinessSettingsHandler(req({ changes: { householdTags: [def('VIP')], petTags: [] } }));
    expect(res).toEqual({ updatedAt: '2026-11-01T00:00:00.000Z', updatedBy: 'x' });
    expect(ctx.writes.filter((w: { path: string }) => w.path === BUSINESS_SETTINGS_DOC)).toHaveLength(0);
  });
});

describe('changeBusinessTags: request shape and access', () => {
  it('refuses a request it cannot read', async () => {
    world({ householdTags: [] });
    for (const bad of [
      {},
      { changes: [] },
      { changes: [{ action: 'rename', scope: 'household', name: 'VIP' }] },
      { changes: [{ ...add('VIP'), scope: 'everything' }] },
      { changes: [{ ...add('VIP'), color: 'teal' }] },
      { changes: [add('VIP')], householdTags: [] },
    ]) {
      const err = await refusalOf(changeBusinessTagsHandler(req(bad)));
      expect(err.code, JSON.stringify(bad)).toBe('invalid-argument');
    }
    expect(stored('householdTags')).toEqual([]);
  });

  it('a blank or overlong name is refused in the words the clients use', async () => {
    world({ householdTags: [] });
    expect((await refusalOf(changeBusinessTagsHandler(req({ changes: [add('   ')] })))).message).toBe(
      'A tag name is required.',
    );
    expect((await refusalOf(changeBusinessTagsHandler(req({ changes: [add('x'.repeat(41))] })))).message).toBe(
      'A tag name must be 40 characters or fewer.',
    );
  });

  it('refuses a caller with no sign-in', async () => {
    world({ householdTags: [] });
    const err = await refusalOf(changeBusinessTagsHandler(req({ changes: [add('VIP')] }, null)));
    expect(err.code).toBe('unauthenticated');
  });

  it('is owner-only: an Auntie is refused and nothing is written', async () => {
    expect(AUNTIE_ALLOWED_CALLABLES.has('changeBusinessTags')).toBe(false);
    world({ householdTags: [def('VIP')] });
    const wrapped = wrapAdminCallable('changeBusinessTags', changeBusinessTagsHandler);
    const auntie = {
      data: { changes: [add('Gate code')] },
      auth: { uid: 'auntie-1', token: { staffRole: 'auntie' } },
    } as unknown as CallableRequest<unknown>;
    const err = await refusalOf(wrapped(auntie));
    expect(err.code).toBe('permission-denied');
    expect(names('householdTags')).toEqual(['VIP']);
  });

  it('Args freezes the envelope', () => {
    expect(Object.keys(Args.shape)).toEqual(['changes']);
  });

  it('applyTagChanges never mutates what it was handed', () => {
    const household = [def('VIP')];
    applyTagChanges({ household, pet: [] }, [add('Slow pay'), style('VIP')]);
    expect(household).toEqual([def('VIP')]);
  });
});
