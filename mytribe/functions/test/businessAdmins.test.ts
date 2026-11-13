import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  getUsers: vi.fn(),
  /**
   * Custom claims per uid, as the Admin SDK returns them. A uid not named here
   * is an owner (`admin: true`), so every older test below runs against owner
   * accounts. `null` means no sign-in account exists for the uid.
   */
  claims: {} as Record<string, Record<string, unknown> | null>,
}));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: vi.fn(),
  getAdmin: () => ({ auth: () => ({ getUsers: mocks.getUsers }) }),
}));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: { serverTimestamp: () => '__SERVER_TS__', delete: () => '__DELETE__' },
  };
});

import { logEvent } from '../src/lib/logger';
import {
  BusinessAdminRosterError,
  MAX_ROSTER_SIZE,
  addBusinessAdminUids,
  defaultAssigneeUidFrom,
  readBusinessAdmins,
  removeBusinessAdminUids,
  resolveBusinessAdminUids,
  resolveBusinessAdminUidsFrom,
  resolveDefaultAssigneeUid,
  setBusinessAdminUids,
} from '../src/lib/businessAdmins';

const ORIGINAL_ENV = process.env.AUNTIE_OPERATOR_UIDS;
const DOC = 'businessSettings/admins';

/** `getUsers` answered from `mocks.claims`. */
async function usersFromClaims(ids: Array<{ uid: string }>) {
  const users: Array<{ uid: string; customClaims: Record<string, unknown> }> = [];
  const notFound: Array<{ uid: string }> = [];
  for (const { uid } of ids) {
    const claims = uid in mocks.claims ? mocks.claims[uid] : { admin: true };
    if (claims === null) notFound.push({ uid });
    else users.push({ uid, customClaims: claims });
  }
  return { users, notFound };
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.claims = {};
  mocks.getUsers.mockReset().mockImplementation(usersFromClaims);
  vi.mocked(logEvent).mockClear();
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.AUNTIE_OPERATOR_UIDS;
  else process.env.AUNTIE_OPERATOR_UIDS = ORIGINAL_ENV;
});

/**
 * Counts `.get()` calls against `businessSettings/admins` specifically. The
 * mock hands out a fresh doc ref (with a fresh `vi.fn()` get) per call, so the
 * only place to count from is the collection accessor.
 */
function countAdminDocReads(ctx: { db: Record<string, unknown> }): { reads: number } {
  const counter = { reads: 0 };
  const realCollection = ctx.db['collection'] as (path: string) => Record<string, unknown>;
  ctx.db['collection'] = (path: string) => {
    const col = realCollection(path);
    if (path !== 'businessSettings') return col;
    const realDoc = col['doc'] as (id?: string) => Record<string, unknown>;
    col['doc'] = (id?: string) => {
      const ref = realDoc(id);
      const realGet = ref['get'] as () => Promise<unknown>;
      ref['get'] = async () => {
        counter.reads += 1;
        return realGet();
      };
      return ref;
    };
    return col;
  };
  return counter;
}

/**
 * `businessSettings/admins` had two readers and no writer, and did not exist in
 * prod. 16 catalog keys name `businessAdmins` as their PRIMARY resolver, so
 * every business notification threw "cannot dispatch" and the operator was
 * never told a booking had been requested.
 */
