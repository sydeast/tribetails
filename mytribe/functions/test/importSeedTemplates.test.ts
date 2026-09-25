import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

import { importSeedTemplatesHandler, toRows } from '../src/admin/importSeedTemplates';
import { planImport, plannedWrites } from '../src/notifications/importPlanner';
import { SEED_CORPUS } from '../src/notifications/seedCorpus.generated';
import { contentToText, frameHtml } from '../src/lib/emailFrame';

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? { uid, token: { admin: true } as any } : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/** The corpus entry the whole issue is about, so the tests use the real one. */
const RESCHEDULE = 'kincare.reschedule.requested';

function corpusEntry(key: string) {
  const entry = SEED_CORPUS.find((e) => e.key === key);
  if (!entry) throw new Error(`test fixture: no corpus entry ${key}`);
  return entry;
}

describe('importSeedTemplates: the dry run', () => {
  it('HAPPY: writes nothing at all, and says so', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await importSeedTemplatesHandler(req({ dryRun: true }));

    expect(res.dryRun).toBe(true);
    expect(res.written).toBe(0);
    // The claim that matters. Not "the count says zero", but "the mock recorded
    // no write of any kind", which is what a dry run promises.
    expect(ctx.writes).toEqual([]);
    expect(ctx.deletes).toEqual([]);
  });

  it('HAPPY: defaults to a dry run when dryRun is absent', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await importSeedTemplatesHandler(req({}));

    expect(res.dryRun).toBe(true);
    expect(ctx.writes).toEqual([]);
  });

  it('HAPPY: reports create for every channel of a template Firestore has never seen', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await importSeedTemplatesHandler(req({ dryRun: true, onlyIds: [RESCHEDULE] }));

    expect(res.rows).toHaveLength(1);
    const row = res.rows[0];
    expect(row.templateId).toBe(RESCHEDULE);
    expect(row.channels.map((c) => c.channel)).toEqual(['email', 'sms', 'push']);
    expect(row.channels.every((c) => c.outcome === 'create')).toBe(true);
    expect(row.blocked).toBe(false);
    expect(row.issues).toEqual([]);
    expect(row.differsFromRepo).toBe(false);
    expect(res.counts.create).toBe(3);
  });

  it('HAPPY: reports unchanged when the stored copy already matches the repo', async () => {
    const entry = corpusEntry(RESCHEDULE);
    // #953 bridge: importPlanner's email channel derives body/html from the
    // visual fields the same way sendPartsFor does (see importPlanner.ts);
    // this fixture has to match that derivation to land on "unchanged".
    const subject = entry.emailSubject;
    const body = contentToText(entry.emailHeadline, entry.emailContent);
    const html = frameHtml(entry.emailHeadline, entry.emailContent);
    const ctx = buildDbMock({
      docs: {
        [`emailTemplates/${RESCHEDULE}`]: { subject, body, html },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await importSeedTemplatesHandler(req({ dryRun: true, onlyIds: [RESCHEDULE] }));

    const email = res.rows[0].channels.find((c) => c.channel === 'email');
    expect(email?.outcome).toBe('unchanged');
    expect(res.rows[0].differsFromRepo).toBe(false);
  });
});

describe('importSeedTemplates: overwriting is an explicit choice', () => {
  const EDITED = {
    [`emailTemplates/${RESCHEDULE}`]: {
      subject: 'Wording the operator typed in the Template Bank',
      body: 'Also theirs.',
      html: null,
      category: 'Visits',
      tags: ['office'],
    },
  };

  it('SAD: skips a template that differs, and names it as needing a choice', async () => {
    const ctx = buildDbMock({ docs: EDITED });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await importSeedTemplatesHandler(req({ dryRun: false, onlyIds: [RESCHEDULE] }));

    const email = res.rows[0].channels.find((c) => c.channel === 'email');
    expect(email?.outcome).toBe('skipped');
    expect(res.rows[0].differsFromRepo).toBe(true);
    expect(res.needsOverwriteChoice).toEqual([RESCHEDULE]);
    // The operator's edited email survived. sms and push did not exist, so they
    // were created; the point is that nothing touched emailTemplates.
    expect(ctx.writes.map((w) => w.path)).not.toContain(`emailTemplates/${RESCHEDULE}`);
  });

  it('HAPPY: overwrites only when the id is named in overwriteIds', async () => {
    const ctx = buildDbMock({ docs: EDITED });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await importSeedTemplatesHandler(
      req({ dryRun: false, onlyIds: [RESCHEDULE], overwriteIds: [RESCHEDULE] }),
    );

    const email = res.rows[0].channels.find((c) => c.channel === 'email');
    expect(email?.outcome).toBe('overwrite');
    const write = ctx.writes.find((w) => w.path === `emailTemplates/${RESCHEDULE}`);
    expect(write?.data.subject).toBe('A kinfolk asked for a new visit time');
    expect(res.needsOverwriteChoice).toEqual([]);
  });

  it('HAPPY: an overwrite merges content and leaves the authoring fields alone', async () => {
    const ctx = buildDbMock({ docs: EDITED });
    mocks.dbFn.mockReturnValue(ctx.db);

    await importSeedTemplatesHandler(
      req({ dryRun: false, onlyIds: [RESCHEDULE], overwriteIds: [RESCHEDULE] }),
    );

    const write = ctx.writes.find((w) => w.path === `emailTemplates/${RESCHEDULE}`);
    // This is the seed script's actual bug, pinned. `.set()` without merge drops
    // category and tags; a merge whose payload never mentions them keeps them.
    expect(write?.merge).toBe(true);
    expect(write?.data).not.toHaveProperty('category');
    expect(write?.data).not.toHaveProperty('tags');
    expect(write?.data).not.toHaveProperty('title');
  });

  it('SAD: a dry run with overwriteIds set still writes nothing', async () => {
    const ctx = buildDbMock({ docs: EDITED });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await importSeedTemplatesHandler(
      req({ dryRun: true, onlyIds: [RESCHEDULE], overwriteIds: [RESCHEDULE] }),
    );

    expect(res.rows[0].channels.find((c) => c.channel === 'email')?.outcome).toBe('overwrite');
    expect(ctx.writes).toEqual([]);
  });
});

describe('importSeedTemplates: the guards', () => {
  it('SAD: refuses an unknown id rather than importing nothing quietly', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      importSeedTemplatesHandler(req({ dryRun: true, onlyIds: ['not.a.seed.template'] })),
    ).rejects.toThrow(/No seed template on file for not\.a\.seed\.template/);
  });

  it('SAD: refuses an unauthenticated caller', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(importSeedTemplatesHandler(req({}, null))).rejects.toThrow(/Sign-in required/);
  });

  it('HAPPY: labels the retired alias key so the report explains why it is there', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await importSeedTemplatesHandler(req({ dryRun: true }));

    const alias = res.rows.find((r) => r.templateId === 'kincare.report.sent');
    expect(alias).toBeDefined();
    expect(alias?.aliasOf).toBe('kintale.published');
    // Everything else is a live catalog key and carries no alias label.
    expect(res.rows.filter((r) => r.aliasOf !== null)).toHaveLength(1);
  });

  it('HAPPY: covers the whole committed corpus when no ids are named', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await importSeedTemplatesHandler(req({ dryRun: true }));

    expect(res.rows).toHaveLength(SEED_CORPUS.length);
    expect(res.counts.create).toBe(SEED_CORPUS.length * 3);
    expect(res.refused).toEqual([]);
  });
});

