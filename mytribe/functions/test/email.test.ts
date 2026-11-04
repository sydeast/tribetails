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
      to: 'kin@tribetails.com',
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
    expect(body.to).toEqual(['kin@tribetails.com']);
    expect(body.subject).toBe('Welcome to The Parkers');
    expect(body.text_body).toBe('Hi Dee, claim: https://x/claim?i=1');
    expect(body.html_body).toBeUndefined();
  });

  it('includes html_body when htmlTemplate is provided', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const { sendTemplatedEmail } = await import('../src/lib/email');
    await sendTemplatedEmail({
      to: 'kin@tribetails.com',
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
      to: 'kin@tribetails.com',
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

/**
 * #1535: the wrappers log a thrown error's message and nothing else of it, and
 * the real-services classifier (D3-e) attributes a line by vendor name and
 * reads `HTTP NNN` or a timeout word off it. A network failure never reached
 * the HTTP-error throws, so undici's bare `TypeError: fetch failed` was the
 * whole log line. The shapes below are what undici really throws: the message
 * is `fetch failed` and the code sits one level down on `err.cause.code`.
 */
describe('sendTemplatedEmail names smtp2go on every failure (#1535)', () => {
  function undiciFailure(code: string, detail: string): TypeError {
    return new TypeError('fetch failed', { cause: Object.assign(new Error(detail), { code }) });
  }

  it('an undici connect timeout rethrows as a smtp2go timeout with the code, original as cause', async () => {
    const original = undiciFailure('UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error');
    fetchMock.mockRejectedValueOnce(original);
    const { sendTemplatedEmail } = await import('../src/lib/email');
    const thrown = await sendTemplatedEmail({
      to: 'kin@tribetails.com',
      subjectTemplate: 'x',
      bodyTemplate: 'y',
      data: {},
    }).catch((e) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toBe('smtp2go send timed out (code UND_ERR_CONNECT_TIMEOUT): fetch failed');
    expect(thrown).toMatchObject({ code: 'UND_ERR_CONNECT_TIMEOUT' });
    expect(thrown.cause).toBe(original);
  });

  it('a reset connection rethrows as a smtp2go failure with the code, not a timeout', async () => {
    fetchMock.mockRejectedValueOnce(undiciFailure('ECONNRESET', 'read ECONNRESET'));
    const { sendTemplatedEmail } = await import('../src/lib/email');
    const thrown = await sendTemplatedEmail({
      to: 'kin@tribetails.com',
      subjectTemplate: 'x',
      bodyTemplate: 'y',
      data: {},
    }).catch((e) => e);
    expect(thrown.message).toBe('smtp2go send failed (code ECONNRESET): fetch failed');
    expect(thrown).toMatchObject({ code: 'ECONNRESET' });
  });

  it('an HTTP 503 keeps the existing message with the status and is not wrapped again', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ data: { error: 'Service Unavailable' } }),
    });
    const { sendTemplatedEmail } = await import('../src/lib/email');
    const thrown = await sendTemplatedEmail({
      to: 'kin@tribetails.com',
      subjectTemplate: 'x',
      bodyTemplate: 'y',
      data: {},
    }).catch((e) => e);
    expect(thrown.message).toBe('smtp2go send failed (HTTP 503): Service Unavailable');
    // The HTTP path throws its own Error directly: no cause, no double prefix.
    expect(thrown.cause).toBeUndefined();
  });
});

/**
 * #1540: the body read is the other place a transport error can surface. The
 * headers arrived, so `fetch` resolved, and only `res.json()` throws. undici
 * errors the body stream with `TypeError: terminated` carrying the real error
 * as `cause` (`code: 'UND_ERR_BODY_TIMEOUT'`, or ECONNRESET for a reset mid
 * body), and `.catch(() => ({}))` swallowed it into the generic "no sends
 * succeeded" line with no timeout word and no code. A body that is simply not
 * JSON throws a plain SyntaxError with no code, and that keeps the
 * empty-object fallback.
 */
describe('sendTemplatedEmail keeps a body-phase transport error (#1540)', () => {
  function undiciBodyFailure(code: string, detail: string): TypeError {
    return new TypeError('terminated', { cause: Object.assign(new Error(detail), { code }) });
  }

  it('a body timeout on a 2xx rethrows as a smtp2go timeout with the code, original as cause', async () => {
    const original = undiciBodyFailure('UND_ERR_BODY_TIMEOUT', 'Body Timeout Error');
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.reject(original) });
    const { sendTemplatedEmail } = await import('../src/lib/email');
    const thrown = await sendTemplatedEmail({
      to: 'kin@tribetails.com',
      subjectTemplate: 'x',
      bodyTemplate: 'y',
      data: {},
    }).catch((e) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toBe('smtp2go send timed out (code UND_ERR_BODY_TIMEOUT): terminated');
    expect(thrown).toMatchObject({ code: 'UND_ERR_BODY_TIMEOUT' });
    expect(thrown.cause).toBe(original);
  });

  it('a reset mid body rethrows as a smtp2go failure with the code, not a timeout', async () => {
    const original = undiciBodyFailure('ECONNRESET', 'read ECONNRESET');
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.reject(original) });
    const { sendTemplatedEmail } = await import('../src/lib/email');
    const thrown = await sendTemplatedEmail({
      to: 'kin@tribetails.com',
      subjectTemplate: 'x',
      bodyTemplate: 'y',
      data: {},
    }).catch((e) => e);
    expect(thrown.message).toBe('smtp2go send failed (code ECONNRESET): terminated');
    expect(thrown).toMatchObject({ code: 'ECONNRESET' });
    expect(thrown.cause).toBe(original);
  });

  it('a 2xx whose body is not JSON keeps the empty-object fallback: the generic line, no code, no cause', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')),
    });
    const { sendTemplatedEmail } = await import('../src/lib/email');
    const thrown = await sendTemplatedEmail({
      to: 'kin@tribetails.com',
      subjectTemplate: 'x',
      bodyTemplate: 'y',
      data: {},
    }).catch((e) => e);
    // An unreadable 2xx is not a delivered send and not a transport error: the
    // empty payload has no `succeeded`, so today's generic line stands.
    expect(thrown.message).toBe('smtp2go send failed: no sends succeeded');
    expect(thrown.code).toBeUndefined();
    expect(thrown.cause).toBeUndefined();
  });

  it('a 4xx whose body is not JSON keeps the existing HTTP message', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')),
    });
    const { sendTemplatedEmail } = await import('../src/lib/email');
    const thrown = await sendTemplatedEmail({
      to: 'kin@tribetails.com',
      subjectTemplate: 'x',
      bodyTemplate: 'y',
      data: {},
    }).catch((e) => e);
    expect(thrown.message).toBe('smtp2go send failed (HTTP 400): unknown error');
    expect(thrown.cause).toBeUndefined();
  });
});
