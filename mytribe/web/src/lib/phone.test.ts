import { describe, expect, it } from 'vitest';
import { formatPhone, phoneProblem, PHONE_PROBLEM } from './phone';
describe('formatPhone', () => {
  it('formats the shapes the QA walk found (#1306)', () => {
    expect(formatPhone('+15125550142')).toBe('(512) 555-0142');
    expect(formatPhone('5125667512')).toBe('(512) 566-7512');
    expect(formatPhone('512-555-0142')).toBe('(512) 555-0142');
    expect(formatPhone('1 (512) 555-0142')).toBe('(512) 555-0142');
    expect(formatPhone('(512) 555-0142')).toBe('(512) 555-0142');
  });
  it('leaves international and unrecognised numbers as typed', () => {
    expect(formatPhone('+442079460958')).toBe('+442079460958');
    expect(formatPhone('12345')).toBe('12345');
  });
  it('is empty for nothing', () => {
    expect(formatPhone(null)).toBe('');
    expect(formatPhone(undefined)).toBe('');
    expect(formatPhone('   ')).toBe('');
  });
  it('is stable: formatting twice changes nothing', () => {
    expect(formatPhone(formatPhone('+15125550142'))).toBe('(512) 555-0142');
  });
});
describe('phoneProblem', () => {
  it('accepts blank and every US shape', () => {
    for (const ok of ['', '  ', '5125550142', '512-555-0142', '(512) 555-0142', '+15125550142', '1 512 555 0142', '+442079460958']) {
      expect(phoneProblem(ok), ok).toBeNull();
    }
  });
  it('names the problem in plain words for abc123 (#1289)', () => {
    expect(phoneProblem('abc123')).toBe(PHONE_PROBLEM);
    expect(PHONE_PROBLEM).toBe('Enter a 10-digit phone number.');
  });
  it('refuses short, long and lettered numbers', () => {
    for (const bad of ['12345', '512555014', '51255501421', '512-555-CALL', '+123']) {
      expect(phoneProblem(bad), bad).toBe(PHONE_PROBLEM);
    }
  });
});
