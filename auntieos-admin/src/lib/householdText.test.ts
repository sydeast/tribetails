import { describe, expect, it } from 'vitest';
import {
  householdTextAccountOf,
  householdTextAsSent,
  householdTextChannelLine,
  householdTextPreview,
  householdTextPreviewLine,
  householdWholeTextParts,
  MYTRIBE_URL,
  SMS_BODY_MAX,
} from './householdText';
/**
 * #2408: what a household is texted for an approved Text draft. The expected
 * lines are the server's `householdSms` answers for the same words, so the
 * confirm shows the text that is sent. The same vectors are asserted on admin
 * Android and the desktop console (`HouseholdTextTest`).
 */
const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
describe('householdTextPreview', () => {
  it('a short message goes whole, with the link after it', () => {
    expect(householdTextPreview('See you Friday at 9.')).toEqual({ line: 'See you Friday at 9.', cut: false, linkAdded: true });
    expect(householdTextPreview('h'.repeat(200))).toEqual({ line: 'h'.repeat(200), cut: false, linkAdded: true });
  });
  it('a long message is cut at the end of a word, with its line breaks folded', () => {
    const body =
      'Biscuit had a grand morning.\n\nShe ate all of her breakfast, went twice round the long field and made friends ' +
      'with the new spaniel at the gate. We found the missing blue lead behind the shed, and her coat is brushed out ' +
      'ready for Friday. Bring the red harness if you can.';
    expect(householdTextPreview(body)).toEqual({
      line:
        'Biscuit had a grand morning. She ate all of her breakfast, went twice round the long field and made friends ' +
        'with the new spaniel at the gate. We found the missing blue lead behind the shed, and her...',
      cut: true,
      linkAdded: true,
    });
  });
  it('one character over is cut', () => {
    expect(householdTextPreview('h'.repeat(201))).toEqual({ line: `${'h'.repeat(197)}...`, cut: true, linkAdded: true });
  });
  it('never ends on part of an emoji', () => {
    expect(householdTextPreview('a'.repeat(190) + family.repeat(6)).line).toBe(`${'a'.repeat(190)}...`);
  });
  it('steps back over a short unfinished word, and keeps the start of a very long one', () => {
    expect(householdTextPreview(`${'e'.repeat(185)} fghij klmnopqrstu vwxyz`).line).toBe(`${'e'.repeat(185)} fghij...`);
    expect(householdTextPreview(`${'b'.repeat(150)} ${'c'.repeat(80)}`).line).toBe(`${'b'.repeat(150)} ${'c'.repeat(46)}...`);
    expect(householdTextPreview(`${'g '.repeat(120)}end`).line).toBe(`${'g '.repeat(99).trim()}...`);
  });
  it('drops a web address the cut landed inside, however long', () => {
    const body = `${'d'.repeat(170)} https://example.org/a/very/long/path/that/keeps/going/on/and/on`;
    expect(householdTextPreview(body).line).toBe(`${'d'.repeat(170)}...`);
  });
  it('a message that already links to MyTribe and fits goes as written, with no second link', () => {
    const body = `Every date: ${MYTRIBE_URL}/schedule and more.`;
    expect(householdTextPreview(body)).toEqual({ line: body, cut: false, linkAdded: false });
    expect(householdTextPreviewLine(body)).toBe(body);
  });
  it('a long message has its own MyTribe link taken out before the cut', () => {
    const p = householdTextPreview(`${'g '.repeat(120)}${MYTRIBE_URL}/schedule end`);
    expect(p).toEqual({ line: `${'g '.repeat(99).trim()}...`, cut: true, linkAdded: true });
  });
  it('nothing typed is nothing', () => {
    expect(householdTextPreview('  \n ')).toEqual({ line: '', cut: false, linkAdded: false });
    expect(householdTextPreviewLine('')).toBe('');
  });
  it('the confirm line names the link without inventing an address', () => {
    expect(householdTextPreviewLine('See you Friday at 9.')).toBe('See you Friday at 9. More in MyTribe: (link)');
  });
});

