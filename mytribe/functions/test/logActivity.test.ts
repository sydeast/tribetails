import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  writeAuditEntryMock: vi.fn(),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({
  writeAuditEntry: mocks.writeAuditEntryMock,
}));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));

import { logActivityHandler } from '../src/admin/logActivity';
const writeAuditEntryMock = mocks.writeAuditEntryMock;

function req(data: unknown, uid: string | undefined = 'admin-1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } } as never) : undefined,
    rawRequest: {} as never,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

beforeEach(() => {
  writeAuditEntryMock.mockClear();
  writeAuditEntryMock.mockResolvedValue('audit-entry-1');
});

describe('logActivityHandler', () => {
  it('forwards canonical fields to writeAuditEntry and returns entry id', async () => {
    const result = await logActivityHandler(
      req({
        actionType: 'KINFOLK_UPDATED',
        description: 'updated profile',
        status: 'SUCCESS',
        actorId: 'admin-1',
        targetId: 'kf-42',
        targetCollection: 'kinfolk',
      }),
    );
    expect(result).toEqual({ ok: true, entryId: 'audit-entry-1' });
    expect(writeAuditEntryMock).toHaveBeenCalledOnce();
    const args = writeAuditEntryMock.mock.calls[0][0];
    expect(args.event).toBe('KINFOLK_UPDATED');
    expect(args.severity).toBe('info');
    expect(args.actorRole).toBe('PRIMARY');
    expect(args.actorUid).toBe('admin-1');
    expect(args.targetUid).toBe('kf-42');
    expect(args.targetCollection).toBe('kinfolk');
    expect(args.description).toBe('updated profile');
    expect(args.status).toBe('SUCCESS');
  });

  it('rejects non-SCREAMING_SNAKE actionType', async () => {
    await expect(
      logActivityHandler(req({ actionType: 'kinfolk.updated' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(writeAuditEntryMock).not.toHaveBeenCalled();
  });

  it('rejects empty actionType', async () => {
    await expect(logActivityHandler(req({ actionType: '' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('rejects invalid status value', async () => {
    await expect(
      logActivityHandler(req({ actionType: 'TEST_EVENT', status: 'BANANA' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('uses caller uid as actor when description omitted (default description = actionType)', async () => {
    await logActivityHandler(req({ actionType: 'AUTH_LOGIN_SUCCESS' }));
    const args = writeAuditEntryMock.mock.calls[0][0];
    expect(args.actorUid).toBe('admin-1');
    expect(args.description).toBe('AUTH_LOGIN_SUCCESS');
  });

  it('captures supplied actorId in description when it diverges from caller uid', async () => {
    await logActivityHandler(
      req({ actionType: 'ADMIN_IMPERSONATION', actorId: 'other-user-xyz' }),
    );
    const args = writeAuditEntryMock.mock.calls[0][0];
    // True actor is still the caller (admin-1); divergent client claim is
    // appended to description for forensic correlation.
    expect(args.actorUid).toBe('admin-1');
    expect(args.description).toContain('client-actor=other-user-xyz');
  });

  it('maps status=FAILURE to severity=warn', async () => {
    await logActivityHandler(
      req({ actionType: 'SOMETHING_FAILED', status: 'FAILURE' }),
    );
    const args = writeAuditEntryMock.mock.calls[0][0];
    expect(args.severity).toBe('warn');
  });

  it('omits targetUid when targetId blank', async () => {
    await logActivityHandler(req({ actionType: 'TEST_EVENT', targetId: '' }));
    const args = writeAuditEntryMock.mock.calls[0][0];
    expect(args.targetUid).toBeUndefined();
  });
});
