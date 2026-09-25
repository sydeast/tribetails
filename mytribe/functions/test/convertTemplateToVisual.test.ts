import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';
const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
import { convertTemplateToVisualHandler } from '../src/admin/convertTemplateToVisual';

const legacy = readFileSync(join(__dirname, 'fixtures/legacyResetEmail.html'), 'utf8');

/** A minimal legacy frame (same shape convertLegacyTemplate.test.ts's `frame` builds) with a non-Cloudinary image. */
const imageFrame =
  '<!DOCTYPE html><html><head><style>.x{}</style></head><body><div class="container">' +
  '<div class="header"><h2>Hi there</h2></div><div class="content"><p>Hello</p>' +
  '<p><img src="https://evil.example/pic.png" alt="x"></p></div>' +
  '<div class="footer">Tribe Tails Pet Care.</div></div></body></html>';

let ctx: ReturnType<typeof buildDbMock>;
const run = (templateId: string) => convertTemplateToVisualHandler(callableRequest({ templateId }, { uid: 'op1' }));

beforeEach(() => {
  ctx = buildDbMock({
    writeThrough: true,
    docs: {
      'emailTemplates/old': { subject: 'S', body: 'Plain {{link}}', html: legacy },
      'emailTemplates/hand': { subject: 'S2', body: 'Line one\n\nLine two', html: '<table><tr><td>x</td></tr></table>' },
      'emailTemplates/vis': { subject: 'S3', format: 'visual', headline: 'H', content: '<p>c</p>' },
      'emailTemplates/img': { subject: 'S4', html: imageFrame },
      'emailTemplates/nosubject': { format: 'visual', headline: 'H', content: '<p>c</p>' },
      'emailTemplates/half': { subject: 'S6', format: 'visual', html: null, body: 'b' },
    },
  });
  mocks.dbFn.mockReturnValue(ctx.db);
});

afterEach(() => vi.unstubAllEnvs());

describe('convertTemplateToVisual', () => {
  it('converts a framed old template without writing anything', async () => {
    const r = await run('old');
    expect(r).toMatchObject({ ok: true, subject: 'S', headline: 'Reset your Tribe Tails password', warnings: [] });
    expect(ctx.writes).toEqual([]);
  });

  it('answers unreadable with the plain body for hand-built HTML', async () => {
    expect(await run('hand')).toEqual({ ok: false, reason: 'unreadable', subject: 'S2', body: 'Line one\n\nLine two' });
  });

  it('returns an already-visual template as it is', async () => {
    expect(await run('vis')).toEqual({ ok: true, subject: 'S3', headline: 'H', content: '<p>c</p>', warnings: [] });
  });

  it('is not-found for a missing template', async () => {
    await expect(run('nope')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects an empty or invalid templateId with invalid-argument, not a thrown ZodError', async () => {
    await expect(run('')).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(run('bad/id')).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('falls back to an empty subject when the stored doc has none', async () => {
    expect(await run('nosubject')).toEqual({ ok: true, subject: '', headline: 'H', content: '<p>c</p>', warnings: [] });
  });

  it('answers unreadable (not a throw) for a half-visual doc with no headline/content and no html', async () => {
    expect(await run('half')).toEqual({ ok: false, reason: 'unreadable', subject: 'S6', body: 'b' });
  });

  it('converts a stored old doc with a non-Cloudinary image, and reports it as a warning instead of dropping it silently', async () => {
    vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'tribetails');
    const r = await run('img');
    expect(r).toMatchObject({ ok: true, subject: 'S4', headline: 'Hi there' });
    if (!r.ok) throw new Error('expected ok');
    expect(r.warnings).toEqual(['Removed an image that is not from your Cloudinary library.']);
    expect(r.content).not.toContain('<img');
  });

  it('refuses with failed-precondition when Cloudinary is not configured and the stored html has an image', async () => {
    vi.stubEnv('CLOUDINARY_CLOUD_NAME', '');
    await expect(run('img')).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('CLOUDINARY_CLOUD_NAME'),
    });
  });
});
