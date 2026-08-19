import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

import { saveTemplateHandler } from '../src/admin/saveTemplate';

function req(data: unknown, uid = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: { uid, token: { admin: true } as any },
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

describe('saveTemplate', () => {
  it('HAPPY: creates new template with createdAt + createdBy', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveTemplateHandler(
      req({
        templateId: 'welcome.kinfolk',
        subject: 'Welcome to TribeTails',
        body: 'Hello {{firstName}}',
        category: 'Onboarding',
        tags: ['onboarding', 'welcome'],
      }),
    );
    expect(res.templateId).toBe('welcome.kinfolk');
    const write = ctx.writes.find((w) => w.path === 'emailTemplates/welcome.kinfolk');
    expect(write).toBeDefined();
    expect(write?.data.subject).toBe('Welcome to TribeTails');
    expect(write?.data.body).toBe('Hello {{firstName}}');
    expect(write?.data.createdBy).toBe('admin1');
    expect(write?.data.tags).toEqual(['onboarding', 'welcome']);
  });

  it('HAPPY: updates existing template (no createdAt overwrite)', async () => {
    const ctx = buildDbMock({
      docs: {
        'emailTemplates/welcome.kinfolk': {
          subject: 'old subject',
          body: 'old body',
          createdAt: 'preserved',
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveTemplateHandler(
      req({
        templateId: 'welcome.kinfolk',
        subject: 'New subject',
        body: 'New body',
      }),
    );
    expect(res.templateId).toBe('welcome.kinfolk');
    const write = ctx.writes.find((w) => w.path === 'emailTemplates/welcome.kinfolk');
    expect(write?.data.subject).toBe('New subject');
    expect(write?.data.updatedBy).toBe('admin1');
    expect(write?.data.createdBy).toBeUndefined();
  });

  it('HAPPY: upserts the chosen category into template_categories (grows the pool)', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await saveTemplateHandler(
      req({ templateId: 'welcome.kinfolk', subject: 's', body: 'b', category: 'Onboarding' }),
    );
    const catWrite = ctx.writes.find((w) => w.path === 'template_categories/onboarding');
    expect(catWrite).toBeDefined();
    expect(catWrite?.data.name).toBe('Onboarding');
    expect(catWrite?.merge).toBe(true);
  });

  it('HAPPY: no category => no template_categories write', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await saveTemplateHandler(req({ templateId: 'welcome.kinfolk', subject: 's', body: 'b' }));
    expect(ctx.writes.some((w) => w.path.startsWith('template_categories/'))).toBe(false);
  });

  it('SAD: invalid templateId chars rejected', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      saveTemplateHandler(req({ templateId: 'bad id with spaces', subject: 's', body: 'b' })),
    ).rejects.toThrow();
  });

  it('SAD: unauthenticated rejected', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      saveTemplateHandler({
        data: { templateId: 'x', subject: 's', body: 'b' },
      } as CallableRequest<unknown>),
    ).rejects.toThrow();
  });

  it('SAD: empty subject rejected', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      saveTemplateHandler(req({ templateId: 'x', subject: '', body: 'b' })),
    ).rejects.toThrow();
  });

  // ── I9: usageInstructions + sectionDefinitions ──────────────────────────────

  it('I9 HAPPY: persists usageInstructions and sectionDefinitions when supplied', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await saveTemplateHandler(
      req({
        templateId: 'welcome.kinfolk',
        subject: 's',
        body: 'b',
        usageInstructions: 'Send after the first visit is confirmed.',
        sectionDefinitions: [
          { title: 'Greeting', description: 'Warm hello by first name.' },
          { title: 'Next steps', description: '' },
        ],
      }),
    );
    const write = ctx.writes.find((w) => w.path === 'emailTemplates/welcome.kinfolk');
    expect(write?.data.usageInstructions).toBe('Send after the first visit is confirmed.');
    expect(write?.data.sectionDefinitions).toEqual([
      { title: 'Greeting', description: 'Warm hello by first name.' },
      { title: 'Next steps', description: '' },
    ]);
  });

  it('I9 backward compat: omitting the new fields does NOT write them (merge preserves an older value)', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await saveTemplateHandler(req({ templateId: 'welcome.kinfolk', subject: 's', body: 'b' }));
    const write = ctx.writes.find((w) => w.path === 'emailTemplates/welcome.kinfolk');
    expect(write).toBeDefined();
    expect('usageInstructions' in (write!.data as object)).toBe(false);
    expect('sectionDefinitions' in (write!.data as object)).toBe(false);
  });

  it('I9 HAPPY: an explicit empty string / empty array IS written (so a save can clear them)', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await saveTemplateHandler(
      req({
        templateId: 'welcome.kinfolk',
        subject: 's',
        body: 'b',
        usageInstructions: '',
        sectionDefinitions: [],
      }),
    );
    const write = ctx.writes.find((w) => w.path === 'emailTemplates/welcome.kinfolk');
    expect(write!.data.usageInstructions).toBe('');
    expect(write!.data.sectionDefinitions).toEqual([]);
  });

  it('I9 SAD: a section with a blank title is rejected', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      saveTemplateHandler(
        req({
          templateId: 'welcome.kinfolk',
          subject: 's',
          body: 'b',
          sectionDefinitions: [{ title: '', description: 'x' }],
        }),
      ),
    ).rejects.toThrow();
  });
});
// Issue #468. Two rules that had no test at all until now: the triple-stash
// guard, which is the only thing standing between an author and a raw-HTML
// merge field in a kinfolk inbox, and the create-versus-upsert distinction,
// which is why naming an existing key used to replace it in silence.
describe('saveTemplate: the triple-stash guard', () => {
  for (const field of ['subject', 'body', 'html'] as const) {
    it(`SAD: rejects {{{ in ${field}, and the message names the fix`, async () => {
      const ctx = buildDbMock({});
      mocks.dbFn.mockReturnValue(ctx.db);
      const base: Record<string, unknown> = {
        templateId: 'welcome.kinfolk',
        subject: 'Hello',
        body: 'Body copy.',
      };
      base[field] = `Hello {{{payload}}}`;
      await expect(saveTemplateHandler(req(base))).rejects.toThrow(
        /Change every \{\{\{name\}\}\} to \{\{name\}\}/,
      );
      expect(ctx.writes).toEqual([]);
    });
  }
  it('HAPPY: the ordinary double stash is untouched', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await saveTemplateHandler(
      req({ templateId: 'welcome.kinfolk', subject: 'Hi {{kinfolkName}}', body: 'Your {{kinName}}.' }),
    );
    expect(ctx.writes.find((w) => w.path === 'emailTemplates/welcome.kinfolk')).toBeDefined();
  });
});
describe('saveTemplate: expectNew', () => {
  it('SAD: refuses to create over a key that is already taken', async () => {
    const ctx = buildDbMock({
      docs: { 'emailTemplates/welcome.kinfolk': { subject: 'theirs', body: 'theirs' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      saveTemplateHandler(
        req({ templateId: 'welcome.kinfolk', subject: 's', body: 'b', expectNew: true }),
      ),
    ).rejects.toThrow(/already exists/);
    // The existing template is untouched, which is the whole point.
    expect(ctx.writes).toEqual([]);
  });
  it('SAD: the refusal carries a machine-readable reason for the clients', async () => {
    const ctx = buildDbMock({
      docs: { 'emailTemplates/welcome.kinfolk': { subject: 'theirs', body: 'theirs' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const err = await saveTemplateHandler(
      req({ templateId: 'welcome.kinfolk', subject: 's', body: 'b', expectNew: true }),
    ).catch((e) => e);
    expect(err.code).toBe('already-exists');
    expect(err.details).toMatchObject({ reason: 'template-exists', templateId: 'welcome.kinfolk' });
  });
  it('HAPPY: creates when the key is free, stamping createdBy', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveTemplateHandler(
      req({ templateId: 'brand.new', subject: 's', body: 'b', expectNew: true }),
    );
    expect(res).toEqual({ templateId: 'brand.new' });
    const write = ctx.writes.find((w) => w.path === 'emailTemplates/brand.new');
    expect(write?.data.createdBy).toBe('admin1');
  });
  it('HAPPY: without the flag the callable still upserts, as the older clients expect', async () => {
    const ctx = buildDbMock({
      docs: { 'emailTemplates/welcome.kinfolk': { subject: 'old', body: 'old' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await saveTemplateHandler(req({ templateId: 'welcome.kinfolk', subject: 'new', body: 'new' }));
    const write = ctx.writes.find((w) => w.path === 'emailTemplates/welcome.kinfolk');
    expect(write?.data.subject).toBe('new');
    expect(write?.merge).toBe(true);
  });
  it('SAD: rejects an id with characters a document id cannot carry', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      saveTemplateHandler(req({ templateId: 'has spaces', subject: 's', body: 'b', expectNew: true })),
    ).rejects.toThrow();
    expect(ctx.writes).toEqual([]);
  });
});