describe('planImport: the triple-stash guard reaches imported templates too', () => {
  // The committed corpus is clean, which is exactly why this test supplies its
  // own. The planner is pure, so a poisoned corpus is an argument rather than a
  // mocked module, and no seed file has to be vandalised to prove the guard.
  const poisoned = [
    {
      key: 'kincare.booking.confirm',
      emailSubject: 'Visit confirmed',
      emailHeadline: 'Visit confirmed',
      emailContent: '<p>Hello {{{payload}}}</p>',
      smsTxt: 'Visit confirmed.\n',
      pushTxt: 'Visit confirmed. Tap to see it.\n',
    },
  ];

  it('SAD: blocks a template whose html carries {{{ and says how to fix it', () => {
    const plan = planImport({ corpus: poisoned, existing: {} });

    expect(plan.templates[0].blocked).toBe(true);
    const email = plan.templates[0].channels.find((c) => c.channel === 'email');
    expect(email?.outcome).toBe('blocked');
    expect(email?.notes.join(' ')).toMatch(/triple stash/);
    expect(email?.notes.join(' ')).toMatch(/Change every \{\{\{name\}\}\} to \{\{name\}\}/);
  });

  it('SAD: the report row carries every reason, so the import screens can show it beside Refused (#892 review 2)', () => {
    const plan = planImport({
      corpus: [{ ...poisoned[0], emailContent: '<a href={{link}}>Go</a> {{{payload}}}' }],
      existing: {},
    });
    const [row] = toRows(plan);
    expect(row!.blocked).toBe(true);
    expect(row!.issues.join(' ')).toMatch(/triple stash/);
    expect(row!.issues.join(' ')).toMatch(/without quotes, like href=\{\{link\}\}/);
    expect(row!.issues.every((i) => /^(email|sms|push): /.test(i))).toBe(true);
  });

  it('SAD: a blocked channel holds back the whole template, not just itself', () => {
    const plan = planImport({ corpus: poisoned, existing: {} });

    // sms and push are clean here, and still must not land: half a notification
    // is harder to spot than none of it.
    expect(plan.templates[0].channels.every((c) => c.outcome === 'blocked')).toBe(true);
    expect(plannedWrites(plan)).toEqual([]);
  });

  it('SAD: blocks a sms body carrying a triple stash', () => {
    const plan = planImport({
      corpus: [{ ...poisoned[0], emailContent: '<p>clean</p>', smsTxt: 'Visit {{{raw}}}.\n' }],
      existing: {},
    });

    const sms = plan.templates[0].channels.find((c) => c.channel === 'sms');
    expect(sms?.notes.join(' ')).toMatch(/sms text uses the Handlebars triple stash/);
    expect(plannedWrites(plan)).toEqual([]);
  });

  it('SAD: blocks a directory name that could not be a document id', () => {
    const plan = planImport({
      corpus: [{ ...poisoned[0], key: 'has spaces', emailContent: '<p>clean</p>' }],
      existing: {},
    });

    expect(plan.templates[0].blocked).toBe(true);
    expect(plan.templates[0].issues.join(' ')).toMatch(/template id contains " "/);
  });

  // #953 bridge: the email channel no longer parses a "Subject: " line out of
  // a file (subject.txt IS the subject), so a malformed email.txt can no
  // longer happen here. push.txt is still parsed (parsePushTxt), and is now
  // the channel that exercises the "one bad template doesn't abort the batch"
  // guard this test pins.
  it('SAD: reports a malformed push.txt instead of throwing past the other templates', () => {
    const plan = planImport({
      corpus: [
        { ...poisoned[0], emailContent: '<p>clean</p>', pushTxt: 'no period in this text\n' },
        {
          key: 'invoice.new',
          emailSubject: 'Invoice',
          emailHeadline: 'Invoice',
          emailContent: '<p>clean</p>',
          smsTxt: 'Invoice.\n',
          pushTxt: 'Invoice. Tap to view.\n',
        },
      ],
      existing: {},
    });

    expect(plan.templates[0].blocked).toBe(true);
    expect(plan.templates[0].issues.join(' ')).toMatch(/no period found/i);
    // The second template is unaffected. The importer aborted the run here.
    expect(plan.templates[1].blocked).toBe(false);
  });
});
