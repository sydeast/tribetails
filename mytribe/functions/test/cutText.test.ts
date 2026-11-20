import { describe, it, expect } from 'vitest';
import { cutWhole, cutWithEllipsis } from '../src/lib/cutText';
import { messagePreview, toPlainTextPreview } from '../src/lib/richText';
import { previewOf, PREVIEW_MAX } from '../src/lib/conversations';
import { PORTAL_URL } from '../src/notifications/visitDates';
import { householdNoticeLine } from '../src/notifications/buildNotificationDetail';
import { householdNoticeEntryRoute } from '../src/notifications/noticeOpenTarget';
import { normalizeTitle, MAX_TITLE_CHARS } from '../src/scheduled/aiBatchPollCron';
import { refusalReason, REFUSAL_REASON_MAX } from '../src/portal/emergencyContacts';
import { businessSettingsRefusals } from '../src/lib/businessSettingsChecks';
import {
  HOUSEHOLD_SHORT_LINE_MAX,
  householdPushShelfLine,
  householdSms,
  householdSmsMax,
  householdSmsText,
} from '../src/notifications/templateParsers';

const DOG = '\u{1F415}'; // two storage units
const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'; // three emoji joined: eight units
const WOMAN_DOG = '\u{1F469}\u{1F3FD}\u200D\u{1F9AE}'; // skin tone and a joiner: seven units
const FLAG = '\u{1F1FA}\u{1F1F8}'; // two regional letters: four units
const HEART = '\u2764\uFE0F'; // a heart and its emoji style mark: two units

/** No character in `cut` is a piece of a longer one in `whole`. */
function endsWhole(cut: string, whole: string): boolean {
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let at = 0;
  for (const { segment } of seg.segment(whole)) {
    if (at === cut.length) return true;
    at += segment.length;
    if (at > cut.length) return false;
  }
  return at === cut.length;
}

describe('#2323 cutWhole: a cut never ends on part of a character', () => {
  it('leaves text that fits alone', () => {
    expect(cutWhole('hello', 5)).toBe('hello');
    expect(cutWhole('', 3)).toBe('');
  });
  it('cuts plain text at the limit', () => {
    expect(cutWhole('abcdef', 4)).toBe('abcd');
  });
  it('steps back over an emoji the limit falls inside', () => {
    expect(cutWhole(`${'a'.repeat(199)}${DOG} tail`, 200)).toBe('a'.repeat(199));
  });
  it('keeps an emoji that ends exactly on the limit', () => {
    expect(cutWhole(`${'a'.repeat(198)}${DOG} tail`, 200)).toBe(`${'a'.repeat(198)}${DOG}`);
  });
  it.each([
    ['a family joined with invisible joiners', FAMILY],
    ['a person with a skin tone and a dog', WOMAN_DOG],
    ['a flag', FLAG],
    ['a heart with its emoji mark', HEART],
  ])('never keeps part of %s, wherever the limit falls inside it', (_label, glyph) => {
    for (let lead = 200 - glyph.length + 1; lead < 200; lead++) {
      const text = `${'a'.repeat(lead)}${glyph} more`;
      expect(cutWhole(text, 200)).toBe('a'.repeat(lead));
    }
    const exact = `${'a'.repeat(200 - glyph.length)}${glyph} more`;
    expect(cutWhole(exact, 200)).toBe(`${'a'.repeat(200 - glyph.length)}${glyph}`);
  });
  it('drops a single character longer than the whole budget instead of halving it', () => {
    expect(cutWhole(FAMILY, 3)).toBe('');
    expect(cutWhole('abc', 0)).toBe('');
  });
  it('is never longer than the limit and always ends whole, on a mixed message', () => {
    const text = `Hi ${FAMILY}! ${WOMAN_DOG} walked ${FLAG} ${HEART}${DOG}`.repeat(8);
    for (let max = 0; max <= text.length; max++) {
      const cut = cutWhole(text, max);
      expect(cut.length).toBeLessThanOrEqual(max);
      expect(endsWhole(cut, text)).toBe(true);
    }
  });
  it('cutWithEllipsis counts the ellipsis inside the limit', () => {
    expect(cutWithEllipsis('abcdef', 4)).toBe('abc…');
    expect(cutWithEllipsis('abcd', 4)).toBe('abcd');
  });
});

