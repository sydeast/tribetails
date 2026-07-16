import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  process.env.SMTP2GO_API_KEY = 'api-test-key';
  process.env.EMAIL_FROM = 'auntie@tribetails.com';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SMTP2GO_API_KEY;
  delete process.env.EMAIL_FROM;
});

function okResponse(emailId = 'smtp2go-id-1') {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: { succeeded: 1, failed: 0, email_id: emailId } }),
  };
}

describe('sendTemplatedEmail (smtp2go)', () => {
  it('renders handlebars templates and posts to smtp2go, returning email_id', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('id-42'));
    const { sendTemplatedEmail } = await import('../src/lib/email');
    const id = await sendTemplatedEmail({
      to: 'kin@example.com',
      subjectTemplate: 'Welcome to {{tribeName}}',
      bodyTemplate: 'Hi {{name}}, claim: {{claimUrl}}',
      data: { tribeName: 'The Parkers', name: 'Dee', claimUrl: 'https://x/claim?i=1' },
    });
    expect(id).toBe('id-42');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.smtp2go.com/v3/email/send');
    expect(init.headers['X-Smtp2go-Api-Key']).toBe('api-test-key');
    const body = JSON.parse(init.body);
    expect(body.sender).toBe('auntie@tribetails.com');
    expect(body.to).toEqual(['kin@example.com']);
    expect(body.subject).toBe('Welcome to The Parkers');
    expect(body.text_body).toBe('Hi Dee, claim: https://x/claim?i=1');
    expect(body.html_body).toBeUndefined();
  });

  it('includes html_body when htmlTemplate is provided', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const { sendTemplatedEmail } = await import('../src/lib/email');
    await sendTemplatedEmail({
      to: 'kin@example.com',
      subjectTemplate: 's',
      bodyTemplate: 'b',
      htmlTemplate: '<b>{{name}}</b>',
      data: { name: 'Dee' },
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.html_body).toBe('<b>Dee</b>');
  });

  it('passes replyTo as a custom Reply-To header', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const { sendTemplatedEmail } = await import('../src/lib/email');
    await sendTemplatedEmail({
      to: 'kin@example.com',
      subjectTemplate: 's',
      bodyTemplate: 'b',
      data: {},
      replyTo: 'replies@tribetails.com',
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.custom_headers).toEqual([{ header: 'Reply-To', value: 'replies@tribetails.com' }]);
  });

  it('throws when SMTP2GO_API_KEY is missing', async () => {
    delete process.env.SMTP2GO_API_KEY;
    const { sendTemplatedEmail } = await import('../src/lib/email');
    await expect(
      sendTemplatedEmail({ to: 'a@b', subjectTemplate: 'x', bodyTemplate: 'y', data: {} }),
    ).rejects.toThrow('SMTP2GO_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when EMAIL_FROM is missing', async () => {
    delete process.env.EMAIL_FROM;
    const { sendTemplatedEmail } = await import('../src/lib/email');
    await expect(
      sendTemplatedEmail({ to: 'a@b', subjectTemplate: 'x', bodyTemplate: 'y', data: {} }),
    ).rejects.toThrow('EMAIL_FROM');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws with the provider error message on non-2xx responses', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ data: { error: 'API key is invalid', error_code: 'E_ApiResponseCodes.API_KEY_INVALID' } }),
    });
    const { sendTemplatedEmail } = await import('../src/lib/email');
    await expect(
      sendTemplatedEmail({ to: 'a@b', subjectTemplate: 'x', bodyTemplate: 'y', data: {} }),
    ).rejects.toThrow(/API key is invalid/);
  });

  it('throws when smtp2go reports zero succeeded sends', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: { succeeded: 0, failed: 1, failures: ['bad recipient'] } }),
    });
    const { sendTemplatedEmail } = await import('../src/lib/email');
    await expect(
      sendTemplatedEmail({ to: 'a@b', subjectTemplate: 'x', bodyTemplate: 'y', data: {} }),
    ).rejects.toThrow(/bad recipient|failed/);
  });
});
