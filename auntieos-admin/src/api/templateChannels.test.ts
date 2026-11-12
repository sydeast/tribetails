import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { getTemplateChannels, saveTemplateChannels, wordingErrorsFrom } from './templateChannels';

beforeEach(() => call.mockReset());

describe('templateChannels api (#1935)', () => {
  it('getTemplateChannels calls the callable by name with the template id', async () => {
    call.mockResolvedValue({ templateId: 'a.b' });
    await expect(getTemplateChannels('a.b')).resolves.toEqual({ templateId: 'a.b' });
    expect(call).toHaveBeenCalledWith('getTemplateChannels', { templateId: 'a.b' });
  });

  it('saveTemplateChannels sends exactly the channel it was given', async () => {
    call.mockResolvedValue({ templateId: 'a.b' });
    await saveTemplateChannels({ templateId: 'a.b', sms: { text: 'Hi' } });
    expect(call).toHaveBeenCalledWith('saveTemplateChannels', { templateId: 'a.b', sms: { text: 'Hi' } });
    await saveTemplateChannels({ templateId: 'a.b', push: { title: 'T', body: 'B' } });
    expect(call).toHaveBeenLastCalledWith('saveTemplateChannels', {
      templateId: 'a.b',
      push: { title: 'T', body: 'B' },
    });
  });

  it('a rejection passes through untouched, details and all', async () => {
    const err = Object.assign(new Error('refused'), { details: { reason: 'template-wording-refused' } });
    // mockImplementationOnce, not mockRejectedValue: see templatesWrite.test.ts
    // for the unhandled-rejection race the latter has with this mock setup.
    call.mockImplementationOnce(() => Promise.reject(err));
    const caught = await saveTemplateChannels({ templateId: 'a.b', sms: { text: '' } }).catch((e: unknown) => e);
    expect(caught).toBe(err);
  });

  describe('wordingErrorsFrom', () => {
    it('reads the per-field sentences off a refusal', () => {
      const err = Object.assign(new Error('x'), {
        details: {
          reason: 'template-wording-refused',
          fieldErrors: { smsText: 'Text message cannot be empty.', pushBody: 'Message cannot be empty.' },
        },
      });
      expect(wordingErrorsFrom(err)).toEqual({
        smsText: 'Text message cannot be empty.',
        pushBody: 'Message cannot be empty.',
      });
    });

    it('ignores fields it does not know and sentences that are not text', () => {
      const err = { details: { reason: 'template-wording-refused', fieldErrors: { other: 'x', pushTitle: 7, smsText: ' ' } } };
      expect(wordingErrorsFrom(err)).toEqual({});
    });

    it('is null for any other failure, so the screen falls back to the message', () => {
      expect(wordingErrorsFrom(new Error('offline'))).toBeNull();
      expect(wordingErrorsFrom({ details: { reason: 'template-exists' } })).toBeNull();
      expect(wordingErrorsFrom({ details: { reason: 'template-wording-refused' } })).toBeNull();
      expect(wordingErrorsFrom(null)).toBeNull();
      expect(wordingErrorsFrom(undefined)).toBeNull();
    });
  });
});
