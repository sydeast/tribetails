import { describe, it, expect, vi } from 'vitest';

const getMock = vi.fn();
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({ doc: () => ({ get: getMock }), runTransaction: vi.fn() }),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn() }));
vi.mock('argon2', () => ({ default: { hash: vi.fn().mockResolvedValue('h'), argon2id: 2 } }));

describe('approveTribePinChangeHandler', () => {
  it('rejects invalid args', async () => {
    const { approveTribePinChangeHandler } = await import('../src/admin/approveTribePinChange');
    await expect(
      approveTribePinChangeHandler({ data: { familyId: 'f' }, auth: { uid: 'u' } } as any),
    ).rejects.toThrow();
  });

  it('throws failed-precondition when no pending change', async () => {
    getMock.mockResolvedValueOnce({ exists: true, data: () => ({ flags: { tribePinChangePending: false } }) });
    const { approveTribePinChangeHandler } = await import('../src/admin/approveTribePinChange');
    await expect(
      approveTribePinChangeHandler({
        data: { familyId: 'f', requestId: 'r', newPlaintextPin: '1234' },
        auth: { uid: 'u' },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});
