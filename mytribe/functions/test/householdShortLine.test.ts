import { describe, it, expect } from 'vitest';
import { SEED_CORPUS } from '../src/notifications/seedCorpus.generated';
import { NOTIFICATION_CATALOG } from '../src/notifications/catalog';
import { resolveChannels } from '../src/notifications/prefs';
import { PORTAL_URL } from '../src/notifications/visitDates';
import { sampleDataFor } from '../src/admin/previewEmailTemplate';
import {
  HOUSEHOLD_NOTICE_ROUTE,
  HOUSEHOLD_SHORT_LINE_MAX,
  HOUSEHOLD_SMS_LINK_LABEL,
  householdPushLineIsCut,
  householdPushShelfLine,
  householdSmsMax,
  householdSmsText,
  parsePushTxt,
  renderPlainText,
} from '../src/notifications/templateParsers';
import {
  HOUSEHOLD_PUSH_ROUTE,
  HOUSEHOLD_PUSH_SHELF_MAX,
  householdPushShelfLine as communicateShelfLine,
} from '../src/admin/sendHouseholdPush';

/**
 * #2280, operator ruling 2026-11-14: a household's text message and push stay
 * short, with a link to the full message in MyTribe. Email is the only channel
 * that is on unless the household turns another on.
 */

const LINK = `${HOUSEHOLD_SMS_LINK_LABEL} ${PORTAL_URL}${HOUSEHOLD_NOTICE_ROUTE}`;
const householdKeys = Object.values(NOTIFICATION_CATALOG).filter((d) => d.audiences.kinfolk === true);

describe('the short line and its link', () => {
  it('the link is the notifications list in MyTribe', () => {
    expect(LINK).toBe('More in MyTribe: https://kinfolk.tribetails.com/notifications');
    expect(HOUSEHOLD_SHORT_LINE_MAX).toBe(200);
    expect(householdSmsMax(PORTAL_URL)).toBe(200 + 1 + LINK.length);
  });

  it('a Communicate push and a notice push are cut by one rule', () => {
    expect(communicateShelfLine).toBe(householdPushShelfLine);
    expect(HOUSEHOLD_PUSH_SHELF_MAX).toBe(HOUSEHOLD_SHORT_LINE_MAX);
    expect(HOUSEHOLD_PUSH_ROUTE).toBe(HOUSEHOLD_NOTICE_ROUTE);
  });

  it('an empty render is left empty, not turned into a bare link', () => {
    expect(householdSmsText('   ', PORTAL_URL)).toBe('');
  });

  it('line breaks become spaces, so the cut counts what the phone shows', () => {
    expect(householdSmsText('One.\n\nTwo.', PORTAL_URL)).toBe(`One. Two. ${LINK}`);
    expect(householdPushShelfLine('One.\n\nTwo.')).toBe('One. Two.');
  });

  // An emoji is two code units. Whatever the cut lands on, no half is sent.
  const loneHalf = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  it.each([193, 194, 195, 196, 197, 198, 199, 200])(
    'an emoji across the cut is dropped whole, never halved (%i letters before it)',
    (lead) => {
      const text = `${'a'.repeat(lead)}${'\u{1F436}'.repeat(40)}`;
      const sms = householdSmsText(text, PORTAL_URL);
      const push = householdPushShelfLine(text);
      expect(loneHalf.test(sms)).toBe(false);
      expect(loneHalf.test(push)).toBe(false);
      expect(sms.endsWith(`... ${LINK}`)).toBe(true);
      expect(sms.length).toBeLessThanOrEqual(householdSmsMax(PORTAL_URL));
      expect(push.endsWith('…')).toBe(true);
      expect(push.length).toBeLessThanOrEqual(HOUSEHOLD_SHORT_LINE_MAX);
    },
  );

  it('a text message is cut at the end of a word, not inside one', () => {
    const sent = householdSmsText(`${'Please leave the gate unlatched. '.repeat(5)}Thirty-three more words follow here and on.`, PORTAL_URL);
    const line = sent.slice(0, -LINK.length - 1);
    expect(line.length).toBeLessThanOrEqual(HOUSEHOLD_SHORT_LINE_MAX);
    expect(line).toBe(`${'Please leave the gate unlatched. '.repeat(5)}Thirty-three more words follow...`);
  });

  it('an address typed into a note is dropped whole when the cut lands inside it', () => {
    const lead = 'Tribe Tails: the Drop-In Visit for Biscuit is still on. '.repeat(3).trim();
    const sent = householdSmsText(`${lead} The form is at https://forms.tribetails.com/intake/2026/household/updated-entry-details?ref=note thanks`, PORTAL_URL);
    expect(sent).toBe(`${lead} The form is at... ${LINK}`);
    expect(sent.match(/https:\/\/\S+/g)).toEqual([`${PORTAL_URL}${HOUSEHOLD_NOTICE_ROUTE}`]);
  });

  it('one long run of letters with no space is still cut, not dropped', () => {
    const sent = householdSmsText(`Hello ${'x'.repeat(400)}`, PORTAL_URL);
    expect(sent).toBe(`Hello ${'x'.repeat(191)}... ${LINK}`);
  });

  it('a message that ends exactly on the limit is not cut', () => {
    const exact = `${'word '.repeat(39)}fives`;
    expect(exact.length).toBe(HOUSEHOLD_SHORT_LINE_MAX);
    expect(householdSmsText(exact, PORTAL_URL)).toBe(`${exact} ${LINK}`);
  });
});

