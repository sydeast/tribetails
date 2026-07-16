import { describe, it, expect, vi, beforeEach } from 'vitest';

const initMock = vi.fn();

vi.mock('@sentry/node', () => ({
  init: initMock,
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

beforeEach(() => {
  initMock.mockReset();
  delete process.env.SENTRY_DSN;
  delete process.env.SENTRY_ENVIRONMENT;
});

describe('initSentry', () => {
  it('skips init when SENTRY_DSN unset and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { initSentry } = await import('../src/lib/sentry');
    initSentry();
    expect(initMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('initializes Sentry with DSN and environment when set', async () => {
    process.env.SENTRY_DSN = 'https://example@sentry.io/1';
    process.env.SENTRY_ENVIRONMENT = 'staging';
    vi.resetModules();
    const { initSentry } = await import('../src/lib/sentry');
    initSentry();
    expect(initMock).toHaveBeenCalledOnce();
    const arg = initMock.mock.calls[0][0];
    expect(arg.dsn).toBe('https://example@sentry.io/1');
    expect(arg.environment).toBe('staging');
  });
});
