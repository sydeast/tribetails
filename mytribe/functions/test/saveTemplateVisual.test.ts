import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));

import { saveTemplateHandler } from '../src/admin/saveTemplate';

let ctx: ReturnType<typeof buildDbMock>;
beforeEach(() => {
  vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'tribetails');
  ctx = buildDbMock({ writeThrough: true, docs: { 'emailTemplates/k': { subject: 'Old', body: 'b', html: '<p>h</p>' } } });
  mocks.dbFn.mockReturnValue(ctx.db);
});
const save = (data: Record<string, unknown>) => saveTemplateHandler(callableRequest(data, { uid: 'op1' }));
const written = () => ctx.writes.filter((w: { path: string }) => w.path === 'emailTemplates/k').at(-1)!.data;

describe('saveTemplate, visual format', () => {
  it('stores subject, headline, sanitized content and the flag, and deletes body and html', async () => {
    await save({ templateId: 'k', subject: 'S', format: 'visual', headline: 'H', content: '<div style="x">Hi</div>' });
    const d = written();
    expect(d).toMatchObject({ subject: 'S', headline: 'H', content: '<p>Hi</p>', format: 'visual' });
    expect(d.body).toEqual(FieldValue.delete());
    expect(d.html).toEqual(FieldValue.delete());
  });

  it('refuses a token outside text or href with the sanitizer message', async () => {
    await expect(
      save({ templateId: 'k', subject: 'S', format: 'visual', headline: 'H', content: '<p><img src="https://res.cloudinary.com/tribetails/image/upload/a.png" alt="{{x}}"></p>' }),
    ).rejects.toMatchObject({ code: 'invalid-argument', message: expect.stringContaining('merge field can only be used') });
  });

  it('refuses a visual save that also sends body or html', async () => {
    await expect(save({ templateId: 'k', subject: 'S', format: 'visual', headline: 'H', content: '<p>x</p>', body: 'b' })).rejects.toBeTruthy();
  });

  it('refuses an empty headline', async () => {
    await expect(save({ templateId: 'k', subject: 'S', format: 'visual', headline: ' ', content: '<p>x</p>' })).rejects.toBeTruthy();
  });

  it('old-format saves are unchanged', async () => {
    await save({ templateId: 'k', subject: 'S2', body: 'b2', html: null });
    expect(written()).toMatchObject({ subject: 'S2', body: 'b2', html: null });
    expect(written().format).toBeUndefined();
  });
});
