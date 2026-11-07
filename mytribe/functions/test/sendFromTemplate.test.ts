import { describe, it, expect, vi, beforeEach } from 'vitest';

const tplGet = vi.fn();
const suppressionGet = vi.fn();
const sendMock = vi.fn().mockResolvedValue('m-1');
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({
    doc: (p: string) => ({
      get: () => (p.startsWith('message_suppressions/') ? suppressionGet(p) : tplGet(p)),
    }),
  }),
}));
vi.mock('../src/lib/email', () => ({ sendTemplatedEmail: sendMock }));

beforeEach(() => {
  sendMock.mockClear();
  suppressionGet.mockReset().mockResolvedValue({ exists: false, data: () => undefined });
});

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
      templateKey: 'invite.primary',
    });
  });

  it('throws fail-loud when template missing', async () => {
    tplGet.mockResolvedValue({ exists: false });
    const { sendFromTemplate } = await import('../src/lib/sendFromTemplate');
    await expect(sendFromTemplate('missing.key', 'a@b', {})).rejects.toThrow(/template missing/);
  });

  it('#1586: a missing invite.verify-email document throws, even though the repo carries a copy', async () => {
    // A deleted template is how the operator stops a send (ruling 2026-08-18), so the
    // repo copy must never go out in its place. Template Import is the way in.
    tplGet.mockResolvedValue({ exists: false });
    const { sendFromTemplate } = await import('../src/lib/sendFromTemplate');
    const { SEED_CORPUS } = await import('../src/notifications/seedCorpus.generated');
    expect(SEED_CORPUS.some((e) => e.key === 'invite.verify-email')).toBe(true);
    await expect(
      sendFromTemplate('invite.verify-email', 'catch@hanasamku.com', { verifyUrl: 'https://verify.example/abc' }, undefined, {
        personRequested: true,
      }),
    ).rejects.toThrow(/email template missing/);
    expect(sendMock).not.toHaveBeenCalled();
  });
  it('#1586: a stored invite.verify-email document is what goes out', async () => {
    tplGet.mockResolvedValue({ exists: true, data: () => ({ subject: 'Operator subject', body: 'B {{verifyUrl}}', html: null }) });
    const { sendFromTemplate } = await import('../src/lib/sendFromTemplate');
    await sendFromTemplate('invite.verify-email', 'catch@hanasamku.com', {}, undefined, { personRequested: true });
    expect((sendMock.mock.calls[0]![0] as { subjectTemplate: string }).subjectTemplate).toBe('Operator subject');
  });
});

/**
 * #1077: invites (mintInvite, provisionTribe, inviteKinfolkToPortal,
 * inviteEmails), recovery (executePrimaryRecovery, requestPrimaryRecovery) and
 * the error digest all send through here, so a hard-bounced address is refused
 * once, at this point, before any provider call.
 */
describe('sendFromTemplate honours hard-bounce suppressions (#1077)', () => {
  beforeEach(() => {
    tplGet.mockResolvedValue({ exists: true, data: () => ({ subject: 'S', body: 'B', html: null }) });
  });

  it('refuses a hard-bounced address with failed-precondition recipient_hard_bounced and sends nothing', async () => {
    suppressionGet.mockImplementation(async (p: string) =>
      p === `message_suppressions/${encodeURIComponent('gone@example.com')}`
        ? { exists: true, data: () => ({ reason: 'hard_bounce', channel: 'email' }) }
        : { exists: false, data: () => undefined },
    );
    const { sendFromTemplate } = await import('../src/lib/sendFromTemplate');
    await expect(sendFromTemplate('invite.primary', ' Gone@Example.com ', {})).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringMatching(/^recipient_hard_bounced/),
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('refuses an opted-out address that later hard-bounced (hardBounce block, no reason)', async () => {
    suppressionGet.mockResolvedValue({ exists: true, data: () => ({ channel: 'email', hardBounce: { eventId: 'e' } }) });
    const { sendFromTemplate } = await import('../src/lib/sendFromTemplate');
    await expect(sendFromTemplate('invite.primary', 'gone@example.com', {})).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('still sends to a marketing opt-out (an invite is not marketing)', async () => {
    suppressionGet.mockResolvedValue({ exists: true, data: () => ({ channel: 'email', actorUid: 'admin1' }) });
    const { sendFromTemplate } = await import('../src/lib/sendFromTemplate');
    await expect(sendFromTemplate('invite.primary', 'optout@example.com', {})).resolves.toBe('m-1');
  });

  it('a person-requested send can opt past the check (acceptInvite verify-email)', async () => {
    suppressionGet.mockResolvedValue({ exists: true, data: () => ({ reason: 'hard_bounce' }) });
    const { sendFromTemplate } = await import('../src/lib/sendFromTemplate');
    await expect(
      sendFromTemplate('invite.verify-email', 'gone@example.com', {}, undefined, { personRequested: true }),
    ).resolves.toBe('m-1');
    expect(suppressionGet).not.toHaveBeenCalled();
  });
});
