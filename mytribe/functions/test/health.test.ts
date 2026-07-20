import { describe, it, expect } from 'vitest';
import { healthHandler } from '../src/health/health';

describe('healthHandler', () => {
  it('returns ok with current timestamp and node version', async () => {
    const result = await healthHandler({ auth: { uid: 'u1' } } as any);
    expect(result.status).toBe('ok');
    expect(typeof result.ts).toBe('string');
    expect(result.node).toMatch(/^v\d+/);
  });

  it('still returns ok when called unauthenticated', async () => {
    const result = await healthHandler({ auth: undefined } as any);
    expect(result.status).toBe('ok');
  });
});
