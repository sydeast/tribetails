import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
/**
 * #1587: the copy preview behind Marketing blasts. The template document and the
 * business name are the only outside reads, so they are mocked; the rendering is
 * the real `renderEmailParts` the sender uses, which is the whole point of the
 * preview matching the inbox.
 */
const mocks = vi.hoisted(() => ({
  loadEmailTemplate: vi.fn(),
  loadBusinessName: vi.fn(),
}));
vi.mock('../src/lib/sendFromTemplate', () => ({ loadEmailTemplate: mocks.loadEmailTemplate }));
vi.mock('../src/lib/businessName', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/businessName')>('../src/lib/businessName');
  return { ...actual, loadBusinessName: mocks.loadBusinessName };
});
vi.mock('../src/lib/firestoreAdmin', () => ({ db: vi.fn(), auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
import { classifyFields, mergeFieldNames, previewMarketingCopy } from '../src/admin/marketingCopy';
import { previewMarketingBlastCopyHandler } from '../src/admin/marketingBlasts';
beforeEach(() => {
  mocks.loadEmailTemplate.mockReset();
  mocks.loadBusinessName.mockReset().mockResolvedValue('Pawsome Auntie');
});
function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return { data, auth: uid ? ({ uid, token: { admin: true } } as unknown as NonNullable<CallableRequest<unknown>['auth']>) : undefined } as unknown as CallableRequest<unknown>;
}
describe('mergeFieldNames', () => {
  it('lists each named field once, first-seen order, across subject and body', () => {
    expect(mergeFieldNames('Hi {{firstName}}', 'Dear {{ firstName }}, see {{link}} {{{raw}}}')).toEqual([
      'firstName',
      'link',
      'raw',
    ]);
  });
  it('does not treat block helpers as fields, and reads dotted paths whole', () => {
    expect(mergeFieldNames('{{#if x}}a{{/if}} {{nextVisit.date}}')).toEqual(['nextVisit.date']);
  });
  it('ignores blank templates', () => {
    expect(mergeFieldNames(undefined, null, '')).toEqual([]);
  });
});
describe('classifyFields', () => {
  it('separates what the pipeline fills, what the blast supplies and what is missing', () => {
    expect(classifyFields(['business', 'link', 'promo', 'blank'], { link: 'https://x.test', blank: '  ' })).toEqual([
      { name: 'business', source: 'automatic' },
      { name: 'link', source: 'provided' },
      { name: 'promo', source: 'missing' },
      { name: 'blank', source: 'missing' },
    ]);
  });
});
describe('previewMarketingCopy', () => {
  it("renders the operator's visual template with the business name filled and no raw token", async () => {
    mocks.loadEmailTemplate.mockResolvedValue({
      subject: 'A little news from {{business}}',
      format: 'visual',
      headline: 'Spring {{promo}}',
      content: '<p>Hello from {{business}}. Details: {{link}}</p>',
    });
    const out = await previewMarketingCopy('newsletter.announcement', { link: 'https://kinfolk.tribetails.com/news' });
    expect(out.subject).toBe('A little news from Pawsome Auntie');
    expect(out.text).toContain('Hello from Pawsome Auntie');
    expect(out.text).toContain('https://kinfolk.tribetails.com/news');
    expect(out.text).not.toContain('{{');
    expect(out.usedFallback).toBe(false);
    expect(out.fields).toEqual([
      { name: 'business', source: 'automatic' },
      { name: 'promo', source: 'missing' },
      { name: 'link', source: 'provided' },
    ]);
  });
  it('shows the generic wording the sender falls back to when no template exists, and says so', async () => {
    mocks.loadEmailTemplate.mockResolvedValue(null);
    const out = await previewMarketingCopy('newsletter.announcement', {});
    expect(out.usedFallback).toBe(true);
    expect(out.subject).toBe('An update about your care');
    expect(out.text).toContain('Pawsome Auntie');
  });
  it('refuses a damaged visual template by name instead of previewing an empty email', async () => {
    mocks.loadEmailTemplate.mockResolvedValue({ subject: 's', format: 'visual' });
    await expect(previewMarketingCopy('newsletter.announcement', {})).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });
  it('refuses a key that is not a campaign the catalog knows', async () => {
    await expect(previewMarketingCopy('no.such.key', {})).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});
describe('previewMarketingBlastCopy callable', () => {
  it('needs a signed-in admin', async () => {
    await expect(
      previewMarketingBlastCopyHandler(req({ key: 'newsletter.announcement' }, null)),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });
  it('accepts only the three marketing keys', async () => {
    await expect(previewMarketingBlastCopyHandler(req({ key: 'invoice.new' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });
  it('returns the rendered copy and the field statuses', async () => {
    mocks.loadEmailTemplate.mockResolvedValue({ subject: 'Hi {{business}}', body: 'Body {{promo}}', html: null });
    const out = await previewMarketingBlastCopyHandler(req({ key: 'survey.event', data: { promo: 'SPRING' } }));
    expect(out.ok).toBe(true);
    expect(out.subject).toBe('Hi Pawsome Auntie');
    expect(out.text).toBe('Body SPRING');
    expect(out.fields).toEqual([
      { name: 'business', source: 'automatic' },
      { name: 'promo', source: 'provided' },
    ]);
  });
});
