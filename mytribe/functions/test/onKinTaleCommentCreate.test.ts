import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  enqueue: vi.fn().mockResolvedValue(undefined),
  resolveUid: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/wrapTrigger', () => ({
  wrapTrigger: (_name: string, fn: (...args: unknown[]) => unknown) => fn,
}));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));

beforeEach(() => {
  mocks.enqueue.mockReset().mockResolvedValue(undefined);
  mocks.resolveUid.mockReset();
  mocks.dbFn.mockReset();
});

import { onKinTaleCommentCreateHandler } from '../src/triggers/onKinTaleCommentCreate';

describe('onKinTaleCommentCreate trigger', () => {
  it('reads kinfolkId from parent report and dispatches kintale.comment.added for admin authors', async () => {
    const ctx = buildDbMock({
      docs: { 'kin_care_reports/r1': { kinfolkId: 'fam3' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.resolveUid.mockResolvedValue('uid_kinfolk');

    await onKinTaleCommentCreateHandler({
      params: { reportId: 'r1', commentId: 'c1' },
      data: {
        data: () => ({ authorUid: 'admin1', authorRole: 'admin', body: 'Great job!' }),
      },
    } as any);

    expect(mocks.resolveUid).toHaveBeenCalledWith('fam3');
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'kintale.comment.added',
        recipientUid: 'uid_kinfolk',
        data: expect.objectContaining({ kinfolkId: 'fam3', taleId: 'r1', commentId: 'c1' }),
      }),
    );
  });

  it('dispatches kintale.comment.added for kinfolk-authored comments', async () => {
    const ctx = buildDbMock({
      docs: { 'kin_care_reports/r1': { kinfolkId: 'fam3' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.resolveUid.mockResolvedValue('uid_kinfolk');

    await onKinTaleCommentCreateHandler({
      params: { reportId: 'r1', commentId: 'cKin' },
      data: {
        data: () => ({ authorUid: 'kinUid', authorRole: 'kinfolk', body: 'thanks!' }),
      },
    } as any);

    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'kintale.comment.added',
        recipientUid: 'uid_kinfolk',
      }),
    );
  });

  it('skips dispatch when parent report has no kinfolkId', async () => {
    const ctx = buildDbMock({
      docs: { 'kin_care_reports/r1': {} },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await onKinTaleCommentCreateHandler({
      params: { reportId: 'r1', commentId: 'c1' },
      data: { data: () => ({ body: 'hi' }) },
    } as any);

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  describe('#1898: the notice names who commented and on which KinTale', () => {
    async function dataFor(comment: Record<string, unknown>, docs: Record<string, Record<string, unknown>> = {}) {
      const ctx = buildDbMock({
        docs: { 'kin_care_reports/r1': { kinfolkId: 'fam3', title: 'Park day' }, ...docs },
      });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.resolveUid.mockResolvedValue('uid_kinfolk');
      await onKinTaleCommentCreateHandler({
        params: { reportId: 'r1', commentId: 'c1' },
        data: { data: () => comment },
      } as any);
      return (mocks.enqueue.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    }
    it('a guest by the name they typed, and the tale by its title', async () => {
      const data = await dataFor({ guestName: 'Grandma Jo', body: 'So cute!' });
      expect(data.authorName).toBe('Grandma Jo');
      expect(data.taleTitle).toBe('Park day');
    });
    it('an Auntie as "Auntie" and her staff name', async () => {
      const data = await dataFor(
        { authorUid: 'admin1', authorRole: 'admin', body: 'Thank you!' },
        { 'staff/admin1': { displayName: 'Sam', email: 'e2e-admin@tribetails.com' } },
      );
      expect(data.authorName).toBe('Auntie Sam');
    });
    it('a household member by first name, never by email', async () => {
      const data = await dataFor(
        { authorUid: 'kinUid', authorRole: 'kinfolk', body: 'thanks!' },
        { 'families/fam3/members/kinUid': { displayName: 'Dana Ruiz', email: 'pawsome@hanasamku.com' } },
      );
      expect(data.authorName).toBe('Dana');
      expect(JSON.stringify(data)).not.toContain('@');
    });
    it('a staff or member name that is really an email leaves the author unnamed', async () => {
      const staff = await dataFor(
        { authorUid: 'admin1', authorRole: 'admin', body: 'Thank you!' },
        { 'staff/admin1': { displayName: 'e2e-admin@tribetails.com' } },
      );
      expect(staff.authorName).toBe('');
      mocks.enqueue.mockClear();
      const member = await dataFor(
        { authorUid: 'kinUid', authorRole: 'kinfolk', body: 'thanks!' },
        { 'clients/kinUid': { displayName: 'pawsome@hanasamku.com' } },
      );
      expect(member.authorName).toBe('');
      expect(JSON.stringify([staff, member])).not.toContain('@');
    });
    it('an author nothing names is left unnamed, and the tale with no title has none', async () => {
      const data = await dataFor(
        { authorUid: 'ghost', authorRole: 'kinfolk', body: 'hi' },
        { 'kin_care_reports/r1': { kinfolkId: 'fam3' } },
      );
      expect(data.authorName).toBe('');
      expect(data.taleTitle).toBe('');
    });
  });
});
