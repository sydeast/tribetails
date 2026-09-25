import { describe, it, expect, vi, beforeEach } from 'vitest';
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
let ctx: ReturnType<typeof buildDbMock>;
const run = (templateId: string) => convertTemplateToVisualHandler(callableRequest({ templateId }, { uid: 'op1' }));

beforeEach(() => {
  ctx = buildDbMock({
    writeThrough: true,
    docs: {
      'emailTemplates/old': { subject: 'S', body: 'Plain {{link}}', html: legacy },
      'emailTemplates/hand': { subject: 'S2', body: 'Line one\n\nLine two', html: '<table><tr><td>x</td></tr></table>' },
      'emailTemplates/vis': { subject: 'S3', format: 'visual', headline: 'H', content: '<p>c</p>' },
    },
  });
  mocks.dbFn.mockReturnValue(ctx.db);
});

describe('convertTemplateToVisual', () => {
  it('converts a framed old template without writing anything', async () => {
    const r = await run('old');
    expect(r).toMatchObject({ ok: true, subject: 'S', headline: 'Reset your Tribe Tails password' });
    expect(ctx.writes).toEqual([]);
  });

  it('answers unreadable with the plain body for hand-built HTML', async () => {
    expect(await run('hand')).toEqual({ ok: false, reason: 'unreadable', subject: 'S2', body: 'Line one\n\nLine two' });
  });

  it('returns an already-visual template as it is', async () => {
    expect(await run('vis')).toEqual({ ok: true, subject: 'S3', headline: 'H', content: '<p>c</p>' });
  });

  it('is not-found for a missing template', async () => {
    await expect(run('nope')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects an empty or invalid templateId with invalid-argument, not a thrown ZodError', async () => {
    await expect(run('')).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(run('bad/id')).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});
