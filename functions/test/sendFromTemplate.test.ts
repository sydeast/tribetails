import { describe, it, expect, vi } from 'vitest';

const tplGet = vi.fn();
const sendMock = vi.fn().mockResolvedValue('m-1');
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({ doc: (p: string) => ({ get: () => tplGet(p) }) }),
}));
vi.mock('../src/lib/email', () => ({ sendTemplatedEmail: sendMock }));

describe('sendFromTemplate', () => {
  it('renders template body and dispatches', async () => {
    tplGet.mockResolvedValue({
      exists: true,
      data: () => ({ subject: 'Hi {{name}}', body: 'Body {{name}}', html: null }),
    });
    const { sendFromTemplate } = await import('../src/lib/sendFromTemplate');
    const id = await sendFromTemplate('invite.primary', 'a@b.com', { name: 'Alice' });
    expect(id).toBe('m-1');
    expect(sendMock).toHaveBeenCalledWith({
      to: 'a@b.com',
      subjectTemplate: 'Hi {{name}}',
      bodyTemplate: 'Body {{name}}',
      data: { name: 'Alice' },
      htmlTemplate: undefined,
    });
  });

  it('throws fail-loud when template missing', async () => {
    tplGet.mockResolvedValue({ exists: false });
    const { sendFromTemplate } = await import('../src/lib/sendFromTemplate');
    await expect(sendFromTemplate('missing.key', 'a@b', {})).rejects.toThrow(/template missing/);
  });
});
