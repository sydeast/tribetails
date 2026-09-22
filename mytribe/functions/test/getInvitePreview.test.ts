import { describe, it, expect, vi, beforeEach } from 'vitest';

const docGet = vi.fn();

vi.mock('../src/lib/rateLimit', () => ({ enforceRateLimit: vi.fn().mockResolvedValue(undefined) }));
// #910: these requests carry no X-Forwarded-For, so clientIpOf logs an error.
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/notifications', () => ({ enqueueNotification: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({
    doc: (p: string) => ({ get: vi.fn().mockImplementation(() => docGet(p)) }),
  }),
}));

beforeEach(() => {
  docGet.mockReset();
});

function inviteSnap(data: Record<string, unknown> | null) {
  return { exists: data !== null, data: () => data };
}

describe('getInvitePreviewHandler', () => {
  it('returns valid preview with invited email and tribe name', async () => {
    docGet.mockImplementation((p: string) => {
      if (p === 'inviteRequests/i1') {
        return inviteSnap({
          status: 'EMAIL_SENT',
          invitedEmail: 'kin@example.com',
          tribeId: 't1',
          expiresAt: { toMillis: () => Date.now() + 100000 },
        });
      }
      if (p === 'families/t1') return inviteSnap({ displayName: 'The Parkers' });
      return inviteSnap(null);
    });
    const { getInvitePreviewHandler } = await import('../src/portal/getInvitePreview');
    const res = await getInvitePreviewHandler({ data: { inviteId: 'i1' } } as any);
    expect(res).toEqual({ status: 'valid', invitedEmail: 'kin@example.com', tribeName: 'The Parkers' });
  });

  it('treats PENDING as valid too', async () => {
    docGet.mockImplementation((p: string) =>
      p === 'inviteRequests/i1'
        ? inviteSnap({
            status: 'PENDING',
            invitedEmail: 'kin@example.com',
            tribeId: 't1',
            expiresAt: { toMillis: () => Date.now() + 100000 },
          })
        : inviteSnap(null),
    );
    const { getInvitePreviewHandler } = await import('../src/portal/getInvitePreview');
    const res = await getInvitePreviewHandler({ data: { inviteId: 'i1' } } as any);
    expect(res.status).toBe('valid');
  });

  it('returns not_found without leaking anything for unknown id', async () => {
    docGet.mockResolvedValue(inviteSnap(null));
    const { getInvitePreviewHandler } = await import('../src/portal/getInvitePreview');
    const res = await getInvitePreviewHandler({ data: { inviteId: 'nope' } } as any);
    expect(res).toEqual({ status: 'not_found' });
  });

  it('returns expired when past expiresAt (no email leak)', async () => {
    docGet.mockImplementation((p: string) =>
      p === 'inviteRequests/i1'
        ? inviteSnap({
            status: 'EMAIL_SENT',
            invitedEmail: 'kin@example.com',
            tribeId: 't1',
            expiresAt: { toMillis: () => Date.now() - 1000 },
          })
        : inviteSnap(null),
    );
    const { getInvitePreviewHandler } = await import('../src/portal/getInvitePreview');
    const res = await getInvitePreviewHandler({ data: { inviteId: 'i1' } } as any);
    expect(res).toEqual({ status: 'expired' });
  });

  it('returns claimed for ACCEPTED invites', async () => {
    docGet.mockImplementation((p: string) =>
      p === 'inviteRequests/i1'
        ? inviteSnap({
            status: 'ACCEPTED',
            invitedEmail: 'kin@example.com',
            tribeId: 't1',
            expiresAt: { toMillis: () => Date.now() + 100000 },
          })
        : inviteSnap(null),
    );
    const { getInvitePreviewHandler } = await import('../src/portal/getInvitePreview');
    const res = await getInvitePreviewHandler({ data: { inviteId: 'i1' } } as any);
    expect(res).toEqual({ status: 'claimed' });
  });

  it('returns revoked for REVOKED/EXPIRED statuses', async () => {
    docGet.mockImplementation((p: string) =>
      p === 'inviteRequests/i1'
        ? inviteSnap({
            status: 'REVOKED',
            invitedEmail: 'kin@example.com',
            tribeId: 't1',
            expiresAt: { toMillis: () => Date.now() + 100000 },
          })
        : inviteSnap(null),
    );
    const { getInvitePreviewHandler } = await import('../src/portal/getInvitePreview');
    const res = await getInvitePreviewHandler({ data: { inviteId: 'i1' } } as any);
    expect(res).toEqual({ status: 'revoked' });
  });

  it('rejects malformed args', async () => {
    const { getInvitePreviewHandler } = await import('../src/portal/getInvitePreview');
    await expect(getInvitePreviewHandler({ data: {} } as any)).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });
});
