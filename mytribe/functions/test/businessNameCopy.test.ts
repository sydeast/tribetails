import { describe, it, expect, vi } from 'vitest';
vi.mock('../src/lib/firestoreAdmin', () => ({ db: vi.fn(), auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
import { planVisit } from '../src/portal/requestBooking';
import { unsubscribeFooter } from '../src/admin/sendExternalMessage';
/**
 * #1381: server-built household text names the business from settings and says
 * "your Auntie" when it is unset. Never a hard-coded business.
 */
describe('planVisit: the overnight refusal names the business', () => {
  const policy = { startTimeServiceIds: ['night'] } as never;
  const nightWithoutDate = { serviceId: 'night', serviceName: 'Overnight', date: null, startTimeMs: null } as never;
  it('uses the settings name', () => {
    expect(() => planVisit(nightWithoutDate, policy, 'America/Chicago', Date.now(), 'Test Business')).toThrow(
      'Choose a night for the Overnight. Test Business sets the start time when your request is approved.',
    );
  });
  it('says "Your Auntie" when no name is set', () => {
    expect(() => planVisit(nightWithoutDate, policy, 'America/Chicago', Date.now())).toThrow(
      'Choose a night for the Overnight. Your Auntie sets the start time when your request is approved.',
    );
  });
});
describe('unsubscribeFooter', () => {
  it('names the business, or "your Auntie" when unset', () => {
    expect(unsubscribeFooter('Test Business')).toContain('contact Test Business to be removed');
    expect(unsubscribeFooter('')).toContain('contact your Auntie to be removed');
    expect(unsubscribeFooter('Test Business')).toContain('reply STOP');
    expect(unsubscribeFooter('')).not.toContain('Tribe Tails');
  });
});
