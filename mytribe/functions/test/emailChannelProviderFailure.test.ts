import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #1535: the dispatcher's email channel, end to end through the REAL trigger
 * wrapper and the REAL smtp2go transport, with only the network, Firestore,
 * Sentry and the audit log faked.
 *
 * The claim is about the log line. `wrapTrigger` logs `err.message` and nothing
 * else of the error, and the real-services classifier (D3-e) attributes that
 * line by vendor name and reads a timeout word or `HTTP NNN` off it. The email
 * channel has no catch of its own, so this proves the message `lib/email.ts`
 * throws is the one that reaches both the `.failure` log event and the
 * `errorMessage` stamped on the channel subdoc.
 */
const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  logEvent: vi.fn(),
  loadEmailTemplate: vi.fn(),
  writeAudit: vi.fn(async () => undefined),
  captureFunctionError: vi.fn(() => 'sentry-1'),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/sentry', () => ({
  initSentry: vi.fn(),
  captureFunctionError: mocks.captureFunctionError,
  captureCritical: vi.fn(() => 'sentry-2'),
  isSentryInitialized: () => false,
}));
vi.mock('../src/lib/sendFromTemplate', () => ({ loadEmailTemplate: mocks.loadEmailTemplate }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAudit }));
// The merge data is not under test; emitter values pass straight through.
vi.mock('../src/notifications/enrichTemplateData', () => ({
  enrichTemplateData: async (_key: string, _uid: string, data: Record<string, unknown>) => data,
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__', increment: (n: number) => n } };
});

import { wrapTrigger } from '../src/lib/wrapTrigger';
import { onNotificationChannelCreateHandler } from '../src/notifications/triggers/onNotificationChannelCreate';

const fetchMock = vi.fn();

type ChannelPatch = Record<string, unknown>;

/** A pending `email` channel subdoc under an `invoice.new` work order for u1. */
function makeEvent() {
  const setSpy = vi.fn(async (_patch: ChannelPatch) => {});
  const parentRef = {
    id: 'notif1',
    path: 'notificationDispatch/notif1',
    get: async () => ({
      data: () => ({ key: 'invoice.new', recipientUid: 'u1', data: { invoiceNumber: 'TT-1' } }),
    }),
  };
  const snap = { data: () => ({ status: 'pending' }), ref: { parent: { parent: parentRef }, set: setSpy } };
  return { event: { data: snap, params: { channel: 'email', id: 'notif1' } }, setSpy };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  mocks.dbFn.mockReset();
  mocks.logEvent.mockReset();
  mocks.captureFunctionError.mockClear();
  mocks.loadEmailTemplate.mockReset().mockResolvedValue({ subject: 'Invoice {{invoiceNumber}}', body: 'Due.' });
  // A real address on a sending domain: `lib/email.ts` is real here, and it
  // refuses reserved domains before it ever reaches the network.
  mocks.dbFn.mockReturnValue(buildDbMock({ docs: { 'clients/u1': { email: 'kin@tribetails.com' } } }).db);
  process.env.SMTP2GO_API_KEY = 'api-test-key';
  process.env.EMAIL_FROM = 'auntie@tribetails.com';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SMTP2GO_API_KEY;
  delete process.env.EMAIL_FROM;
});

describe('dispatcher email channel: the logged failure line names smtp2go (#1535)', () => {
  it('an undici connect timeout reaches the .failure log and the subdoc as a smtp2go timeout', async () => {
    const original = new TypeError('fetch failed', {
      cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
    });
    fetchMock.mockRejectedValueOnce(original);
    const { event, setSpy } = makeEvent();
    const handler = wrapTrigger('onNotificationChannelCreate', onNotificationChannelCreateHandler);

    // wrapTrigger's handler type is `Promise<void> | void`, so settle it first.
    const thrown = (await Promise.resolve(handler(event)).then(
      () => undefined,
      (e: unknown) => e,
    )) as (Error & { cause?: unknown }) | undefined;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toBe('smtp2go send timed out (code UND_ERR_CONNECT_TIMEOUT): fetch failed');
    expect(thrown?.cause).toBe(original);
    // The one line the classifier reads.
    const failure = mocks.logEvent.mock.calls.map((c) => c[0]).find((e) => e.event === 'onNotificationChannelCreate.failure');
    expect(failure).toMatchObject({
      severity: 'error',
      errorMessage: 'smtp2go send timed out (code UND_ERR_CONNECT_TIMEOUT): fetch failed',
    });
    // The same message is what the channel row shows the office.
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorMessage: 'smtp2go send timed out (code UND_ERR_CONNECT_TIMEOUT): fetch failed',
      }),
      { merge: true },
    );
    // Sentry still gets the described error, with the original reachable as cause.
    expect(mocks.captureFunctionError).toHaveBeenCalledWith(thrown, expect.objectContaining({ kind: 'trigger' }));
  });

  it('an HTTP 503 from smtp2go reaches the .failure log with the status on the line', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ data: { error: 'Service Unavailable' } }),
    });
    const { event, setSpy } = makeEvent();
    const handler = wrapTrigger('onNotificationChannelCreate', onNotificationChannelCreateHandler);

    await expect(handler(event)).rejects.toThrow('smtp2go send failed (HTTP 503): Service Unavailable');

    const failure = mocks.logEvent.mock.calls.map((c) => c[0]).find((e) => e.event === 'onNotificationChannelCreate.failure');
    expect(failure).toMatchObject({ errorMessage: 'smtp2go send failed (HTTP 503): Service Unavailable' });
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', errorMessage: 'smtp2go send failed (HTTP 503): Service Unavailable' }),
      { merge: true },
    );
  });
});
