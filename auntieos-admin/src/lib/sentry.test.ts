import * as Sentry from '@sentry/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initSentry, reportError } from './sentry';

// The transport is never real in tests; assert on how we call the SDK, not on
// any network behaviour.
vi.mock('@sentry/react', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
}));

describe('initSentry', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('is a no-op that logs the disabled line and never throws when no DSN is set', () => {
    vi.stubEnv('VITE_SENTRY_DSN', '');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    expect(() => initSentry()).not.toThrow();

    expect(Sentry.init).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('Sentry disabled: no VITE_SENTRY_DSN');
    info.mockRestore();
  });

  it('initializes Sentry with the DSN and sendDefaultPii:false when a DSN is set', () => {
    vi.stubEnv('VITE_SENTRY_DSN', 'https://public@o1.ingest.us.sentry.io/2');

    initSentry();

    expect(Sentry.init).toHaveBeenCalledTimes(1);
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://public@o1.ingest.us.sentry.io/2',
        sendDefaultPii: false,
        tracesSampleRate: 0.1,
      }),
    );
  });
});

describe('reportError', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards a caught exception to Sentry.captureException with the context tag', () => {
    const err = new Error('boom');
    reportError(err, 'unit.test');
    expect(Sentry.captureException).toHaveBeenCalledWith(err, { tags: { context: 'unit.test' } });
  });

  it('never throws (a reporter must not become the crash)', () => {
    expect(() => reportError(new Error('x'))).not.toThrow();
  });
});
