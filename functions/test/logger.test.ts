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
});
