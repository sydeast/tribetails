import { describe, expect, it } from 'vitest';
import { describeProviderFailure, providerFailureFields, providerFailureMessage } from '../src/lib/providerFailure';

/**
 * #1531: two real timeout shapes carried no timeout word and no status, so the
 * real-services classifier (D3-e) read "no status code or timeout" and stopped
 * the release even during a listed vendor incident.
 *
 *   - smtp2go goes through `fetch` (undici). A network timeout throws
 *     `TypeError: fetch failed` with the code on `err.cause.code`
 *     (`UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`).
 *   - Twilio's SDK goes through axios. A client timeout is `code: 'ECONNABORTED'`
 *     with the message `timeout of <n>ms exceeded`.
 */

/** What undici throws on a connect timeout: a TypeError whose cause carries the code. */
function undiciTimeout(code: string): TypeError {
  const cause = Object.assign(new Error('Connect Timeout Error'), { code, name: 'ConnectTimeoutError' });
  return new TypeError('fetch failed', { cause });
}

/** What axios throws on a client timeout: the code on the error itself, no status. */
function axiosTimeout(ms: number): Error {
  return Object.assign(new Error(`timeout of ${ms}ms exceeded`), { code: 'ECONNABORTED', name: 'AxiosError' });
}

function twilioRestException(status: number, code: number, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

describe('providerFailureMessage and providerFailureFields on timeouts (#1531)', () => {
  it('an undici fetch timeout reads "timed out" with the code from err.cause', () => {
    const err = undiciTimeout('UND_ERR_CONNECT_TIMEOUT');
    expect(providerFailureMessage('smtp2go', err)).toBe(
      'smtp2go send timed out (code UND_ERR_CONNECT_TIMEOUT): fetch failed',
    );
    expect(providerFailureFields(err)).toEqual({ providerCode: 'UND_ERR_CONNECT_TIMEOUT' });
  });

  it.each(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])('%s on err.cause is a timeout too', (code) => {
    const err = undiciTimeout(code);
    expect(providerFailureMessage('smtp2go', err)).toBe(`smtp2go send timed out (code ${code}): fetch failed`);
    expect(providerFailureFields(err)).toEqual({ providerCode: code });
  });

  it('an axios client timeout (ECONNABORTED) reads "timed out" with the code and the axios message', () => {
    const err = axiosTimeout(10000);
    expect(providerFailureMessage('Twilio', err)).toBe(
      'Twilio send timed out (code ECONNABORTED): timeout of 10000ms exceeded',
    );
    expect(providerFailureFields(err)).toEqual({ providerCode: 'ECONNABORTED' });
  });

  it('a socket ETIMEDOUT on the error itself reads "timed out"', () => {
    const err = Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' });
    expect(providerFailureMessage('Twilio', err)).toBe(
      'Twilio send timed out (code ETIMEDOUT): connect ETIMEDOUT 1.2.3.4:443',
    );
  });

  it('a timeout message is passed through unchanged when wrapped a second time', () => {
    const once = describeProviderFailure('Twilio', axiosTimeout(10000));
    expect(providerFailureMessage('Twilio', once)).toBe(once.message);
  });

  it('describeProviderFailure carries the timeout code read from err.cause onto the new error', () => {
    const err = undiciTimeout('UND_ERR_CONNECT_TIMEOUT');
    const out = describeProviderFailure('smtp2go', err);
    expect(out.message).toBe('smtp2go send timed out (code UND_ERR_CONNECT_TIMEOUT): fetch failed');
    expect(out).toMatchObject({ code: 'UND_ERR_CONNECT_TIMEOUT', cause: err });
    expect((out as { status?: unknown }).status).toBeUndefined();
  });

  it('a non-timeout code on err.cause is still carried, but the message says "failed"', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const err = new TypeError('fetch failed', { cause });
    expect(providerFailureMessage('smtp2go', err)).toBe('smtp2go send failed (code ECONNREFUSED): fetch failed');
    expect(providerFailureFields(err)).toEqual({ providerCode: 'ECONNREFUSED' });
  });

  it('err.cause is read one level only', () => {
    const inner = Object.assign(new Error('deep'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
    const err = new TypeError('fetch failed', { cause: new Error('middle', { cause: inner }) });
    expect(providerFailureMessage('smtp2go', err)).toBe('smtp2go send failed: fetch failed');
    expect(providerFailureFields(err)).toEqual({});
  });
});

describe('providerFailureMessage and providerFailureFields, unchanged shapes (#1524)', () => {
  it('a plain 503 still reads "send failed (HTTP 503, code <code>)"', () => {
    const err = twilioRestException(503, 20500, 'Service Unavailable');
    expect(providerFailureMessage('Twilio', err)).toBe('Twilio send failed (HTTP 503, code 20500): Service Unavailable');
    expect(providerFailureFields(err)).toEqual({ providerStatus: 503, providerCode: 20500 });
  });

  it('a status with a timeout-looking code on err.cause is still an answered request, never a timeout', () => {
    const cause = Object.assign(new Error('x'), { code: 'ETIMEDOUT' });
    const err = Object.assign(new Error('Service Unavailable', { cause }), { status: 503 });
    expect(providerFailureMessage('Twilio', err)).toBe('Twilio send failed (HTTP 503): Service Unavailable');
    expect(providerFailureFields(err)).toEqual({ providerStatus: 503 });
  });

  it('an error with neither status nor code reads "send failed: <message>"', () => {
    expect(providerFailureMessage('Twilio', new Error('socket hang up'))).toBe('Twilio send failed: socket hang up');
    expect(providerFailureFields(new Error('socket hang up'))).toEqual({});
  });

  it('the recipient is scrubbed out of a timeout message as it is out of any other', () => {
    const err = Object.assign(new Error('timeout of 10000ms exceeded for +14155552671'), { code: 'ECONNABORTED' });
    expect(providerFailureMessage('Twilio', err, { plain: '+14155552671', masked: '+1******2671' })).toBe(
      'Twilio send timed out (code ECONNABORTED): timeout of 10000ms exceeded for +1******2671',
    );
  });
});
