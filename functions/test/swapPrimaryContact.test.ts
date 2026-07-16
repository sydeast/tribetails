import { describe, it, expect, vi, beforeEach } from 'vitest';

const docGet = vi.fn();
const docUpdate = vi.fn().mockResolvedValue(undefined);
const auditMock = vi.fn().mockResolvedValue('a');

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({ doc: () => ({ get: docGet, update: docUpdate }) }),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: auditMock }));

beforeEach(() => {
  docGet.mockReset();
  docUpdate.mockClear();
  auditMock.mockClear();
});

describe('swapPrimaryContactHandler', () => {
  it('rejects when client missing', async () => {
    docGet.mockResolvedValue({ exists: false });
    const { swapPrimaryContactHandler } = await import('../src/recovery/swapPrimaryContact');
    await expect(
      swapPrimaryContactHandler({
        auth: { uid: 'u1' },
        data: { newEmail: 'a@b.com' },
      } as any),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects within 24h since last swap', async () => {
    docGet.mockResolvedValue({
      exists: true,
      data: () => ({ lastContactSwapAt: { toMillis: () => Date.now() - 60000 } }),
    });
    const { swapPrimaryContactHandler } = await import('../src/recovery/swapPrimaryContact');
    await expect(
      swapPrimaryContactHandler({
        auth: { uid: 'u1' },
        data: { newEmail: 'a@b.com' },
      } as any),
    ).rejects.toMatchObject({ code: 'resource-exhausted' });
  });

  it('happy path swaps email', async () => {
    docGet.mockResolvedValue({ exists: true, data: () => ({}) });
    const { swapPrimaryContactHandler } = await import('../src/recovery/swapPrimaryContact');
    const r = await swapPrimaryContactHandler({
      auth: { uid: 'u1' },
      data: { newEmail: 'new@b.com' },
    } as any);
    expect(r.ok).toBe(true);
    const arg = docUpdate.mock.calls[0][0];
    expect(arg.email).toBe('new@b.com');
    expect(auditMock).toHaveBeenCalled();
  });
});
