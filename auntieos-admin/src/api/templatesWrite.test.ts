import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import {
  saveTemplate,
  deleteTemplate,
  assignTemplatesToCategory,
  isLiveNotificationKeyWarning,
  previewEmailTemplate,
  convertTemplateToVisual,
} from './templatesWrite';
import type { SaveTemplatePayload } from '../lib/templateFormat';

beforeEach(() => call.mockReset());

function payload(over: Partial<SaveTemplatePayload> = {}): SaveTemplatePayload {
  return {
    templateId: 'booking.confirmed',
    subject: 'Your booking is confirmed',
    body: 'Hi {{kinfolk_name}}',
    html: null,
    tags: [],
    usageInstructions: '',
    sectionDefinitions: [],
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

  it('deleteTemplate calls the callable by name with { templateId }, unwrapping { templateId }', async () => {
    call.mockResolvedValue({ templateId: 'booking.confirmed' });
    const result = await deleteTemplate('booking.confirmed');
    expect(call).toHaveBeenCalledWith('deleteTemplate', { templateId: 'booking.confirmed' });
    expect(result).toEqual({ templateId: 'booking.confirmed' });
  });

  it('deleteTemplate propagates a not-found rejection fail-loud (never swallowed here)', async () => {
    // mockImplementationOnce, not mockRejectedValue: see the saveTemplate
    // rejection test above for why (Vitest 2.1.9 unhandled-rejection race).
    call.mockImplementationOnce(() => Promise.reject(new Error('not-found: Template not found: ghost.template')));
    await expect(deleteTemplate('ghost.template')).rejects.toThrow(/not-found/);
  });

  it('deleteTemplate propagates a failed-precondition rejection (template still bound to a catalog key)', async () => {
    call.mockImplementationOnce(() =>
      Promise.reject(
        new Error(
          'failed-precondition: Template "booking.confirmed" is still assigned to notification catalog key(s): kin.booking.confirmed.',
        ),
      ),
    );
    await expect(deleteTemplate('booking.confirmed')).rejects.toThrow(/failed-precondition/);
  });

  it('deleteTemplate omits acknowledgeLiveKey entirely unless it is true', async () => {
    // The absent-vs-false distinction does not matter to the server (both are
    // "not acknowledged"), but sending the flag on every ordinary delete would
    // make the acknowledgement look like boilerplate in a request log rather
    // than the deliberate second press it is.
    call.mockResolvedValue({ templateId: 'booking.confirmed' });
    await deleteTemplate('booking.confirmed', { acknowledgeLiveKey: false });
    expect(call).toHaveBeenCalledWith('deleteTemplate', { templateId: 'booking.confirmed' });
  });

  it('deleteTemplate forwards acknowledgeLiveKey: true when the caller has confirmed', async () => {
    call.mockResolvedValue({ templateId: 'kincare.booking.confirm' });
    await deleteTemplate('kincare.booking.confirm', { acknowledgeLiveKey: true });
    expect(call).toHaveBeenCalledWith('deleteTemplate', {
      templateId: 'kincare.booking.confirm',
      acknowledgeLiveKey: true,
    });
  });

  it('recognises the live-key warning by its details, not its prose', () => {
    const err = Object.assign(new Error('anything at all'), {
      details: { reason: 'live-catalog-key', templateId: 'x', label: null, acknowledgeable: true },
    });
    expect(isLiveNotificationKeyWarning(err)).toBe(true);
  });

  it('does NOT match the binding refusal, which is the other failed-precondition', () => {
    // Same error code, different remedy: this one cannot be acknowledged past.
    const err = new Error(
      'failed-precondition: Template "booking.confirmed" is still assigned to notification ' +
        'catalog key(s): kin.booking.confirmed.',
    );
    expect(isLiveNotificationKeyWarning(err)).toBe(false);
  });

  it('does not match a message that merely reads like the warning', () => {
    // The guard against a copy edit turning prose-matching into a false positive.
    const err = new Error('failed-precondition: is what the notification sends, matched by name.');
    expect(isLiveNotificationKeyWarning(err)).toBe(false);
  });

  it('survives the shapes a network path actually throws', () => {
    expect(isLiveNotificationKeyWarning(undefined)).toBe(false);
    expect(isLiveNotificationKeyWarning(null)).toBe(false);
    expect(isLiveNotificationKeyWarning('failed-precondition')).toBe(false);
    expect(isLiveNotificationKeyWarning(Object.assign(new Error('x'), { details: 'nope' }))).toBe(
      false,
    );
  });

  it('assignTemplatesToCategory calls the callable by name with { category, templateIds }, unwrapping the result', async () => {
    call.mockResolvedValue({ category: 'Booking', assigned: 2, templateIds: ['a', 'b'] });
    const result = await assignTemplatesToCategory({ category: 'Booking', templateIds: ['a', 'b'] });
    expect(call).toHaveBeenCalledWith('assignTemplatesToCategory', {
      category: 'Booking',
      templateIds: ['a', 'b'],
    });
    expect(result).toEqual({ category: 'Booking', assigned: 2, templateIds: ['a', 'b'] });
  });

  it('assignTemplatesToCategory propagates a not-found rejection fail-loud (never swallowed here)', async () => {
    // mockImplementationOnce, not mockRejectedValue: see the saveTemplate
    // rejection test above for why (Vitest 2.1.9 unhandled-rejection race).
    call.mockImplementationOnce(() =>
      Promise.reject(new Error('not-found: Template(s) not found: ghost')),
    );
    await expect(
      assignTemplatesToCategory({ category: 'Booking', templateIds: ['ghost'] }),
    ).rejects.toThrow(/not-found/);
  });
});

