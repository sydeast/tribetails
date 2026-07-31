import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const h = vi.hoisted(() => ({ dbFn: vi.fn(), sendFn: vi.fn() }));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: h.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sendFromTemplate', () => ({ sendFromTemplate: h.sendFn }));

import { errorDailyDigestCore } from '../src/scheduled/errorDailyDigest';

const NOW = new Date('2026-07-31T08:00:00.000Z');
const WITHIN_WINDOW = new Date('2026-07-31T02:00:00.000Z');
const OUTSIDE_WINDOW = new Date('2026-07-29T00:00:00.000Z');

/**
 * errorDailyDigest queried a collection ('auditLog') and fields ('event',
 * 'severity') that the only writer, writeAuditEntry.ts, has never used: it
 * writes to `activity_log` with `actionType` and `status`. The digest has
 * never matched a document since it shipped. The fixture below seeds
 * `activity_log` (the real collection) and proves the fixed query selects
 * FAILURE-status rows in the window and skips everything else.
 *
 * `WARN_BUT_SUCCESS` is the case that makes `severity` the wrong failure
 * filter even after the collection/field names are fixed: SECRETS_TRIBEPIN_SET
 * (src/admin/*.ts) is written with `severity: 'warn'` for admin-visibility
 * reasons, not because anything failed, and its `status` is SUCCESS (the
 * writer's default for non-critical severity). A filter on `severity in
 * ['warn','critical']` would wrongly sweep it into the digest; `status ==
 * 'FAILURE'` does not.
 */
function buildLogDb(rows: Array<{ id: string; data: Record<string, unknown> }>) {
  return buildDbMock({ queryDocs: { activity_log: rows } });
}

const REAL_FAILURE = {
  id: 'a1',
  data: {
    actionType: 'AUTH_LOGIN_FAIL', status: 'FAILURE', severity: 'warn',
    familyId: 'fam1', createdAt: WITHIN_WINDOW,
  },
};
const REAL_SUCCESS = {
  id: 'a2',
  data: {
    actionType: 'MEMBERSHIP_INVITE_SENT', status: 'SUCCESS', severity: 'info',
    familyId: 'fam2', createdAt: WITHIN_WINDOW,
  },
};
/** warn severity, SUCCESS status: the old severity-based filter's false positive. */
const WARN_BUT_SUCCESS = {
  id: 'a3',
  data: {
    actionType: 'SECRETS_TRIBEPIN_SET', status: 'SUCCESS', severity: 'warn',
    familyId: 'fam3', createdAt: WITHIN_WINDOW,
  },
};
/** A real failure, but from before the 24h cutoff. */
const OLD_FAILURE = {
  id: 'a4',
  data: {
    actionType: 'AUTH_LOGIN_FAIL', status: 'FAILURE', severity: 'warn',
    familyId: 'fam4', createdAt: OUTSIDE_WINDOW,
  },
};

const FULL_SET = [REAL_FAILURE, REAL_SUCCESS, WARN_BUT_SUCCESS, OLD_FAILURE];

beforeEach(() => {
  h.dbFn.mockReset();
  h.sendFn.mockReset();
  h.sendFn.mockResolvedValue('sent-1');
  process.env.AUNTIE_NOTIFY_EMAIL = 'ops@tribetails.com';
});

describe('errorDailyDigestCore', () => {
  it('HAPPY: selects failures inside the window and skips successes', async () => {
    const ctx = buildLogDb(FULL_SET);
    h.dbFn.mockReturnValue(ctx.db);

    const r = await errorDailyDigestCore(NOW);

    expect(r.total).toBe(1);
    expect(h.sendFn).toHaveBeenCalledTimes(1);
    const [key, to, data] = h.sendFn.mock.calls[0] as [string, string, { summary: string }];
    expect(key).toBe('error.daily-digest');
    expect(to).toBe('ops@tribetails.com');
    expect(data.summary).toContain('AUTH_LOGIN_FAIL');
    expect(data.summary).toContain('fam1');
    expect(data.summary).not.toContain('fam2');
    expect(data.summary).not.toContain('fam3');
    expect(data.summary).not.toContain('fam4');
  });

  it('STATE BOUNDARY: a success with warn severity never counts as a failure', async () => {
    const ctx = buildLogDb([WARN_BUT_SUCCESS]);
    h.dbFn.mockReturnValue(ctx.db);

    const r = await errorDailyDigestCore(NOW);

    expect(r.total).toBe(0);
    expect(h.sendFn).not.toHaveBeenCalled();
  });

  it('NEGATIVE: no failures in the window -> no email sent', async () => {
    const ctx = buildLogDb([REAL_SUCCESS, OLD_FAILURE]);
    h.dbFn.mockReturnValue(ctx.db);

    const r = await errorDailyDigestCore(NOW);

    expect(r.total).toBe(0);
    expect(r.sent).toBe(false);
    expect(h.sendFn).not.toHaveBeenCalled();
  });

  it('CONFIG: without AUNTIE_NOTIFY_EMAIL, skips the query and the send entirely', async () => {
    delete process.env.AUNTIE_NOTIFY_EMAIL;
    const ctx = buildLogDb(FULL_SET);
    h.dbFn.mockReturnValue(ctx.db);

    const r = await errorDailyDigestCore(NOW);

    expect(r.sent).toBe(false);
    expect(h.dbFn).not.toHaveBeenCalled();
    expect(h.sendFn).not.toHaveBeenCalled();
  });

  it('ORDERING: the summary lists the most recent failures first', async () => {
    const older = { id: 'o1', data: { actionType: 'AUTH_LOGIN_FAIL', status: 'FAILURE', familyId: 'old', createdAt: new Date('2026-07-31T01:00:00.000Z') } };
    const newer = { id: 'o2', data: { actionType: 'AUTH_LOGIN_FAIL', status: 'FAILURE', familyId: 'new', createdAt: new Date('2026-07-31T07:00:00.000Z') } };
    const ctx = buildLogDb([older, newer]);
    h.dbFn.mockReturnValue(ctx.db);

    await errorDailyDigestCore(NOW);

    const [, , data] = h.sendFn.mock.calls[0] as [string, string, { summary: string }];
    expect(data.summary.indexOf('fid=new')).toBeLessThan(data.summary.indexOf('fid=old'));
  });

  it('PAGE SIZE: truncates at 1000 and says so, keeping the most recent', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({
      id: `p${String(i).padStart(4, '0')}`,
      data: {
        actionType: 'AUTH_LOGIN_FAIL',
        status: 'FAILURE',
        familyId: `t${i}`,
        // Ascending: row i is i minutes after WITHIN_WINDOW, so the highest i is newest.
        createdAt: new Date(WITHIN_WINDOW.getTime() + i * 60_000),
      },
    }));
    const ctx = buildLogDb(rows);
    h.dbFn.mockReturnValue(ctx.db);

    const r = await errorDailyDigestCore(NOW);

    expect(r.total).toBe(1000);
    expect(r.truncated).toBe(true);
    const [, , data] = h.sendFn.mock.calls[0] as [string, string, { summary: string }];
    // Newest of the 1200 is index 1199; truncation keeps the most recent page.
    expect(data.summary).toContain('t1199');
  });
});
