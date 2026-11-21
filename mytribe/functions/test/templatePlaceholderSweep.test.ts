import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { DECOYS, WORLD, WORLD_DOCS, WORLD_QUERIES } from './_helpers/noticeWorld';
import { isBlank, printedTokens } from './_helpers/liveTokens';
import { EMITTER_FIXTURES, NOT_TEMPLATE_RENDERS, fixtureId, type EmitterFixture } from './_helpers/emitterFixtures';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));

import { SEED_CORPUS } from '../src/notifications/seedCorpus.generated';
import { NOTIFICATION_EMITTERS, NEVER_FIRES } from '../src/notifications/provenance';
import { NOTIFICATION_KEY_ALIASES, getNotificationDef } from '../src/notifications/catalog';
import { enrichTemplateData } from '../src/notifications/enrichTemplateData';
import { sendPartsFor } from '../src/lib/emailFrame';
import { renderEmailParts } from '../src/lib/email';
import { kinForStoredTemplate, parsePushTxt, renderPlainText } from '../src/notifications/templateParsers';
import { resolveTargetRef } from '../src/notifications/dispatcher';
import { noticeOpenTarget } from '../src/notifications/noticeOpenTarget';
import { ADMIN_URL, noticeLink } from '../src/notifications/noticeLink';
import { PORTAL_URL } from '../src/notifications/visitDates';

/**
 * #2487 (owner report): "templates need placeholders that actually work".
 *
 * Every seed template, on every channel (email subject, headline and body,
 * text message, push title and body), rendered for every emitter that really
 * sends its key, through the REAL enricher against a small Tribe stored the
 * way the writers store it (`noticeWorld.ts`), and through the senders' own
 * renderers. A token fails the sweep when the branch it sits in is live and it
 * prints nothing, not only when its braces survive: the senders blank a missing
 * token, so "no leftover {{ }}" is true of a message that reads "Hi , your
 * invoice  is ready".
 *
 * The world carries decoys (a second Kin, a second invoice and visit, a second
 * household). Every message must name THIS notice's records and none of the
 * decoys, which is also the proof that a notice never carries another
 * household's data.
 *
 * The payloads are the call sites' own (`emitterFixtures.ts`, one per emitter,
 * each a subset of what provenance says that emitter sends), so an emitter that
 * does not send what its template prints is red here.
 */

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEventFn.mockReset();
  mocks.dbFn.mockReturnValue(buildDbMock({ docs: { ...WORLD_DOCS }, queryDocs: WORLD_QUERIES }).db);
});

/** Seeds that no emitter sends, each with the reason. Anything else must have emitters. */
const UNSENT_SEEDS: Record<string, string> = {
  // A legacy alias: a send under it is sent as `kintale.published`.
  'kincare.report.sent': 'alias of kintale.published',
  // Sent straight to an address with sendFromTemplate, outside the catalog.
  'invite.verify-email': 'direct send, covered by DIRECT_SENDS below',
  'invite.primary': 'direct send, covered by DIRECT_SENDS below',
  'invite.secondary': 'direct send, covered by DIRECT_SENDS below',
  'invite.primary-receipt': 'direct send, covered by DIRECT_SENDS below',
  'invite.auntie-notify': 'direct send, covered by DIRECT_SENDS below',
  'recovery.requested': 'direct send, covered by DIRECT_SENDS below',
  'recovery.completed': 'direct send, covered by DIRECT_SENDS below',
};
for (const key of NEVER_FIRES) UNSENT_SEEDS[key] = 'listed in NEVER_FIRES';

const seedByKey = new Map(SEED_CORPUS.map((s) => [s.key, s]));

interface Part {
  name: string;
  template: string;
}

function partsOf(key: string): Part[] {
  const seed = seedByKey.get(key)!;
  const push = parsePushTxt(seed.pushTxt);
  return [
    { name: 'email subject', template: seed.emailSubject },
    { name: 'email headline', template: seed.emailHeadline },
    { name: 'email content', template: seed.emailContent },
    { name: 'text message', template: seed.smsTxt },
    { name: 'push title', template: push.title },
    { name: 'push body', template: push.body },
  ];
}

/**
 * The context the channel trigger hands a sender: the enriched data, plus
 * `{{link}}` built the way the trigger builds it, from the target the
 * dispatcher would stamp on the work order (`resolveTargetRef`).
 */