describe('resolveBusinessAdminUids', () => {
  it('returns the stored roster when the doc has one', async () => {
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1', 'op2'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(resolveBusinessAdminUids('t')).resolves.toEqual(['op1', 'op2']);
    // Nothing to heal, so nothing is written.
    expect(ctx.writes).toHaveLength(0);
  });

  it('THROWS rather than returning empty when nothing is configured', async () => {
    // The whole point: a business notification with no recipient must be loud.
    // Returning [] here would have the dispatcher believe it delivered to nobody
    // successfully, which is the failure mode this replaces.
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(resolveBusinessAdminUids('recipientResolver(kincare.requested)')).rejects.toThrow(
      /businessSettings\/admins\.uids is empty/,
    );
  });

  it('names the fix in the error, so the next reader is not left guessing', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(resolveBusinessAdminUids('t')).rejects.toThrow(/provisionBusinessAdmins/);
  });

  it('self-heals from AUNTIE_OPERATOR_UIDS and writes the roster back', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op1, op2';
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(resolveBusinessAdminUids('t')).resolves.toEqual(['op1', 'op2']);

    // Written back so the fallback is needed once, not on every dispatch.
    const write = ctx.writes.find((w) => w.path === DOC);
    expect(write?.data['uids']).toEqual(['op1', 'op2']);
    expect(write?.merge).toBe(true);
  });

  it('treats an empty uids array the same as a missing doc', async () => {
    const ctx = buildDbMock({ docs: { [DOC]: { uids: [] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(resolveBusinessAdminUids('t')).rejects.toThrow(/is empty/);
  });

  it('prefers the stored roster over the env allowlist', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'env-only';
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['stored'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(resolveBusinessAdminUids('t')).resolves.toEqual(['stored']);
  });
});

/**
 * FINDING 2: the self-heal is a WRITE inside a function every caller treats as
 * a pure resolve, sitting on the notification dispatch path. It must not be
 * able to turn a dispatch that would have succeeded into a failed one.
 */
describe('resolveBusinessAdminUids self-heal write failure', () => {
  it('still returns the resolved recipients when the write-back throws', async () => {
    // Proves the dispatch is NOT failed by a Firestore write failure: the
    // recipients came from AUNTIE_OPERATOR_UIDS and the answer does not depend
    // on the write landing. Before this, the throw propagated to the dispatcher.
    process.env.AUNTIE_OPERATOR_UIDS = 'op1,op2';
    const ctx = buildDbMock({ docs: {} });
    ctx.db.runTransaction = vi.fn(async () => {
      throw new Error('firestore unavailable');
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(resolveBusinessAdminUids('recipientResolver(message.received)')).resolves.toEqual([
      'op1',
      'op2',
    ]);
  });

  it('logs the failed write-back at error severity rather than swallowing it', async () => {
    // Best-effort must still be LOUD: the write really did fail and an operator
    // reading logs has to see it. Proves the catch logs rather than ignores.
    process.env.AUNTIE_OPERATOR_UIDS = 'op1';
    const ctx = buildDbMock({ docs: {} });
    ctx.db.runTransaction = vi.fn(async () => {
      throw new Error('firestore unavailable');
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await resolveBusinessAdminUids('t');

    const failure = vi
      .mocked(logEvent)
      .mock.calls.map((c) => c[0])
      .find((f) => f.event === 'businessAdmins.roster.healWriteFailed');
    expect(failure?.severity).toBe('error');
    expect(failure?.errorMessage).toContain('firestore unavailable');
  });

  it('still THROWS when there is genuinely no recipient, write or no write', async () => {
    // The best-effort write must not have softened the loud path: with no
    // roster AND no env allowlist there is nobody to notify, and that stays fatal.
    const ctx = buildDbMock({ docs: {} });
    ctx.db.runTransaction = vi.fn(async () => {
      throw new Error('firestore unavailable');
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(resolveBusinessAdminUids('t')).rejects.toThrow(/no recipient/);
  });
});

describe('addBusinessAdminUids', () => {
  it('unions with the stored roster and never narrows it', async () => {
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['existing'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await addBusinessAdminUids(['added'], { reason: 'test' });

    const write = ctx.writes.find((w) => w.path === DOC);
    expect(write?.data['uids']).toEqual(['existing', 'added']);
  });

  it('does not overwrite a defaultAssigneeUid the operator already chose', async () => {
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['a'], defaultAssigneeUid: 'chosen' } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await addBusinessAdminUids(['b'], { defaultAssigneeUid: 'other', reason: 'test' });

    const write = ctx.writes.find((w) => w.path === DOC);
    // Untouched: the field is not in the merge payload at all, so 'chosen' stands.
    expect(write?.data['defaultAssigneeUid']).toBeUndefined();
    expect(defaultAssigneeUidFrom({ uids: ['a', 'b'], defaultAssigneeUid: 'chosen' })).toBe('chosen');
  });

  it('is idempotent: the same call twice leaves one roster', async () => {
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['a'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await addBusinessAdminUids(['a'], { reason: 'test' });
    const write = ctx.writes.find((w) => w.path === DOC);
    expect(write?.data['uids']).toEqual(['a']);
  });

  it('REFUSES to leave the roster empty instead of quietly writing nothing', async () => {
    // Adding nothing to an empty roster is a request for the original outage.
    // The old version returned [] here, which is exactly the silent empty this
    // module refuses. Proves it now throws AND writes nothing.
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(addBusinessAdminUids([], { reason: 'test' })).rejects.toMatchObject({
      refusal: 'empty-roster',
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses to grow the roster past MAX_ROSTER_SIZE', async () => {
    // Every uid on the roster receives every business notification, and those
    // carry kinfolk PII. Proves the grow-only arm is bounded, so repeated
    // provisioning cannot fan PII out without limit.
    const tooMany = Array.from({ length: MAX_ROSTER_SIZE + 1 }, (_v, i) => `u${i}`);
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(addBusinessAdminUids(tooMany, { reason: 'test' })).rejects.toMatchObject({
      refusal: 'roster-too-large',
    });
    expect(ctx.writes).toHaveLength(0);
  });
});

/**
 * FINDING 1: the roster could only GROW. A mistaken or malicious addition was
 * permanent from the API and needed Firestore console access to undo, while
 * every uid on it received kinfolk PII.
 */
describe('setBusinessAdminUids (authoritative set)', () => {
  it('replaces the roster, so a uid can actually be revoked', async () => {
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1', 'mistake'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const change = await setBusinessAdminUids(['op1'], { actorUid: 'op1', reason: 'test' });

    expect(change.uids).toEqual(['op1']);
    expect(change.removed).toEqual(['mistake']);
    const write = ctx.writes.find((w) => w.path === DOC);
    expect(write?.data['uids']).toEqual(['op1']);
  });

  it('refuses to drop the caller, rather than silently re-adding them', async () => {
    // Refusing tells a UI that submitted the wrong list; silently re-inserting
    // would hide the bug. Proves the actor invariant fires on a NON-empty
    // result, so it is not just the empty-roster check in disguise.
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1', 'op2'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      setBusinessAdminUids(['op2'], { actorUid: 'op1', reason: 'test' }),
    ).rejects.toMatchObject({ refusal: 'self-removal' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses an empty roster', async () => {
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(setBusinessAdminUids([], { actorUid: 'op1', reason: 'test' })).rejects.toMatchObject(
      { refusal: 'empty-roster' },
    );
    expect(ctx.writes).toHaveLength(0);
  });

  it('throws BusinessAdminRosterError, the type callables map to failed-precondition', async () => {
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(setBusinessAdminUids([], { actorUid: 'op1', reason: 'test' })).rejects.toBeInstanceOf(
      BusinessAdminRosterError,
    );
  });
});

describe('removeBusinessAdminUids', () => {
  it('revokes the named uid and keeps the rest', async () => {
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1', 'gone', 'op3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const change = await removeBusinessAdminUids(['gone'], { actorUid: 'op1', reason: 'test' });

    expect(change.uids).toEqual(['op1', 'op3']);
    expect(change.removed).toEqual(['gone']);
    expect(ctx.writes.find((w) => w.path === DOC)?.data['uids']).toEqual(['op1', 'op3']);
  });

  it('refuses to remove the caller', async () => {
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1', 'op2'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      removeBusinessAdminUids(['op1'], { actorUid: 'op1', reason: 'test' }),
    ).rejects.toMatchObject({ refusal: 'self-removal' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('names the alternative in the self-removal refusal', async () => {
    // "Stop notifying me" already has a tool. The refusal points at it rather
    // than leaving the operator to reach for the Firestore console.
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1', 'op2'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      removeBusinessAdminUids(['op1'], { actorUid: 'op1', reason: 'test' }),
    ).rejects.toThrow(/saveMyAdminNotificationPrefs/);
  });

  it('refuses to empty the roster', async () => {
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1', 'op2'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      removeBusinessAdminUids(['op1', 'op2'], { actorUid: 'op1', reason: 'test' }),
    ).rejects.toMatchObject({ refusal: 'empty-roster' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('clears defaultAssigneeUid when the revoked uid was the default assignee', async () => {
    // Otherwise new visits would keep being assigned to somebody whose access
    // was just revoked. Assignment falls back to the surviving uids[0].
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1', 'gone'], defaultAssigneeUid: 'gone' } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const change = await removeBusinessAdminUids(['gone'], { actorUid: 'op1', reason: 'test' });

    expect(change.defaultAssigneeCleared).toBe(true);
    expect(ctx.writes.find((w) => w.path === DOC)?.data['defaultAssigneeUid']).toBe('__DELETE__');
    // And the fallback lands on a uid that is still on the roster.
    expect(defaultAssigneeUidFrom({ uids: change.uids, defaultAssigneeUid: null })).toBe('op1');
  });

  it('leaves a surviving defaultAssigneeUid untouched', async () => {
    // Proves the clear above is scoped to revocation, not applied to every write.
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1', 'gone'], defaultAssigneeUid: 'op1' } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const change = await removeBusinessAdminUids(['gone'], { actorUid: 'op1', reason: 'test' });

    expect(change.defaultAssigneeCleared).toBe(false);
    expect(ctx.writes.find((w) => w.path === DOC)?.data['defaultAssigneeUid']).toBeUndefined();
  });

  it('a revoked uid is not resurrected by the env self-heal', async () => {
    // The security property that makes revocation real: the env arm only fires
    // when the STORED roster is empty, and the invariants make that unreachable
    // through the API. So 'gone' stays gone even though it is still in
    // AUNTIE_OPERATOR_UIDS.
    process.env.AUNTIE_OPERATOR_UIDS = 'op1,gone';
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(resolveBusinessAdminUids('t')).resolves.toEqual(['op1']);
  });
});

/**
 * FINDING 3: two resolvers, one document, opposite contracts. Kept, documented
 * at both sites, and now built on ONE read.
 */
describe('the two resolvers, one document', () => {
  it('reads the doc exactly once when a caller needs both answers', async () => {
    // Proves the projections are pure over a snapshot: one read serves the
    // recipient list and the default assignee, where the convenience wrappers
    // would have read twice.
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1', 'op2'], defaultAssigneeUid: 'op2' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const counter = countAdminDocReads(ctx);

    const settings = await readBusinessAdmins();
    await expect(resolveBusinessAdminUidsFrom(settings, 't')).resolves.toEqual(['op1', 'op2']);
    expect(defaultAssigneeUidFrom(settings)).toBe('op2');

    expect(counter.reads).toBe(1);
  });

  it('disagrees on purpose: same empty doc, recipients throw, assignee returns null', async () => {
    // The asymmetry is the design, not a bug. A notification with no recipient
    // is silent data loss; an unassigned visit is a WORKING booking.
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    const settings = await readBusinessAdmins();
    await expect(resolveBusinessAdminUidsFrom(settings, 't')).rejects.toThrow(/no recipient/);
    expect(defaultAssigneeUidFrom(settings)).toBeNull();
  });

  it('the assignee path never writes, even when the roster is empty and env is set', async () => {
    // The recipient path heals from the same env value, so the booking path does
    // not need to take write risk to make the roster converge.
    process.env.AUNTIE_OPERATOR_UIDS = 'op1';
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(resolveDefaultAssigneeUid()).resolves.toBe('op1');
    expect(ctx.writes).toHaveLength(0);
  });
});

describe('resolveDefaultAssigneeUid', () => {
  it('prefers an explicit defaultAssigneeUid', async () => {
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['a', 'b'], defaultAssigneeUid: 'b' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(resolveDefaultAssigneeUid()).resolves.toBe('b');
  });

  it('falls back to the first admin', async () => {
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['a', 'b'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(resolveDefaultAssigneeUid()).resolves.toBe('a');
  });

  it('returns null rather than throwing when nothing is configured', async () => {
    // Unlike the notification path, an unassigned visit is a WORKING booking.
    // Throwing here would fail the kinfolk's booking over an operator-side gap.
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(resolveDefaultAssigneeUid()).resolves.toBeNull();
  });
});

describe('provisionBusinessAdminsHandler', () => {
  it('includes the caller, which is what bootstraps a solo operator', async () => {
    // The caller passed wrapAdminCallable, so they are an operator by
    // definition. Proves provisioning works with no roster and no env allowlist
    // to copy from, and with no staff/{uid} doc of their own.
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { provisionBusinessAdminsHandler } = await import('../src/admin/provisionBusinessAdmins');

    const res = await provisionBusinessAdminsHandler({ data: {}, auth: { uid: 'op1' } } as never);

    expect(res).toEqual({ ok: true, uids: ['op1'] });
    expect(ctx.writes.find((w) => w.path === DOC)?.data['uids']).toEqual(['op1']);
  });

  it('refuses to add a uid with no staff record', async () => {
    // The roster is a kinfolk-PII distribution list. Proves an arbitrary uid
    // cannot be granted every business notification by typing it in.
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { provisionBusinessAdminsHandler } = await import('../src/admin/provisionBusinessAdmins');

    await expect(
      provisionBusinessAdminsHandler({ data: { uids: ['ghost'] }, auth: { uid: 'op1' } } as never),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('adds a uid that IS on the staff roster', async () => {
    const ctx = buildDbMock({ docs: { 'staff/staff2': { displayName: 'Auntie Dee' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { provisionBusinessAdminsHandler } = await import('../src/admin/provisionBusinessAdmins');

    const res = await provisionBusinessAdminsHandler({
      data: { uids: ['staff2'] },
      auth: { uid: 'op1' },
    } as never);

    expect(res.uids).toEqual(['op1', 'staff2']);
  });

  it('rejects an unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: {} }).db);
    const { provisionBusinessAdminsHandler } = await import('../src/admin/provisionBusinessAdmins');
    await expect(provisionBusinessAdminsHandler({ data: {} } as never)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });
});

describe('setBusinessAdminsHandler', () => {
  it('maps a roster refusal to failed-precondition, not an opaque internal', async () => {
    // A refusal is a contract answer the client can render, and the message
    // already names the way out. Surfacing it as `internal` would waste that.
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1', 'op2'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setBusinessAdminsHandler } = await import('../src/admin/provisionBusinessAdmins');

    await expect(
      setBusinessAdminsHandler({ data: { uids: ['op2'] }, auth: { uid: 'op1' } } as never),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('grandfathers a stored uid that has no staff doc, so a set can KEEP it', async () => {
    // A self-heal from AUNTIE_OPERATOR_UIDS can seed an operator with no
    // staff/{uid} doc. The staff gate applies to ADDITIONS only, or a roster
    // editor could never save without silently dropping them.
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1', 'legacy', 'drop'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setBusinessAdminsHandler } = await import('../src/admin/provisionBusinessAdmins');

    const res = await setBusinessAdminsHandler({
      data: { uids: ['op1', 'legacy'] },
      auth: { uid: 'op1' },
    } as never);

    expect(res.uids).toEqual(['op1', 'legacy']);
    expect(res.removed).toEqual(['drop']);
  });

  it('rejects an empty uids list as invalid-argument, not an opaque internal', async () => {
    // A raw ZodError escaping the handler becomes `internal` ("An error
    // occurred") via wrapCallable AND is captured in Sentry as a server bug.
    // Proves bad input is named as the caller's fault instead.
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setBusinessAdminsHandler } = await import('../src/admin/provisionBusinessAdmins');

    await expect(
      setBusinessAdminsHandler({ data: { uids: [] }, auth: { uid: 'op1' } } as never),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.writes).toHaveLength(0);
  });
});

describe('removeBusinessAdminsHandler', () => {
  it('reports what was revoked and whether the default assignee was cleared', async () => {
    // The response is what lets a UI say "revoked X, assignment fell back"
    // instead of the operator discovering it later.
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1', 'gone'], defaultAssigneeUid: 'gone' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { removeBusinessAdminsHandler } = await import('../src/admin/provisionBusinessAdmins');

    const res = await removeBusinessAdminsHandler({
      data: { uids: ['gone'] },
      auth: { uid: 'op1' },
    } as never);

    expect(res).toEqual({
      ok: true,
      uids: ['op1'],
      removed: ['gone'],
      defaultAssigneeCleared: true,
    });
  });

  it('maps self-removal to failed-precondition', async () => {
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1', 'op2'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { removeBusinessAdminsHandler } = await import('../src/admin/provisionBusinessAdmins');

    await expect(
      removeBusinessAdminsHandler({ data: { uids: ['op1'] }, auth: { uid: 'op1' } } as never),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

describe('checkBusinessAdminsHandler', () => {
  it('reports the outage instead of throwing, so a status surface can render it', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { checkBusinessAdminsHandler } = await import('../src/admin/provisionBusinessAdmins');

    const res = await checkBusinessAdminsHandler({ auth: { uid: 'op1' } } as never);

    expect(res.ok).toBe(false);
    expect(res.uids).toEqual([]);
    expect(res.reason).toMatch(/businessSettings\/admins\.uids is empty/);
  });

  it('reports ok with the roster when notifications can be delivered', async () => {
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { checkBusinessAdminsHandler } = await import('../src/admin/provisionBusinessAdmins');

    await expect(checkBusinessAdminsHandler({ auth: { uid: 'op1' } } as never)).resolves.toEqual({
      ok: true,
      uids: ['op1'],
      reason: null,
    });
  });
});

/**
 * #2223: business notices (payments, invoices and the rest of the office
 * stream) are the owner's. Only owner accounts may be put on the list, and an
 * Auntie or household account already on it receives nothing.
 */
const AUNTIE = { staffRole: 'auntie' };
const DOUBLE_CLAIMED = { admin: true, staffRole: 'auntie' };
const HOUSEHOLD = { role: 'kinfolk', kinfolkId: 'k1' };

function loggedEvents(event: string) {
  return vi
    .mocked(logEvent)
    .mock.calls.map((c) => c[0])
    .filter((f) => f.event === event);
}

describe('#2223 adding to the list: owner accounts only', () => {
  it.each([
    ['an Auntie', AUNTIE, 'auntie-account', /An Auntie cannot be on the business admin list/],
    ['a double-claimed Auntie', DOUBLE_CLAIMED, 'auntie-account', /An Auntie cannot be/],
    ['a household account', HOUSEHOLD, 'household-account', /A household account cannot be/],
    ['an account with neither claim', {}, 'not-owner-account', /Only the owner's accounts/],
    ['a uid with no sign-in account', null, 'not-owner-account', /Only the owner's accounts/],
  ])('add refuses %s and writes nothing', async (_label, claims, refusal, message) => {
    mocks.claims = { someone: claims };
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const err = await addBusinessAdminUids(['someone'], { reason: 'test' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BusinessAdminRosterError);
    expect(err).toMatchObject({ refusal });
    expect((err as Error).message).toMatch(message);
    // Plain words for the operator: no account id, path or function name.
    expect((err as Error).message).not.toMatch(/someone|businessSettings|uids|Business[A-Z]/);
    expect(ctx.writes).toHaveLength(0);
  });

  it('set refuses an Auntie, even one already on the list, and writes nothing', async () => {
    mocks.claims = { a1: AUNTIE };
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1', 'a1'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(setBusinessAdminUids(['op1', 'a1'], { actorUid: 'op1', reason: 'test' })).rejects.toMatchObject({
      refusal: 'auntie-account',
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses when the sign-in accounts cannot be read, and writes nothing', async () => {
    mocks.getUsers.mockRejectedValue(new Error('auth unavailable'));
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(addBusinessAdminUids(['op2'], { reason: 'test' })).rejects.toMatchObject({
      refusal: 'account-check-failed',
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('owner accounts are unchanged: an owner claim, and the allowlist with no claim, are both added', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op-allow';
    mocks.claims = { 'op-claim': { admin: true }, 'op-allow': {} };
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(addBusinessAdminUids(['op-claim', 'op-allow'], { reason: 'test' })).resolves.toEqual([
      'op1',
      'op-claim',
      'op-allow',
    ]);
  });

  it('an owner who also holds a household still counts as an owner', async () => {
    mocks.claims = { op2: { admin: true, role: 'kinfolk', kinfolkId: 'k1' } };
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(addBusinessAdminUids(['op2'], { reason: 'test' })).resolves.toEqual(['op1', 'op2']);
  });

  it('removing an Auntie from the list is never blocked, so a stale list can be cleaned up', async () => {
    mocks.claims = { a1: AUNTIE };
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1', 'a1'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const change = await removeBusinessAdminUids(['a1'], { actorUid: 'op1', reason: 'test' });
    expect(change.uids).toEqual(['op1']);
  });

  it('the provisioning callable refuses an Auntie with the plain message, even one with a staff record', async () => {
    mocks.claims = { a1: AUNTIE };
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1'] }, 'staff/a1': { staffRole: 'auntie' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { provisionBusinessAdminsHandler } = await import('../src/admin/provisionBusinessAdmins');

    const err = await provisionBusinessAdminsHandler({ data: { uids: ['a1'] }, auth: { uid: 'op1' } } as never).catch(
      (e: unknown) => e,
    );

    expect(err).toMatchObject({ code: 'failed-precondition', details: { refusal: 'auntie-account' } });
    expect((err as Error).message).toMatch(/An Auntie cannot be on the business admin list/);
    expect(ctx.writes).toHaveLength(0);
  });

  it('the set callable refuses a household account before the staff-record check', async () => {
    mocks.claims = { h1: HOUSEHOLD };
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { setBusinessAdminsHandler } = await import('../src/admin/provisionBusinessAdmins');

    const err = await setBusinessAdminsHandler({ data: { uids: ['op1', 'h1'] }, auth: { uid: 'op1' } } as never).catch(
      (e: unknown) => e,
    );

    expect(err).toMatchObject({ code: 'failed-precondition', details: { refusal: 'household-account' } });
    expect((err as Error).message).not.toMatch(/staff record/);
    expect(ctx.writes).toHaveLength(0);
  });

  it('the self-heal never writes an Auntie found on the allowlist', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op1,a1';
    mocks.claims = { a1: AUNTIE };
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(resolveBusinessAdminUids('t')).resolves.toEqual(['op1']);
    expect(ctx.writes.find((w) => w.path === DOC)?.data['uids']).toEqual(['op1']);
  });
});

describe('#2223 sending: an Auntie or household already on the list gets no business notice', () => {
  it('skips an Auntie on the list, keeps the owner, and logs a warn', async () => {
    mocks.claims = { a1: AUNTIE };
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1', 'a1', 'op2'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(resolveBusinessAdminUids('recipientResolver(payment.unapplied)')).resolves.toEqual([
      'op1',
      'op2',
    ]);

    const [skip] = loggedEvents('businessAdmins.roster.skipped');
    expect(skip?.severity).toBe('warn');
    expect(skip?.extra).toMatchObject({
      context: 'recipientResolver(payment.unapplied)',
      skipped: [{ uid: 'a1', account: 'auntie' }],
    });
    // Reading is not editing: the stale entry is left for the owner to remove.
    expect(ctx.writes).toHaveLength(0);
  });

  it('skips a household account and a double-claimed Auntie too', async () => {
    mocks.claims = { h1: HOUSEHOLD, d1: DOUBLE_CLAIMED };
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['h1', 'op1', 'd1'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(resolveBusinessAdminUids('t')).resolves.toEqual(['op1']);
  });

  it('a list holding only an Auntie is nobody: recipients-unavailable, never an empty success', async () => {
    mocks.claims = { a1: AUNTIE };
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['a1'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(resolveBusinessAdminUids('t')).rejects.toMatchObject({ code: 'recipients-unavailable' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('a list holding only an Auntie falls through to the allowlist owner, without writing', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op9';
    mocks.claims = { a1: AUNTIE, op9: {} };
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['a1'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(resolveBusinessAdminUids('t')).resolves.toEqual(['op9']);
    expect(ctx.writes).toHaveLength(0);
  });

  it('keeps a uid it has no evidence against: no claims, or no sign-in account', async () => {
    mocks.claims = { bare: {}, gone: null };
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['bare', 'gone'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(resolveBusinessAdminUids('t')).resolves.toEqual(['bare', 'gone']);
    expect(loggedEvents('businessAdmins.roster.skipped')).toHaveLength(0);
  });

  it('when the sign-in accounts cannot be read, the staff record still identifies an Auntie', async () => {
    mocks.getUsers.mockRejectedValue(new Error('auth unavailable'));
    const ctx = buildDbMock({
      docs: { [DOC]: { uids: ['op1', 'a1'] }, 'staff/a1': { staffRole: 'auntie' }, 'staff/op1': { displayName: 'Op' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(resolveBusinessAdminUids('t')).resolves.toEqual(['op1']);
    expect(loggedEvents('businessAdmins.accountLookupFailed')[0]?.severity).toBe('warn');
  });

  it('when neither read works, every uid is kept so the owner is not dropped', async () => {
    mocks.getUsers.mockRejectedValue(new Error('auth unavailable'));
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1', 'a1'] } } });
    ctx.db.getAll = vi.fn(async () => {
      throw new Error('firestore unavailable');
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(resolveBusinessAdminUids('t')).resolves.toEqual(['op1', 'a1']);
    expect(loggedEvents('businessAdmins.staffRecordFallbackFailed')[0]?.severity).toBe('warn');
  });

  it('the status check reports only who actually receives', async () => {
    mocks.claims = { a1: AUNTIE };
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['op1', 'a1'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { checkBusinessAdminsHandler } = await import('../src/admin/provisionBusinessAdmins');

    await expect(checkBusinessAdminsHandler({ auth: { uid: 'op1' } } as never)).resolves.toMatchObject({
      ok: true,
      uids: ['op1'],
    });
  });

  it('the default assignee is not filtered: an Auntie may still be assigned visits', async () => {
    mocks.claims = { a1: AUNTIE };
    const ctx = buildDbMock({ docs: { [DOC]: { uids: ['a1', 'op1'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(resolveDefaultAssigneeUid()).resolves.toBe('a1');
  });
});
