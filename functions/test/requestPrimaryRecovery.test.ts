import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

const txGet = vi.fn();
const txSet = vi.fn();
const runTransaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ get: txGet, set: txSet }));
const collectionAdd = vi.fn().mockResolvedValue({ id: 'rec-1' });
const sendMock = vi.fn().mockResolvedValue('m-1');
const auditMock = vi.fn().mockResolvedValue('a1');

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({
    doc: () => ({}),
    collection: () => ({ add: collectionAdd }),
    runTransaction,
  }),
}));
vi.mock('../src/lib/sendFromTemplate', () => ({ sendFromTemplate: sendMock }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: auditMock }));

beforeEach(() => {
  txGet.mockReset();
  txSet.mockReset();
  collectionAdd.mockClear();
  sendMock.mockClear();
  auditMock.mockClear();
  delete process.env.AUNTIE_NOTIFY_EMAIL;
});

const baseReq = {
  auth: undefined,
  rawRequest: { ip: '1.2.3.4' },
  data: { familyId: 'f1', contactMethod: 'email', newContact: 'a@b.com' },
} as never;

describe('requestPrimaryRecoveryHandler', () => {
  it('happy path writes recoveryRequest and audit', async () => {
    txGet.mockResolvedValue({ data: () => ({ hits: [] }) });
    const { requestPrimaryRecoveryHandler } = await import('../src/recovery/requestPrimaryRecovery');
    const out = await requestPrimaryRecoveryHandler(baseReq);
    expect(out.ok).toBe(true);
    expect(collectionAdd).toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('WARNING-20: stores the real sha256 of the contact (not a constant), differing per input', async () => {
    txGet.mockResolvedValue({ data: () => ({ hits: [] }) });
    const { requestPrimaryRecoveryHandler } = await import('../src/recovery/requestPrimaryRecovery');

    await requestPrimaryRecoveryHandler({
      auth: undefined,
      rawRequest: { ip: '1.2.3.4' },
      data: { familyId: 'f1', contactMethod: 'email', newContact: '  NewMom@X.com  ' },
    } as never);
    const firstWrite = collectionAdd.mock.calls.at(-1)![0] as { newContactHash: string };
    const expected = crypto.createHash('sha256').update('newmom@x.com').digest('hex');
    expect(firstWrite.newContactHash).toBe(expected);
    expect(firstWrite.newContactHash).not.toBe('sha256:redacted');
    expect(firstWrite.newContactHash).toMatch(/^[a-f0-9]{64}$/);

    // A different contact yields a different hash (placeholder bug would collide).
    await requestPrimaryRecoveryHandler({
      auth: undefined,
      rawRequest: { ip: '1.2.3.4' },
      data: { familyId: 'f1', contactMethod: 'phone', newContact: '+15551234567' },
    } as never);
    const secondWrite = collectionAdd.mock.calls.at(-1)![0] as { newContactHash: string };
    expect(secondWrite.newContactHash).not.toBe(firstWrite.newContactHash);
  });

  it('rate-limited rejects when hits >= limit within window', async () => {
    const recent = [Date.now() - 100, Date.now() - 200, Date.now() - 300];
    txGet.mockResolvedValue({ data: () => ({ hits: recent }) });
    const { requestPrimaryRecoveryHandler } = await import('../src/recovery/requestPrimaryRecovery');
    await expect(requestPrimaryRecoveryHandler(baseReq)).rejects.toMatchObject({ code: 'resource-exhausted' });
  });

  it('sends email when AUNTIE_NOTIFY_EMAIL set', async () => {
    process.env.AUNTIE_NOTIFY_EMAIL = 'auntie@x.com';
    txGet.mockResolvedValue({ data: () => undefined });
    const { requestPrimaryRecoveryHandler } = await import('../src/recovery/requestPrimaryRecovery');
    await requestPrimaryRecoveryHandler(baseReq);
    expect(sendMock).toHaveBeenCalledWith('recovery.requested', 'auntie@x.com', expect.any(Object));
  });
});
