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

  it('old-format saves are unchanged, and also clear any stale visual fields', async () => {
    await save({ templateId: 'k', subject: 'S2', body: 'b2', html: null });
    const d = written();
    expect(d).toMatchObject({ subject: 'S2', body: 'b2', html: null });
    // Controller ruling (#953): an old-format save must turn a document that
    // used to be visual back into an old-format one. `emailTemplates/k` in
    // this file's fixture is already old-format, so these are a no-op on the
    // stored value, but the write itself must always carry the three
    // sentinels on the update path -- the handler cannot tell "this document
    // happens to have no visual fields" from "this document is visual" without
    // reading it, and reading it defeats the point of a merge write.
    expect(d.format).toEqual(FieldValue.delete());
    expect(d.headline).toEqual(FieldValue.delete());
    expect(d.content).toEqual(FieldValue.delete());
  });

  it('an old-format save over an existing visual document clears format/headline/content', async () => {
    const visualCtx = buildDbMock({
      writeThrough: true,
      docs: { 'emailTemplates/v': { subject: 'Old', format: 'visual', headline: 'H', content: '<p>x</p>' } },
    });
    mocks.dbFn.mockReturnValue(visualCtx.db);
    await saveTemplateHandler(callableRequest({ templateId: 'v', subject: 'S2', body: 'b2', html: null }, { uid: 'op1' }));
    const d = visualCtx.writes.filter((w: { path: string }) => w.path === 'emailTemplates/v').at(-1)!.data;
    expect(d).toMatchObject({ subject: 'S2', body: 'b2', html: null });
    expect(d.format).toEqual(FieldValue.delete());
    expect(d.headline).toEqual(FieldValue.delete());
    expect(d.content).toEqual(FieldValue.delete());
  });

  // Environment rule: create() must never see a FieldValue.delete() sentinel.
  // A brand-new document has nothing to delete, so whichever branch's
  // delete-sentinel write applies has to be stripped before ref.create(), not
  // merely set to a harmless value.
  it('a new visual template (expectNew) writes no body/html at all', async () => {
    await save({ templateId: 'new-visual', subject: 'S', format: 'visual', headline: 'H', content: '<p>x</p>', expectNew: true });
    const d = ctx.writes.find((w: { path: string }) => w.path === 'emailTemplates/new-visual')!.data;
    expect('body' in d).toBe(false);
    expect('html' in d).toBe(false);
    expect(d).toMatchObject({ format: 'visual', headline: 'H', content: '<p>x</p>' });
  });

  it('a new old-format template (expectNew) writes no format/headline/content at all', async () => {
    await save({ templateId: 'new-old', subject: 'S', body: 'b', expectNew: true });
    const d = ctx.writes.find((w: { path: string }) => w.path === 'emailTemplates/new-old')!.data;
    expect('format' in d).toBe(false);
    expect('headline' in d).toBe(false);
    expect('content' in d).toBe(false);
    expect(d).toMatchObject({ subject: 'S', body: 'b' });
  });
});
