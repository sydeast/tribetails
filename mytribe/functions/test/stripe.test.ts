import { describe, it, expect, vi } from 'vitest';

const constructEventMock = vi.fn();
vi.mock('stripe', () => {
  return {
    // vitest 4: a mock used with `new` must be implemented with `function`/`class`.
    default: vi.fn(function () {
      return { webhooks: { constructEvent: constructEventMock } };
    }),
  };
});

describe('verifyStripeWebhook', () => {
  it('returns the event when signature is valid', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    constructEventMock.mockReturnValue({ id: 'evt_1', type: 'invoice.paid' });
    const { verifyStripeWebhook } = await import('../src/lib/stripe');
    const event = verifyStripeWebhook(Buffer.from('{}'), 'sig');
    expect(event.id).toBe('evt_1');
    expect(constructEventMock).toHaveBeenCalledWith(expect.any(Buffer), 'sig', 'whsec_test');
  });

  it('throws when STRIPE_WEBHOOK_SECRET unset', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    vi.resetModules();
    const { verifyStripeWebhook } = await import('../src/lib/stripe');
    expect(() => verifyStripeWebhook(Buffer.from('{}'), 'sig')).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });
});
