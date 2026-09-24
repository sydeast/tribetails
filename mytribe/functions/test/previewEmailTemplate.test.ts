import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callableRequest } from './_helpers/callableRequest';
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
import { previewEmailTemplateHandler, sampleDataFor } from '../src/admin/previewEmailTemplate';
import { renderEmailParts } from '../src/lib/email';
import { sendPartsFor } from '../src/lib/emailFrame';

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

  it('renders with no key, stripping unknown tokens', async () => {
    const res = await previewEmailTemplateHandler(callableRequest({ ...req, content: '<p>{{mystery}}x</p>' }, { uid: 'op1' }));
    expect(res.html).not.toContain('{{');
    expect(res.text).toBe('Reset\n\nx');
  });

  it('returns sanitizer issues instead of throwing, so the editor can show them', async () => {
    const res = await previewEmailTemplateHandler(callableRequest({ ...req, content: '<p>{{{raw}}}</p>' }, { uid: 'op1' }));
    expect(res.issues).toContain('Triple braces {{{ }}} are not allowed.');
  });
});
