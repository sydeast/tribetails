import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callableRequest } from './_helpers/callableRequest';
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
import { previewEmailTemplateHandler, sampleDataFor } from '../src/admin/previewEmailTemplate';
import { renderEmailParts } from '../src/lib/email';
import { sendPartsFor } from '../src/lib/emailFrame';
import { sanitizeEmailContent } from '../src/lib/emailContent';

beforeEach(() => vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'tribetails'));
const req = { subject: 'Hi {{displayName}}', headline: 'Reset', content: '<p>{{displayName}}</p><p><a href="{{link}}" class="button">Go</a></p>' };

describe('previewEmailTemplate', () => {
  it('renders exactly what a real send renders, with sample data for the key', async () => {
    const res = await previewEmailTemplateHandler(callableRequest({ ...req, catalogKey: 'auth.password.reset' }, { uid: 'op1' }));
    const real = renderEmailParts({
      ...sendPartsFor({ subject: req.subject, format: 'visual', headline: req.headline, content: req.content }),
      data: sampleDataFor('auth.password.reset'),
    });
    expect(res).toEqual({ ...real, issues: [] });
  });

  it('samples link-like fields as https URLs so buttons are clickable', () => {
    expect(sampleDataFor('auth.password.reset')['link']).toMatch(/^https:\/\//);
  });

  it('nests a dotted TEMPLATE_FIELDS name so Handlebars can resolve it as a path', () => {
    const data = sampleDataFor('assignment.assigned');
    expect(data['nextVisit']).toMatchObject({ date: '[nextVisit.date]', time: '[nextVisit.time]', weekday: '[nextVisit.weekday]' });
    expect(data['nextVisit.date']).toBeUndefined();
  });

  it('a nested sample field renders in the preview instead of blank', async () => {
    const res = await previewEmailTemplateHandler(
      callableRequest({ ...req, content: '<p>{{nextVisit.date}}</p>', catalogKey: 'assignment.assigned' }, { uid: 'op1' }),
    );
    expect(res.text).toContain('[nextVisit.date]');
  });

  it('rejects oversized content with invalid-argument, not a thrown ZodError', async () => {
    await expect(
      previewEmailTemplateHandler(callableRequest({ ...req, content: 'x'.repeat(50001) }, { uid: 'op1' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('renders with no key, stripping unknown tokens', async () => {
    const res = await previewEmailTemplateHandler(callableRequest({ ...req, content: '<p>{{mystery}}x</p>' }, { uid: 'op1' }));
    expect(res.html).not.toContain('{{');
    expect(res.text).toBe('Reset\n\nx');
  });

  it('renders the SANITIZED content, not the raw args.content, when sanitization rewrites it', async () => {
    // A pasted <div style> is rewritten to a plain <p> by sanitizeEmailContent.
    // Asserting parity against the sanitized content (not the raw args.content)
    // is what would fail if the handler ever swapped in the unsanitized value.
    const dirty = '<div style="color:red">Hi {{displayName}}</div>';
    const res = await previewEmailTemplateHandler(callableRequest({ ...req, content: dirty, catalogKey: 'auth.password.reset' }, { uid: 'op1' }));
    const { content: clean } = sanitizeEmailContent(dirty, 'tribetails');
    expect(clean).not.toBe(dirty);
    const real = renderEmailParts({
      ...sendPartsFor({ subject: req.subject, format: 'visual', headline: req.headline, content: clean }),
      data: sampleDataFor('auth.password.reset'),
    });
    expect(res).toEqual({ ...real, issues: [] });
  });

  it('returns sanitizer issues instead of throwing, so the editor can show them', async () => {
    const res = await previewEmailTemplateHandler(callableRequest({ ...req, content: '<p>{{{raw}}}</p>' }, { uid: 'op1' }));
    expect(res.issues).toContain('Triple braces {{{ }}} are not allowed.');
  });

  it('a prototype-name catalogKey renders with no fields instead of throwing', async () => {
    for (const catalogKey of ['constructor', '__proto__']) {
      await expect(previewEmailTemplateHandler(callableRequest({ ...req, catalogKey }, { uid: 'op1' }))).resolves.toBeTruthy();
      expect(sampleDataFor(catalogKey)).toEqual({});
    }
  });

  it('refuses to preview an image when Cloudinary is not configured', async () => {
    vi.stubEnv('CLOUDINARY_CLOUD_NAME', '');
    await expect(
      previewEmailTemplateHandler(callableRequest({ ...req, content: '<p><img src="x"></p>' }, { uid: 'op1' })),
    ).rejects.toMatchObject({ code: 'failed-precondition', message: expect.stringContaining('CLOUDINARY_CLOUD_NAME') });
  });
});