async function contextFor(fx: EmitterFixture): Promise<Record<string, unknown>> {
  const enriched = await enrichTemplateData(fx.key, fx.recipientUid, fx.data, [], fx.stream === 'kinfolk');
  const target = resolveTargetRef({ key: fx.key, recipientUid: fx.recipientUid, data: fx.data, ...(fx.target ?? {}) } as never);
  const open = noticeOpenTarget({ key: fx.key, stream: fx.stream, data: fx.data, ...target, notificationId: 'n1' });
  const auntie = getNotificationDef(fx.key).recipientResolver === 'auntieAssignedToKincare' && fx.stream !== 'kinfolk';
  const link = noticeLink({ key: fx.key, stream: fx.stream, auntie, data: fx.data, ...target, open });
  const supplied = enriched['link'];
  return {
    ...enriched,
    ...(typeof supplied === 'string' && supplied !== '' ? {} : { link }),
    recipientUid: fx.recipientUid,
    notificationKey: fx.key,
  };
}

/** Tokens that are a link a reader follows. */
const LINK_TOKENS = new Set(['link', 'claimUrl', 'verifyUrl', 'auntieReviewUrl']);

/** What each sender actually sends, rendered the way it renders it. */
function renderedTexts(key: string, ctx: Record<string, unknown>): Record<string, string> {
  const seed = seedByKey.get(key)!;
  const email = renderEmailParts({
    ...sendPartsFor({ subject: seed.emailSubject, format: 'visual', headline: seed.emailHeadline, content: seed.emailContent }),
    data: kinForStoredTemplate(ctx, [seed.emailSubject, seed.emailHeadline, seed.emailContent]),
  });
  const push = parsePushTxt(seed.pushTxt);
  return {
    'email subject': email.subject,
    'email text': email.text,
    'email html': email.html ?? '',
    'text message': renderPlainText(seed.smsTxt, kinForStoredTemplate(ctx, [seed.smsTxt])),
    'push title': renderPlainText(push.title, ctx),
    'push body': renderPlainText(push.body, ctx),
  };
}

describe('every seed placeholder fills with a real value, for every emitter (#2487)', () => {
  it('every seed is either sent by an emitter with a fixture, or listed as unsent with a reason', () => {
    for (const seed of SEED_CORPUS) {
      if (UNSENT_SEEDS[seed.key]) continue;
      const emitters = NOTIFICATION_EMITTERS[seed.key] ?? [];
      expect(emitters.length, `${seed.key} has a seed and no emitter`).toBeGreaterThan(0);
    }
  });

  it('the fixture table is exactly the emitter table: one fixture per (key, source)', () => {
    const expected = Object.entries(NOTIFICATION_EMITTERS)
      .filter(([key]) => seedByKey.has(key))
      .flatMap(([key, ems]) => ems.map((e) => fixtureId(key, e.source)))
      .filter((id) => !NOT_TEMPLATE_RENDERS[id])
      .sort();
    const actual = [...new Set(EMITTER_FIXTURES.map((f: EmitterFixture) => fixtureId(f.key, f.source)))].sort();
    expect(actual).toEqual(expected);
  });

  it("each fixture sends only what its emitter's provenance row says it sends", () => {
    for (const fx of EMITTER_FIXTURES) {
      const row = (NOTIFICATION_EMITTERS[fx.key] ?? []).find((e) => e.source === fx.source);
      expect(row, fixtureId(fx.key, fx.source)).toBeDefined();
      const allowed = new Set(row!.dataKeys);
      const extra = Object.keys(fx.data).filter((k) => !allowed.has(k));
      expect(extra, `${fixtureId(fx.key, fx.source)} sends keys its provenance row does not list`).toEqual([]);
    }
  });

  for (const fx of EMITTER_FIXTURES) {
    const id = `${fixtureId(fx.key, fx.source)}${fx.variant ? ` [${fx.variant}]` : ''} (${fx.stream})`;
    it(`${id}: every printed token has a value, and the right one`, async () => {
      // The catalog knows the key, and the copy goes to the stream the fixture says.
      expect(() => getNotificationDef(fx.key)).not.toThrow();
      const ctx = await contextFor(fx);

      const problems: string[] = [];
      for (const part of partsOf(fx.key)) {
        for (const p of printedTokens(part.template, ctx)) {
          if (isBlank(p.value)) problems.push(`${part.name}: {{${p.token}}} prints nothing`);
        }
      }
      expect(problems).toEqual([]);

      // #2487: every notice links to its item, for this reader, on the reader's own site.
      const printed = partsOf(fx.key).flatMap((part) => printedTokens(part.template, ctx));
      expect(printed.some((p) => LINK_TOKENS.has(p.token)), `${id} prints no link`).toBe(true);
      const link = String(ctx['link']);
      if (fx.key !== 'auth.password.reset') {
        expect(link.startsWith(fx.stream === 'kinfolk' ? `${PORTAL_URL}/` : `${ADMIN_URL}/`), `${id}: ${link}`).toBe(true);
      }
      if (fx.link !== undefined) expect(link, `${id}: {{link}}`).toBe(fx.link);
      if (fx.aboutRex) {
        expect(link, `${id}: a notice about one record links to it, not to the list`).not.toMatch(/\/notifications(\?|$)/);
      }

      for (const [name, text] of Object.entries(renderedTexts(fx.key, ctx))) {
        expect(text, `${id} ${name}`).not.toMatch(/\{\{|\}\}/);
        for (const decoy of [...DECOYS, ...(fx.aboutRex ? ['Biscuit'] : [])]) {
          expect(text, `${id} ${name} names a record this notice is not about`).not.toContain(decoy);
        }
        for (const [token, want] of Object.entries(fx.expect ?? {})) {
          if (printedIn(fx.key, token, ctx)) {
            expect(String(ctx[token]), `${id}: {{${token}}}`).toBe(want);
          }
        }
      }
    });
  }
});

