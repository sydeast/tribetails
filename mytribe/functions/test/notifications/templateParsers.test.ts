import { describe, it, expect } from 'vitest';
import { parseEmailTxt } from '../../src/notifications/templateParsers';

describe('parseEmailTxt', () => {
  it('parses subject + single-line body', () => {
    const raw = 'Subject: Hello {{name}}\n\nBody line 1';
    expect(parseEmailTxt(raw)).toEqual({
      subject: 'Hello {{name}}',
      body: 'Body line 1',
    });
  });

  it('preserves multi-line body verbatim including internal blank lines', () => {
    const raw = 'Subject: S\n\nLine 1\n\nLine 3\nLine 4';
    expect(parseEmailTxt(raw)).toEqual({
      subject: 'S',
      body: 'Line 1\n\nLine 3\nLine 4',
    });
  });

  it('throws when first line lacks "Subject: " prefix', () => {
    expect(() => parseEmailTxt('No prefix here\n\nbody')).toThrow(/Subject:/);
  });

  it('throws when body is empty (no \\n\\n separator)', () => {
    expect(() => parseEmailTxt('Subject: Only')).toThrow(/body/i);
  });

  it('throws when body after separator is whitespace-only', () => {
    expect(() => parseEmailTxt('Subject: S\n\n   \n  ')).toThrow(/body/i);
  });
});

import { stripUnresolvedTokens } from '../../src/notifications/templateParsers';

describe('stripUnresolvedTokens', () => {
  it('removes any leftover {{token}} so a raw token can never reach a customer', () => {
    expect(stripUnresolvedTokens('Hi {{kinfolkName}}, your invoice {{invoiceNumber}}.')).toBe(
      'Hi , your invoice .',
    );
  });

  it('leaves already-resolved text untouched', () => {
    expect(stripUnresolvedTokens('Hi Sam, your invoice TT-1001.')).toBe('Hi Sam, your invoice TT-1001.');
  });

  it('handles tokens with surrounding whitespace and dotted paths', () => {
    expect(stripUnresolvedTokens('A {{ a.b }} B {{c}} C')).toBe('A  B  C');
  });

  it('is a no-op on empty string', () => {
    expect(stripUnresolvedTokens('')).toBe('');
  });
});

import { parsePushTxt } from '../../src/notifications/templateParsers';

describe('parsePushTxt', () => {
  it('splits at first period: title (trimmed, no period) + body (trimmed)', () => {
    expect(parsePushTxt('Booking confirmed. Tap to see details.')).toEqual({
      title: 'Booking confirmed',
      body: 'Tap to see details.',
    });
  });

  it('handles leading/trailing whitespace via raw.trim()', () => {
    expect(parsePushTxt('  Booking confirmed. Tap to see details.  ')).toEqual({
      title: 'Booking confirmed',
      body: 'Tap to see details.',
    });
  });

  it('splits at FIRST period even when body contains more', () => {
    expect(parsePushTxt('Title. Body has. Multiple periods.')).toEqual({
      title: 'Title',
      body: 'Body has. Multiple periods.',
    });
  });

  it('throws when input has no period', () => {
    expect(() => parsePushTxt('No period here')).toThrow(/period/i);
  });

  it('throws when body after period is empty', () => {
    expect(() => parsePushTxt('Title only.')).toThrow(/body/i);
  });

  it('throws when body after period is whitespace-only', () => {
    expect(() => parsePushTxt('Title.   ')).toThrow(/body/i);
  });
});
// ─────────────────────────────────────────────────────────────────────────────
// The on-disk seed corpus, run through the very parsers the seeder uses.
//
// `scripts/seedNotificationTemplates.ts` is the only thing that reads these
// files, and it reads them at SEED time — so a malformed template (a push
// body with no leading period, an empty sms.txt or subject.txt) is discovered
// by an operator mid-deploy rather than in CI. Every failure mode asserted
// individually above is a real shape one of these files can take.
// ─────────────────────────────────────────────────────────────────────────────
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
describe('seeds/notificationTemplates parse with the seeder’s own parsers', () => {
  const seedsDir = join(__dirname, '..', '..', '..', 'seeds', 'notificationTemplates');
  const keys = readdirSync(seedsDir).filter((n) => statSync(join(seedsDir, n)).isDirectory());
  it('finds a non-empty corpus (a wrong path here would make this suite vacuous)', () => {
    expect(keys.length).toBeGreaterThan(30);
  });
  for (const key of keys.sort()) {
    it(`${key}: subject.txt, headline.txt, push.txt and sms.txt are seedable`, () => {
      const read = (f: string) => readFileSync(join(seedsDir, key, f), 'utf8');
      expect(read('subject.txt').trim().length).toBeGreaterThan(0);
      expect(read('headline.txt').trim().length).toBeGreaterThan(0);
      const push = parsePushTxt(read('push.txt'));
      expect(push.title.length).toBeGreaterThan(0);
      expect(push.body.length).toBeGreaterThan(0);
      expect(read('sms.txt').trim().length).toBeGreaterThan(0);
      expect(read('content.html').trim().length).toBeGreaterThan(0);
    });
  }
});