describe('every household text message and push in the repo templates', () => {
  /**
   * The worst case each template can be handed: the office's note at its 500
   * character limit, a household with many Kin, a long service name.
   */
  const worstCase = (key: string): Record<string, unknown> => ({
    ...sampleDataFor(key),
    note: 'Please leave the side gate unlatched and the porch light on. '.repeat(9).trim().slice(0, 500),
    kinName: 'Biscuit, Mochi, Captain Whiskers, Sir Barksalot and Princess Buttercup',
    serviceType: 'Extended Overnight Stay with Medication',
    kinfolkName: 'Alexandria',
    portalUrl: PORTAL_URL,
    // #2487: the item's own address, which a visit text prints as `{{link}}`.
    link: `${PORTAL_URL}/schedule/v1`,
    preview: 'x'.repeat(200),
  });
  // The senders' own renderer (#2321), so this measures what is sent.
  const render = (tpl: string, key: string) => renderPlainText(tpl, worstCase(key));

  it('there is something to check', () => {
    expect(householdKeys.length).toBeGreaterThan(20);
  });

  for (const def of householdKeys) {
    const seed = SEED_CORPUS.find((s) => s.key === def.templates.sms || s.key === def.templates.push);
    if (!seed) continue;

    it(`${def.key}: the text message is short and links into MyTribe`, () => {
      const sent = householdSmsText(render(seed.smsTxt, def.key), PORTAL_URL);
      expect(sent.length).toBeLessThanOrEqual(householdSmsMax(PORTAL_URL));
      expect(sent).toContain(PORTAL_URL);
      // One whole address, never a cut one.
      expect(sent.match(/https:\/\/\S+/g)).toHaveLength(1);
      expect(sent.match(/https:\/\/\S+/)![0]).toMatch(/^https:\/\/kinfolk\.tribetails\.com(\/notifications|\/schedule\/v1)?$/);
      // No character that would force the costlier encoding.
      expect(sent).not.toContain('…');
    });

    it(`${def.key}: the push is short`, () => {
      const { body } = parsePushTxt(seed.pushTxt);
      expect(householdPushShelfLine(render(body, def.key)).length).toBeLessThanOrEqual(HOUSEHOLD_SHORT_LINE_MAX);
    });
  }

  it('the four text messages that carry the office note are cut, not sent whole', () => {
    for (const key of ['kincare.request.declined', 'kincare.cancel.declined', 'kin.removal.declined', 'kin.removal.archived']) {
      const seed = SEED_CORPUS.find((s) => s.key === key)!;
      expect(seed.smsTxt, key).toContain('{{note}}');
      const raw = render(seed.smsTxt, key);
      expect(raw.length, key).toBeGreaterThan(500);
      const sent = householdSmsText(raw, PORTAL_URL);
      expect(sent.endsWith(`... ${LINK}`), key).toBe(true);
    }
  });
});

describe('what reaches a household that has changed no setting', () => {
  it('no household notice forces push or text messages on', () => {
    for (const def of householdKeys) {
      expect(def.required.push, `${def.key} push`).toBeUndefined();
      expect(def.required.sms, `${def.key} sms`).toBeUndefined();
    }
  });

  it('email is the only channel on by default, on every household notice', () => {
    for (const def of householdKeys) {
      const channels = resolveChannels(def, {}, null, 'kinfolk');
      expect(channels.push, `${def.key} push`).toBe(false);
      expect(channels.sms, `${def.key} sms`).toBe(false);
      // Marketing rows wait for an opt-in; every other row emails when it can.
      if (!def.marketingCategory && def.allowedChannels.includes('email')) {
        expect(channels.email, `${def.key} email`).toBe(true);
      }
    }
  });
});

describe('householdPushLineIsCut: whether the push line lost any of the message', () => {
  it('200 characters fit and 201 do not', () => {
    expect(householdPushLineIsCut('x'.repeat(HOUSEHOLD_SHORT_LINE_MAX))).toBe(false);
    expect(householdPushLineIsCut('x'.repeat(HOUSEHOLD_SHORT_LINE_MAX + 1))).toBe(true);
  });
  it('measures the line as sent: folded line breaks and outer spaces are not a cut', () => {
    expect(householdPushLineIsCut(`  ${'x'.repeat(99)}\n\n\n\n\n${'y'.repeat(100)}  `)).toBe(false);
    expect(householdPushLineIsCut('')).toBe(false);
  });
  it.each([0, 1, 199, 200, 201, 500])('agrees with the line itself at %i characters', (n) => {
    const text = 'word '.repeat(Math.ceil(n / 5)).slice(0, n).trim();
    const flat = text.replace(/\s+/g, ' ').trim();
    expect(householdPushLineIsCut(text)).toBe(householdPushShelfLine(text) !== flat);
  });
});