/** Whether any live branch of any part of this key's seed prints `token`. */
function printedIn(key: string, token: string, ctx: Record<string, unknown>): boolean {
  return partsOf(key).some((part) => printedTokens(part.template, ctx).some((p) => p.token === token));
}

describe('the sweep itself is not vacuous', () => {
  it('a token that is printed and missing is caught', () => {
    expect(printedTokens('Hi {{kinfolkName}}', {}).filter((p) => isBlank(p.value))).toHaveLength(1);
  });
  it('a guarded token is not printed when its guard is off, and is when it is on', () => {
    expect(printedTokens('{{#if note}}Note: {{note}}{{/if}}', {})).toEqual([]);
    expect(printedTokens('{{#if kinAdded}}{{addedKinName}}{{else}}{{kinName}}{{/if}}', { kinAdded: true })).toEqual([
      { token: 'addedKinName', value: undefined },
    ]);
  });
  it('an empty list a template walks is caught', () => {
    expect(printedTokens('{{#each visits}}<li>{{this.date}}</li>{{/each}}', { visits: [] })).toEqual([
      { token: 'visits', value: [] },
    ]);
  });
  it('the household world names Rex, and the decoys are not in it by accident', () => {
    expect(WORLD.kinName).toBe('Rex');
    expect(DECOYS).not.toContain(WORLD.kinName);
    expect(NOTIFICATION_KEY_ALIASES).toBeDefined();
  });
});
/**
 * The direct sends with a repo copy, each with the data its sender passes
 * (`sendFromTemplate` adds `{{Business}}` itself). No enricher runs on them.
 */
const CLAIM = 'https://kinfolk.tribetails.com/claim/i1?invite=i1';
const NAMES = { primaryDisplayName: WORLD.primaryName, tribeName: WORLD.householdName, kinfolkName: WORLD.primaryName };
const DIRECT_SENDS: Array<{ key: string; source: string; data: Record<string, unknown> }> = [
  {
    key: 'invite.verify-email',
    source: 'src/membership/acceptInvite.ts',
    data: {
      invitedEmail: WORLD.primaryEmail,
      verifyUrl: 'https://kinfolk.tribetails.com/account/action?mode=verifyEmail&oobCode=abc',
      claimUrl: CLAIM,
    },
  },
  {
    key: 'invite.primary',
    source: 'src/admin/inviteKinfolkToPortal.ts, mintInvite.ts, provisionTribe.ts',
    data: { ...NAMES, claimUrl: CLAIM, expiresInDays: 14, Business: WORLD.businessName, business: WORLD.businessName },
  },
  {
    key: 'invite.secondary',
    source: 'src/lib/inviteEmails.ts',
    data: { primaryDisplayName: 'Maya', secondaryDisplayName: 'there', secondaryLabel: 'CoParent', tribeName: WORLD.householdName, claimUrl: CLAIM, expiresInDays: 14 },
  },
  {
    key: 'invite.primary-receipt',
    source: 'src/lib/inviteEmails.ts',
    data: { invitedEmail: 'pawsome@hanasamku.com', secondaryLabel: 'CoParent', tribeName: WORLD.householdName, expiresInDays: 14 },
  },
  {
    key: 'invite.auntie-notify',
    source: 'src/lib/inviteEmails.ts',
    data: {
      primaryDisplayName: 'Maya',
      invitedEmail: 'pawsome@hanasamku.com',
      secondaryLabel: 'CoParent',
      tribeName: WORLD.householdName,
      permissionsCsv: 'messaging_direct',
      auntieReviewUrl: 'https://auntie.tribetails.com/invites/i1',
    },
  },
  { key: 'recovery.requested', source: 'src/recovery/requestPrimaryRecovery.ts', data: { tribeName: WORLD.householdName, method: 'email' } },
  { key: 'recovery.completed', source: 'src/admin/executePrimaryRecovery.ts', data: { tribeName: WORLD.householdName, claimUrl: CLAIM } },
];

