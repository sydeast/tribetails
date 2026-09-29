import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { getEmailFrame, saveEmailFrame, resetEmailFrame, previewEmailFrame } from './emailFrame';

beforeEach(() => call.mockReset());

describe('#957 email frame callables', () => {
  it('getEmailFrame calls the callable by name and returns its answer', async () => {
    const res = { stored: { accentColor: '#123456' }, defaults: {}, updatedAt: null, updatedBy: null };
    call.mockResolvedValue(res);
    await expect(getEmailFrame()).resolves.toEqual(res);
    expect(call).toHaveBeenCalledWith('getEmailFrame', {}, { idempotent: true });
  });

  it('saveEmailFrame sends only the changes it is given, nulls included', async () => {
    call.mockResolvedValue({});
    await saveEmailFrame({ accentColor: '#123456', footerText: null });
    expect(call).toHaveBeenCalledWith('saveEmailFrame', { changes: { accentColor: '#123456', footerText: null } });
  });

  it('resetEmailFrame asks for resetAll and nothing else', async () => {
    call.mockResolvedValue({});
    await resetEmailFrame();
    expect(call).toHaveBeenCalledWith('saveEmailFrame', { resetAll: true });
  });

  it('previewEmailFrame sends the draft frame', async () => {
    const res = { subject: 'S', html: '<html></html>', text: 'T' };
    call.mockResolvedValue(res);
    await expect(previewEmailFrame({ footerText: 'Hi' })).resolves.toEqual(res);
    expect(call).toHaveBeenCalledWith('previewEmailFrame', { frame: { footerText: 'Hi' } }, { idempotent: true });
  });
});
