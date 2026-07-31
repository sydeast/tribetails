import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const h = vi.hoisted(() => ({ audit: vi.fn(), dbFn: vi.fn() }));

vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: h.audit }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: h.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));

import { cleanupExpiredShareLinksCore } from '../src/scheduled/cleanupExpiredShareLinks';

const NOW = new Date('2026-07-30T03:00:00.000Z');
const PAST = new Date('2026-07-01T00:00:00.000Z');
const FUTURE = new Date('2026-08-30T00:00:00.000Z');

/**
 * The nightly share-link sweep had no test at all: its query was welded into the
 * `onSchedule` wrapper, so there was nothing to call. It is the same shape as
 * `expireStaleInvites` (an equality filter, a `<` range filter, and a 500-doc
 * page), which is the pair the 2026-07-23 review flagged as a live hazard:
 * flipping `<` to `>` revokes every share link that is still valid, and
 * dropping the `revoked` predicate re-audits links that were already revoked.
 *
 * The fixture is deliberately mixed: two links that MUST be revoked sitting next
 * to four that MUST survive, so a broken predicate changes the write log rather
 * than merely shrinking it.
 */
function buildShareDb(rows: Array<{ id: string; data: Record<string, unknown> }>) {
  return buildDbMock({ queryDocs: { sharedKinTales: rows } });
}

const EXPIRED_LIVE = {
  id: 's1',
  data: { revoked: false, tribeId: 't1', kinTaleId: 'k1', expiresAt: PAST },
};
const EXPIRED_LIVE_2 = {
  id: 's2',
  data: { revoked: false, tribeId: 't2', kinTaleId: 'k2', expiresAt: PAST },
};
/** Already revoked. Re-revoking these writes a second CONTENT_SHARE_LINK_EXPIRED per night. */
const ALREADY_REVOKED = {
  id: 's3',
  data: { revoked: true, tribeId: 't3', kinTaleId: 'k3', expiresAt: PAST },
};
/** Still inside its window. Revoking these kills links Kinfolk are actively sharing. */
const UNEXPIRED = {
  id: 's4',
  data: { revoked: false, tribeId: 't4', kinTaleId: 'k4', expiresAt: FUTURE },
};
/** Never-expiring link: no `expiresAt`, so Firestore's range filter never sees it. */
const NO_EXPIRES_AT = {
  id: 's5',
  data: { revoked: false, tribeId: 't5', kinTaleId: 'k5' },
};
/**
 * No `revoked` field at all. The equality filter is index-backed, so this doc is
 * invisible to the sweep however stale it is. Pinned as the behaviour that ships
 * today, not as the behaviour anyone asked for.
 */
const NO_REVOKED_FIELD = {
  id: 's6',
  data: { tribeId: 't6', kinTaleId: 'k6', expiresAt: PAST },
};

const FULL_SET = [
  EXPIRED_LIVE,
  EXPIRED_LIVE_2,
  ALREADY_REVOKED,
  UNEXPIRED,
  NO_EXPIRES_AT,
  NO_REVOKED_FIELD,
];

beforeEach(() => {
  h.audit.mockReset();
  h.audit.mockResolvedValue('audit-1');
  h.dbFn.mockReset();
});

describe('cleanupExpiredShareLinksCore', () => {
  it('HAPPY: revokes each expired live link and audits it against its tribe', async () => {
    const ctx = buildShareDb(FULL_SET);
    h.dbFn.mockReturnValue(ctx.db);

    const r = await cleanupExpiredShareLinksCore(NOW);

    expect(r.revoked).toBe(2);
    expect(ctx.writes.map((w) => w.path)).toEqual([
      'sharedKinTales/s1',
      'sharedKinTales/s2',
    ]);
    expect(ctx.writes.map((w) => w.data)).toEqual([{ revoked: true }, { revoked: true }]);
    expect(h.audit).toHaveBeenCalledTimes(2);
    expect(h.audit.mock.calls[0][0]).toMatchObject({
      event: 'CONTENT_SHARE_LINK_EXPIRED',
      severity: 'info',
      actorRole: 'SYSTEM',
      familyId: 't1',
      payload: { shareId: 's1' },
    });
    expect(h.audit.mock.calls[1][0]).toMatchObject({ familyId: 't2', payload: { shareId: 's2' } });
  });

  it('STATE BOUNDARY: leaves revoked, unexpired, and never-expiring links alone', async () => {
    const ctx = buildShareDb(FULL_SET);
    h.dbFn.mockReturnValue(ctx.db);

    await cleanupExpiredShareLinksCore(NOW);

    const touched = ctx.writes.map((w) => w.path);
    for (const id of ['s3', 's4', 's5', 's6']) {
      expect(touched, `share link ${id} must survive the sweep`).not.toContain(
        `sharedKinTales/${id}`,
      );
    }
    const audited = h.audit.mock.calls.map(
      (c) => (c[0] as { payload: { shareId: string } }).payload.shareId,
    );
    expect(audited).toEqual(['s1', 's2']);
  });

  it('BOUNDARY: a link expiring exactly at `now` is left for the next run', async () => {
    // `<` is strict, so the tick itself is not yet past. Pins the operator, not
    // just its direction.
    const ctx = buildShareDb([
      { id: 's7', data: { revoked: false, tribeId: 't7', expiresAt: NOW } },
    ]);
    h.dbFn.mockReturnValue(ctx.db);

    const r = await cleanupExpiredShareLinksCore(NOW);

    expect(r.revoked).toBe(0);
    expect(ctx.writes).toHaveLength(0);
  });

  it('NEGATIVE: nothing expired -> no writes and no audit entries', async () => {
    const ctx = buildShareDb([ALREADY_REVOKED, UNEXPIRED, NO_EXPIRES_AT]);
    h.dbFn.mockReturnValue(ctx.db);

    const r = await cleanupExpiredShareLinksCore(NOW);

    expect(r.revoked).toBe(0);
    expect(ctx.writes).toHaveLength(0);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('PAGE SIZE: one run drains at most the 500-doc page the query asks for', async () => {
    const rows = Array.from({ length: 620 }, (_, i) => ({
      id: `p${String(i).padStart(3, '0')}`,
      data: { revoked: false, tribeId: `t${i}`, expiresAt: PAST },
    }));
    const ctx = buildShareDb(rows);
    h.dbFn.mockReturnValue(ctx.db);

    const r = await cleanupExpiredShareLinksCore(NOW);

    expect(r.revoked).toBe(500);
    expect(ctx.writes).toHaveLength(500);
    expect(h.audit).toHaveBeenCalledTimes(500);
  });
});