describe('#953 visual template callables', () => {
  it('saveTemplate sends a visual payload untouched, with no body or html keys', async () => {
    call.mockResolvedValue({ templateId: 'auth.password.reset' });
    const visual = {
      templateId: 'auth.password.reset',
      subject: 'Reset',
      format: 'visual' as const,
      headline: 'Reset your password',
      content: '<p>Hi</p>',
      tags: [],
      usageInstructions: '',
      sectionDefinitions: [],
    };
    await saveTemplate(visual);
    expect(call).toHaveBeenCalledWith('saveTemplate', visual);
    const sent = call.mock.calls[0]![1] as Record<string, unknown>;
    expect('body' in sent).toBe(false);
    expect('html' in sent).toBe(false);
  });

  it('previewEmailTemplate calls the callable by name and returns its four fields', async () => {
    const res = { subject: 'S', html: '<html></html>', text: 'T', issues: [] };
    call.mockResolvedValue(res);
    const req = { subject: 'S', headline: 'H', content: '<p>x</p>', catalogKey: 'auth.password.reset' };
    await expect(previewEmailTemplate(req)).resolves.toEqual(res);
    expect(call).toHaveBeenCalledWith('previewEmailTemplate', req);
  });

  it('convertTemplateToVisual sends only the templateId and returns both outcomes as-is', async () => {
    call.mockResolvedValueOnce({ ok: true, subject: 'S', headline: 'H', content: '<p>x</p>', warnings: [] });
    await expect(convertTemplateToVisual('a.b')).resolves.toEqual({
      ok: true,
      subject: 'S',
      headline: 'H',
      content: '<p>x</p>',
      warnings: [],
    });
    expect(call).toHaveBeenCalledWith('convertTemplateToVisual', { templateId: 'a.b' });
    call.mockResolvedValueOnce({ ok: false, reason: 'unreadable', subject: 'S', body: 'B' });
    await expect(convertTemplateToVisual('a.b')).resolves.toEqual({
      ok: false,
      reason: 'unreadable',
      subject: 'S',
      body: 'B',
    });
  });
});
