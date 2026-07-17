import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { saveTemplate } from './templatesWrite';
import type { SaveTemplatePayload } from '../lib/templateFormat';

beforeEach(() => call.mockReset());

function payload(over: Partial<SaveTemplatePayload> = {}): SaveTemplatePayload {
  return {
    templateId: 'booking.confirmed',
    subject: 'Your booking is confirmed',
    body: 'Hi {{kinfolk_name}}',
    html: null,
    tags: [],
    ...over,
  };
}

describe('templatesWrite api', () => {
  it('saveTemplate calls the callable by name with the exact payload, unwrapping { templateId }', async () => {
    call.mockResolvedValue({ templateId: 'booking.confirmed' });
    const result = await saveTemplate(payload());
    expect(call).toHaveBeenCalledWith('saveTemplate', payload());
    expect(result).toEqual({ templateId: 'booking.confirmed' });
  });

  it('passes optional title/description/category/html through untouched (no re-shaping here, that is buildSaveTemplatePayload\'s job)', async () => {
    const p = payload({ title: 'Booking Confirmed', description: 'A note', category: 'Booking', html: '<p>Hi</p>' });
    call.mockResolvedValue({ templateId: 'booking.confirmed' });
    await saveTemplate(p);
    expect(call).toHaveBeenCalledWith('saveTemplate', p);
  });

  it('propagates a callable rejection so the caller can fail loud (never swallowed here)', async () => {
    // mockImplementationOnce(() => Promise.reject(...)), not
    // mockRejectedValue(...): the latter has a real timing race with this
    // repo's vi.hoisted + vi.mock('../lib/fns', ...) setup under Vitest
    // 2.1.9, reproducible even against a throwaway fake module, where the
    // rejection is flagged as an unhandled error a tick before `.rejects`
    // attaches. Deferring the rejected promise's construction to actual
    // invocation time (mockImplementationOnce) avoids the race outright.
    call.mockImplementationOnce(() =>
      Promise.reject(new Error('invalid-argument: subject must not use unescaped Handlebars')),
    );
    await expect(saveTemplate(payload())).rejects.toThrow(/unescaped Handlebars/);
  });
});
