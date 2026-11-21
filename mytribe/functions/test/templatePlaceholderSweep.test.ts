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
  // Sent straight to an address by membership/acceptInvite.ts, outside the catalog.
  'invite.verify-email': 'direct send, covered by the direct-send fixtures',
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

async function contextFor(fx: EmitterFixture): Promise<Record<string, unknown>> {
  const enriched = await enrichTemplateData(fx.key, fx.recipientUid, fx.data, [], fx.stream === 'kinfolk');
  return { ...enriched, recipientUid: fx.recipientUid, notificationKey: fx.key };
}

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
describe('the direct send with a seed fills every token from its sender (#2487)', () => {
  it('invite.verify-email, as membership/acceptInvite.ts sends it', () => {
    // acceptInvite passes these three and nothing else; no enricher runs.
    const data = {
      invitedEmail: WORLD.primaryEmail,
      verifyUrl: 'https://kinfolk.tribetails.com/account/action?mode=verifyEmail&oobCode=abc',
      claimUrl: 'https://kinfolk.tribetails.com/claim/i1',
    };
    const problems: string[] = [];
    for (const part of partsOf('invite.verify-email')) {
      for (const p of printedTokens(part.template, data)) {
        if (isBlank(p.value)) problems.push(`${part.name}: {{${p.token}}}`);
      }
    }
    expect(problems).toEqual([]);
    const html = renderedTexts('invite.verify-email', data)['email html'];
    // A link keeps its query string whole in the button.
    expect(html).toContain('href="https://kinfolk.tribetails.com/account/action?mode=verifyEmail&oobCode=abc"');
  });
});