/**
 * #2316 (operator ruling 2026-11-20): a household with no MyTribe account is
 * texted the whole message. The vectors are the server's
 * `householdWholeSms.test.ts`, so the confirm splits where the send splits.
 */
describe('householdWholeTextParts', () => {
  it('one text carries what the server sends in one', () => {
    expect(SMS_BODY_MAX).toBe(1600);
  });
  it('a message that fits is one text, as written, trimmed, with no cut and no link', () => {
    expect(householdWholeTextParts('  Closed Monday.\nBack Tuesday.  ')).toEqual(['Closed Monday.\nBack Tuesday.']);
  });
  it('a long message is split at the end of a word, and nothing is lost', () => {
    const text = `${'word '.repeat(30)}end`;
    const parts = householdWholeTextParts(text, 40);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(40);
    expect(parts.join(' ')).toBe(text);
    expect(parts.every((p) => !p.startsWith(' ') && !p.endsWith(' '))).toBe(true);
  });
  it('a run with no space near the limit is cut where it fits, never inside a character', () => {
    const text = `${'a'.repeat(30)}\u{1F415}${'b'.repeat(30)}`;
    const parts = householdWholeTextParts(text, 31);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(31);
    expect(parts.join('')).toBe(text);
    expect(parts.some((p) => p.includes('\u{1F415}'))).toBe(true);
  });
  it('splits at the 1600 limit by default', () => {
    const text = `${'Nova ran and ran. '.repeat(120)}The end.`;
    const parts = householdWholeTextParts(text);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.length).toBeLessThanOrEqual(1600);
    expect(parts[0]!.length).toBeGreaterThan(1600 * 0.8);
    expect(parts.join(' ')).toBe(text);
  });
  it('NEGATIVE: a blank message is no text at all', () => {
    expect(householdWholeTextParts('   ')).toEqual([]);
  });
});
describe('householdTextAccountOf', () => {
  it('no portal account is the one answer that means the whole message', () => {
    expect(householdTextAccountOf({ status: 'ready', willNotify: false, reason: 'household_has_no_portal_account' })).toBe(
      'no_account',
    );
  });
  it('any other answer means they have an account, the notices switch included', () => {
    expect(householdTextAccountOf({ status: 'ready', willNotify: true, reason: null })).toBe('account');
    expect(householdTextAccountOf({ status: 'ready', willNotify: false, reason: 'household_notices_off' })).toBe('account');
  });
  it('a pending or failed answer is neither', () => {
    expect(householdTextAccountOf({ status: 'checking' })).toBe('checking');
    expect(householdTextAccountOf({ status: 'unknown' })).toBe('unknown');
  });
});
describe('householdTextAsSent', () => {
  const body = 'See you Friday at 9.\nGate code is the usual.';
  it('with an account: the short line and the link', () => {
    expect(householdTextAsSent(body, 'account')).toEqual({ kind: 'short', line: householdTextPreviewLine(body) });
  });
  it('without one: the whole message, line breaks kept', () => {
    expect(householdTextAsSent(body, 'no_account')).toEqual({ kind: 'whole', parts: [body] });
  });
  it('not known yet, or not known at all: neither', () => {
    expect(householdTextAsSent(body, 'checking')).toEqual({ kind: 'checking' });
    expect(householdTextAsSent(body, 'unknown')).toEqual({ kind: 'unknown' });
  });
  it('the channel line only says short or whole once it is known', () => {
    expect(householdTextChannelLine('account')).toBe('Text, kept short, with a link to MyTribe');
    expect(householdTextChannelLine('no_account')).toBe('Text, the whole message, because they have no MyTribe account');
    expect(householdTextChannelLine('checking')).toBe('Text');
    expect(householdTextChannelLine('unknown')).toBe('Text');
  });
});
