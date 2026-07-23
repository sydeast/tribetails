import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import {
  resolveBusinessAdminUids,
  resolveDefaultAssigneeUid,
  writeBusinessAdminUids,
} from '../src/lib/businessAdmins';

const ORIGINAL_ENV = process.env.AUNTIE_OPERATOR_UIDS;

beforeEach(() => {
  mocks.dbFn.mockReset();
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.AUNTIE_OPERATOR_UIDS;
  else process.env.AUNTIE_OPERATOR_UIDS = ORIGINAL_ENV;
});

/**
 * `businessSettings/admins` had two readers and no writer, and did not exist in
 * prod. 16 catalog keys name `businessAdmins` as their PRIMARY resolver, so
 * every business notification threw "cannot dispatch" and the operator was
 * never told a booking had been requested.
 */
describe('resolveBusinessAdminUids', () => {
  it('returns the stored roster when the doc has one', async () => {
    const ctx = buildDbMock({ docs: { 'businessSettings/admins': { uids: ['op1', 'op2'] } } });
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
    const write = ctx.writes.find((w) => w.path === 'businessSettings/admins');
    expect(write?.data.uids).toEqual(['op1', 'op2']);
    expect(write?.merge).toBe(true);
  });

  it('treats an empty uids array the same as a missing doc', async () => {
    const ctx = buildDbMock({ docs: { 'businessSettings/admins': { uids: [] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(resolveBusinessAdminUids('t')).rejects.toThrow(/is empty/);
  });

  it('prefers the stored roster over the env allowlist', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'env-only';
    const ctx = buildDbMock({ docs: { 'businessSettings/admins': { uids: ['stored'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(resolveBusinessAdminUids('t')).resolves.toEqual(['stored']);
  });
});

describe('writeBusinessAdminUids', () => {
  it('unions with the stored roster and never narrows it', async () => {
    const ctx = buildDbMock({ docs: { 'businessSettings/admins': { uids: ['existing'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await writeBusinessAdminUids(['added'], { reason: 'test' });

    const write = ctx.writes.find((w) => w.path === 'businessSettings/admins');
    expect(write?.data.uids).toEqual(['existing', 'added']);
  });

  it('does not overwrite a defaultAssigneeUid the operator already chose', async () => {
    const ctx = buildDbMock({
      docs: { 'businessSettings/admins': { uids: ['a'], defaultAssigneeUid: 'chosen' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await writeBusinessAdminUids(['b'], { defaultAssigneeUid: 'other', reason: 'test' });

    const write = ctx.writes.find((w) => w.path === 'businessSettings/admins');
    expect(write?.data.defaultAssigneeUid).toBe('chosen');
  });

  it('is idempotent: the same call twice leaves one roster', async () => {
    const ctx = buildDbMock({ docs: { 'businessSettings/admins': { uids: ['a'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await writeBusinessAdminUids(['a'], { reason: 'test' });
    const write = ctx.writes.find((w) => w.path === 'businessSettings/admins');
    expect(write?.data.uids).toEqual(['a']);
  });

  it('writes nothing when there is nothing to write', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(writeBusinessAdminUids([], { reason: 'test' })).resolves.toEqual([]);
    expect(ctx.writes).toHaveLength(0);
  });
});

describe('resolveDefaultAssigneeUid', () => {
  it('prefers an explicit defaultAssigneeUid', async () => {
    const ctx = buildDbMock({
      docs: { 'businessSettings/admins': { uids: ['a', 'b'], defaultAssigneeUid: 'b' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(resolveDefaultAssigneeUid()).resolves.toBe('b');
  });

  it('falls back to the first admin', async () => {
    const ctx = buildDbMock({ docs: { 'businessSettings/admins': { uids: ['a', 'b'] } } });
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
