import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callableRequest } from './_helpers/callableRequest';
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
// #957: the preview reads the stored email frame. An empty store, so these
// tests exercise the real read (nothing stored, the default frame), not the
// fallback a missing Firestore client would take.
vi.mock('../src/lib/firestoreAdmin', async () => {
  const { buildDbMock } = await import('./_helpers/mockDb');
  const { db } = buildDbMock({ docs: {} });
  return { db: () => db, auth: vi.fn(), getAdmin: vi.fn() };
});
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

  // #962: `visits` is a LIST field (notifications/visitDates.ts's
  // RenderedVisit[]), and sampling it as a string like every other field left
  // `{{#each visits}}` with nothing to iterate, so the preview of both loop
  // templates (assignment.assigned, kincare.booking.confirm) showed an empty
  // list although a real send renders every visit.
  it('samples visits as an array, not a string, so {{#each visits}} has something to iterate', () => {
    const data = sampleDataFor('assignment.assigned');
    expect(Array.isArray(data['visits'])).toBe(true);
    expect(data['visits']).toHaveLength(2);
    for (const visit of data['visits'] as Record<string, unknown>[]) {
      expect(visit['weekday']).toEqual(expect.stringContaining('weekday'));
      expect(visit['date']).toEqual(expect.stringContaining('date'));
      expect(visit['time']).toEqual(expect.stringContaining('time'));
    }
  });

  it.each(['assignment.assigned', 'kincare.booking.confirm'])(
    'renders a visit row for each sample visit in the %s preview, not an empty list',
    async (catalogKey) => {
      // Same loop markup as the two seed templates
      // (mytribe/seeds/notificationTemplates/<key>/content.html).
      const loop = '<ul>{{#each visits}}<li>{{this.weekday}}, {{this.date}} at {{this.time}}</li>{{/each}}</ul>';
      const res = await previewEmailTemplateHandler(
        callableRequest({ ...req, content: loop, catalogKey }, { uid: 'op1' }),
      );
      const rows = (res.html.match(/<li>/g) ?? []).length;
      expect(rows).toBe(2);
      expect(res.html).not.toContain('<ul></ul>');
    },
  );

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
