import { describe, expect, it } from 'vitest';
import { householdTextPreview, householdTextPreviewLine, MYTRIBE_URL } from './householdText';
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