describe('#2323 every server preview cuts on whole characters', () => {
  it('messagePreview from the issue: 199 letters then a dog ends on a whole character', () => {
    expect(messagePreview(`${'a'.repeat(199)}${DOG} tail`, 200)).toBe('a'.repeat(199));
  });
  it('toPlainTextPreview does the same', () => {
    expect(toPlainTextPreview(`<p>${'a'.repeat(197)}${FAMILY}</p>`, 200)).toBe('a'.repeat(197));
  });
  it('the messages list preview ends whole before its ellipsis', () => {
    const body = `${'a'.repeat(PREVIEW_MAX - 2)}${DOG} more`;
    expect(previewOf(body)).toBe(`${'a'.repeat(PREVIEW_MAX - 2)}…`);
  });
  it('the household push line ends whole before its ellipsis', () => {
    const line = householdPushShelfLine(`${'a'.repeat(195)}${WOMAN_DOG} and on`);
    expect(line).toBe(`${'a'.repeat(195)}…`);
  });
});

describe('#2323 the other lines a person reads cut on whole characters', () => {
  it('the notice line of a new message ends whole before its ellipsis', () => {
    const preview = `${'a'.repeat(138)}${DOG} and more`;
    expect(householdNoticeLine({ key: 'message.reply', data: { preview } })).toBe(`${'a'.repeat(138)}…`);
  });
  it('a KinTale title the model wrote too long ends whole', () => {
    const title = normalizeTitle(`${'a'.repeat(MAX_TITLE_CHARS - 1)}${FAMILY} tail`);
    expect(title).toBe('a'.repeat(MAX_TITLE_CHARS - 1));
  });
  it('a refusal kept in the Activity Log ends whole before its ellipsis', () => {
    const reason = refusalReason(`${'a'.repeat(REFUSAL_REASON_MAX - 2)}${FLAG} tail`);
    expect(reason).toBe(`${'a'.repeat(REFUSAL_REASON_MAX - 2)}…`);
  });
  it('a KinCare name too long to keep is quoted back whole', () => {
    const name = `${'a'.repeat(19)}${DOG}${'b'.repeat(70)}`;
    const refusals = businessSettingsRefusals(
      { serviceRates: { [name]: 25 } },
      { stored: {}, todayIso: '2026-11-20', cloudName: 'demo' },
    );
    expect(refusals).toEqual([
      { field: 'serviceRates', message: `Keep the name "${'a'.repeat(19)}..." under 80 characters.` },
    ]);
  });
});
describe('#2371 a household text message links to its own entry', () => {
  it('an entry id is one query value, whatever is in it', () => {
    expect(householdNoticeEntryRoute('n-1')).toBe('/notifications?entry=n-1');
    expect(householdNoticeEntryRoute('a/b?c=d&e#f')).toBe('/notifications?entry=a%2Fb%3Fc%3Dd%26e%23f');
    expect(householdNoticeEntryRoute('')).toBe('/notifications');
  });
  const ENTRY = '/notifications?entry=n-1';
  it('a short message links to the entry', () => {
    expect(householdSms('Your Auntie arrived.', PORTAL_URL, ENTRY)).toEqual({
      text: `Your Auntie arrived. More in MyTribe: ${PORTAL_URL}${ENTRY}`,
      cut: false,
    });
  });
  it('a long message is cut, says so, and links to the entry', () => {
    const long = `${'The walk went well and the Kin napped after. '.repeat(6)}End.`;
    const sms = householdSms(long, PORTAL_URL, ENTRY);
    expect(sms.cut).toBe(true);
    expect(sms.text.endsWith(`... More in MyTribe: ${PORTAL_URL}${ENTRY}`)).toBe(true);
    expect(sms.text.length).toBeLessThanOrEqual(householdSmsMax(PORTAL_URL, ENTRY));
  });
  it('the "already links and fits" rule measures the longer entry link', () => {
    const own = `${'a'.repeat(150)} Every date: ${PORTAL_URL}`;
    expect(householdSms(own, PORTAL_URL, ENTRY)).toEqual({ text: own, cut: false });
  });
  it('a web address the cut lands inside is dropped whole', () => {
    const words = `${'word '.repeat(37)}see https://example.org/a/very/long/path/that/runs/past/the/limit ok`;
    const text = householdSmsText(words, PORTAL_URL, ENTRY);
    expect(text).not.toContain('https://example.org');
    expect(text.endsWith(`see... More in MyTribe: ${PORTAL_URL}${ENTRY}`)).toBe(true);
  });
  it('an emoji joined with others at the cut is dropped whole', () => {
    const body = `${'a'.repeat(HOUSEHOLD_SHORT_LINE_MAX - 6)}${FAMILY} rest of it`;
    const text = householdSmsText(body, PORTAL_URL, ENTRY);
    expect(text).toBe(`${'a'.repeat(HOUSEHOLD_SHORT_LINE_MAX - 6)}... More in MyTribe: ${PORTAL_URL}${ENTRY}`);
  });
  it('with no entry the link is the notifications list, as before', () => {
    expect(householdSmsText('Hi.', PORTAL_URL)).toBe(`Hi. More in MyTribe: ${PORTAL_URL}/notifications`);
  });
});
