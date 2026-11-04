import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logEvent } from '../src/lib/logger';

describe('logEvent', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('writes a JSON line with required fields', () => {
    const spy = vi.spyOn(console, 'log');
    logEvent({
      severity: 'info',
      function: 'health',
      event: 'health.ok',
      requestId: 'req-1',
    });
    const line = spy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.severity).toBe('info');
    expect(parsed.event).toBe('health.ok');
    expect(parsed.function).toBe('health');
    expect(parsed.requestId).toBe('req-1');
    expect(typeof parsed.ts).toBe('string');
  });

  it('routes severity=error to console.error', () => {
    const spy = vi.spyOn(console, 'error');
    logEvent({ severity: 'error', function: 'x', event: 'x.fail' });
    expect(spy).toHaveBeenCalledOnce();
  });

  it('routes severity=critical to console.error', () => {
    const spy = vi.spyOn(console, 'error');
    logEvent({ severity: 'critical', function: 'x', event: 'x.dead' });
    expect(spy).toHaveBeenCalledOnce();
  });

  // #1520: a refused callable now logs its failure line at warn. Warn is not a
  // fault, so it goes to stdout with info and debug, and the line still carries
  // `"severity":"warn"` for the real-run harness, which matches on the field
  // and not on the stream.
  it('routes severity=warn to console.log, not console.error, and keeps the severity field', () => {
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    logEvent({ severity: 'warn', function: 'getFormSchema', event: 'getFormSchema.failure', errorCode: 'not-found' });
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    const parsed = JSON.parse(log.mock.calls[0][0] as string);
    expect(parsed.severity).toBe('warn');
    expect(parsed.errorCode).toBe('not-found');
  });
});