/** The same sends with no name on file: the fallbacks `lib/inviteNames.ts` and `lib/inviteEmails.ts` use. */
const NO_NAMES = { primaryDisplayName: 'there', tribeName: 'the household', kinfolkName: 'there' };
const FALLBACK_SENDS: Array<{ key: string; data: Record<string, unknown> }> = [
  { key: 'invite.primary', data: { ...NO_NAMES, claimUrl: CLAIM, expiresInDays: 14, Business: 'Your Auntie', business: 'your Auntie' } },
  { key: 'invite.secondary', data: { primaryDisplayName: 'Your household', secondaryDisplayName: 'there', tribeName: 'the household', claimUrl: CLAIM, expiresInDays: 14 } },
  { key: 'invite.auntie-notify', data: { primaryDisplayName: 'The household', invitedEmail: 'pawsome@hanasamku.com', tribeName: 'the household', auntieReviewUrl: 'https://auntie.tribetails.com/invites/i1' } },
];

describe('the direct sends with a repo copy fill every token from their sender (#2487)', () => {
  it('covers every direct-send seed', () => {
    const direct = Object.keys(UNSENT_SEEDS).filter((k) => UNSENT_SEEDS[k]!.startsWith('direct send')).sort();
    expect(DIRECT_SENDS.map((d) => d.key).sort()).toEqual(direct);
  });

  for (const d of DIRECT_SENDS) {
    it(`${d.key} <- ${d.source}`, () => {
      const problems: string[] = [];
      for (const part of partsOf(d.key)) {
        for (const p of printedTokens(part.template, d.data)) {
          if (isBlank(p.value)) problems.push(`${part.name}: {{${p.token}}}`);
        }
      }
      expect(problems).toEqual([]);
      const texts = renderedTexts(d.key, d.data);
      for (const [name, text] of Object.entries(texts)) {
        expect(text, `${d.key} ${name}`).not.toMatch(/\{\{|\}\}/);
        for (const decoy of DECOYS) expect(text, `${d.key} ${name}`).not.toContain(decoy);
      }
    });
  }

  for (const f of FALLBACK_SENDS) {
    it(`${f.key} with no name on file never reads "Welcome, there" or leaves a lowercase word starting a sentence`, () => {
      const texts = renderedTexts(f.key, f.data);
      for (const [name, text] of Object.entries(texts)) {
        if (name === 'email html') continue;
        expect(text, `${f.key} ${name}`).not.toMatch(/, there\b(?!,)/);
        expect(text, `${f.key} ${name}`).not.toMatch(/(^|[.!?]\s+)(there|the household)\b/);
        // A capital mid-sentence: "invited you, Your household".
        expect(text, `${f.key} ${name}`).not.toMatch(/[a-z,] +(Your|The) household\b/);
      }
    });
  }

  it('a link keeps its query string whole in the button', () => {
    const html = renderedTexts('invite.verify-email', DIRECT_SENDS[0]!.data)['email html'];
    expect(html).toContain('href="https://kinfolk.tribetails.com/account/action?mode=verifyEmail&oobCode=abc"');
  });

  it('the portal invite carries its accept link as a button', () => {
    const html = renderedTexts('invite.primary', DIRECT_SENDS[1]!.data)['email html'];
    expect(html).toContain(`href="${CLAIM}"`);
  });
});
