import { describe, it, expect } from 'vitest';
import {
  EMPTY_FOOTER_FACTS,
  composeFooter,
  formatDayHours,
  formatHHmm12h,
  formatPhoneForDisplay,
  hoursUnset,
  type EmailFooterFacts,
} from '../src/lib/emailFooter';
import { footerHtml, frameHtml, sendPartsFor } from '../src/lib/emailFrame';
import { DEFAULT_EMAIL_FRAME } from '../src/lib/emailFrameConfig';
import { renderEmailParts } from '../src/lib/email';

/**
 * #1399: the required email footer, composed from settings. Ruling 2026-11-01:
 * business name, weekly hours, published phone and the privacy policy link
 * come from the settings document; `footerText` is an optional extra line; a
 * blank name is never invented.
 */

const HOURS: EmailFooterFacts['hours'] = {
  Monday: '08:00-18:00',
  Tuesday: '08:00-18:00',
  Wednesday: '08:00-18:00',
  Thursday: '08:00-18:00',
  Friday: '08:00-18:00',
  Saturday: '09:00-13:00',
  Sunday: '',
};

const FULL: EmailFooterFacts = {
  name: 'Test Business',
  phone: '+15125550142',
  hours: HOURS,
  privacyPolicyUrl: 'https://tribetails.com/privacy',
};

const HOURS_LINE =
  'Monday 8:00 AM to 6:00 PM · Tuesday 8:00 AM to 6:00 PM · Wednesday 8:00 AM to 6:00 PM · ' +
  'Thursday 8:00 AM to 6:00 PM · Friday 8:00 AM to 6:00 PM · Saturday 9:00 AM to 1:00 PM · Sunday Closed';

describe('formatting helpers', () => {
  it('formats a US phone the way the portal does, and leaves others as stored', () => {
    expect(formatPhoneForDisplay('+15125550142')).toBe('(512) 555-0142');
    expect(formatPhoneForDisplay('5125550142')).toBe('(512) 555-0142');
    expect(formatPhoneForDisplay('512-555-0142')).toBe('(512) 555-0142');
    expect(formatPhoneForDisplay('+442071234567')).toBe('+442071234567');
    expect(formatPhoneForDisplay('')).toBe('');
    expect(formatPhoneForDisplay(null)).toBe('');
  });

  it('formats HH:MM as a 12-hour clock', () => {
    expect(formatHHmm12h('00:00')).toBe('12:00 AM');
    expect(formatHHmm12h('08:30')).toBe('8:30 AM');
    expect(formatHHmm12h('12:00')).toBe('12:00 PM');
    expect(formatHHmm12h('18:05')).toBe('6:05 PM');
    expect(formatHHmm12h('by appointment')).toBe('by appointment');
  });

  it('words one day, with a blank range as Closed', () => {
    expect(formatDayHours('Monday', '08:00-18:00')).toBe('Monday 8:00 AM to 6:00 PM');
    expect(formatDayHours('Sunday', '')).toBe('Sunday Closed');
  });

  it('hoursUnset is true only when no day carries hours', () => {
    expect(hoursUnset(EMPTY_FOOTER_FACTS.hours)).toBe(true);
    expect(hoursUnset(HOURS)).toBe(false);
  });
});

describe('composeFooter', () => {
  it('names the business, lists every weekday with the closed day as Closed, the phone and the privacy link', () => {
    expect(composeFooter(FULL)).toEqual({
      nameLine: 'Test Business',
      hoursLine: `Hours: ${HOURS_LINE}`,
      phoneLine: 'Phone: (512) 555-0142',
      privacyPolicyUrl: 'https://tribetails.com/privacy',
    });
  });

  it('a blank name drops the name line and words the hours as "Your Auntie\'s hours"', () => {
    const out = composeFooter({ ...FULL, name: '   ' });
    expect(out.nameLine).toBe('');
    expect(out.hoursLine).toBe(`Your Auntie's hours: ${HOURS_LINE}`);
    expect(out.phoneLine).toBe('Phone: (512) 555-0142');
  });

  it('no privacy URL means no link; no phone means no phone line', () => {
    const out = composeFooter({ ...FULL, privacyPolicyUrl: '', phone: '' });
    expect(out.privacyPolicyUrl).toBe('');
    expect(out.phoneLine).toBe('');
    expect(out.nameLine).toBe('Test Business');
  });

  it('hours set on no day at all draws no hours line rather than seven Closed days', () => {
    expect(composeFooter({ ...FULL, hours: EMPTY_FOOTER_FACTS.hours }).hoursLine).toBe('');
  });

  it('a business that has set nothing composes to nothing', () => {
    expect(composeFooter(EMPTY_FOOTER_FACTS)).toEqual({ nameLine: '', hoursLine: '', phoneLine: '', privacyPolicyUrl: '' });
  });
});

describe('the footer in the frame', () => {
  const LINE = (inner: string) => `<div style="margin: 0 0 4px 0;">${inner}</div>`;

  it('renders the composed block, then footerText as the extra line', () => {
    const html = footerHtml({ ...DEFAULT_EMAIL_FRAME, footerText: 'Thanks for trusting us', business: FULL });
    expect(html).toBe(
      LINE('<strong>Test Business</strong>') +
        LINE(`Hours: ${HOURS_LINE}`) +
        LINE('Phone: (512) 555-0142') +
        LINE('<a href="https://tribetails.com/privacy" style="color: #fbfbf9; text-decoration: underline;">Privacy policy</a>') +
        LINE('Thanks for trusting us'),
    );
  });

  it('a frame nobody edited still sends a complete footer from settings alone', () => {
    const html = frameHtml('H', '<p>c</p>', { ...DEFAULT_EMAIL_FRAME, business: FULL });
    expect(html).toContain('<strong>Test Business</strong>');
    expect(html).toContain(`Hours: ${HOURS_LINE}`);
    expect(html).toContain('Phone: (512) 555-0142');
    expect(html).toContain('>Privacy policy</a>');
    // The <style> block is unchanged: the footer lines are inline-styled.
    expect(html).toContain('.footer { padding: 20px 40px; background-color: #11131f; color: #fbfbf9; font-size: 12px; text-align: center; }');
  });

  it('a blank name renders the block with the "your Auntie" wording and no name line', () => {
    const html = footerHtml({ ...DEFAULT_EMAIL_FRAME, business: { ...FULL, name: '' } });
    expect(html).not.toContain('<strong>');
    expect(html).toContain(`Your Auntie's hours: ${HOURS_LINE}`);
    expect(html).not.toContain('Tribe Tails');
  });

  it('no privacy URL renders no link at all', () => {
    const html = footerHtml({ ...DEFAULT_EMAIL_FRAME, business: { ...FULL, privacyPolicyUrl: '' } });
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('Privacy policy');
  });

  it('escapes the business facts so a name can never become markup or a merge field', () => {
    const html = footerHtml({ ...DEFAULT_EMAIL_FRAME, business: { ...FULL, name: "Test & Co's {Pets} <b>" } });
    expect(html).toContain('<strong>Test &amp; Co\'s &#123;Pets&#125; &lt;b&gt;</strong>');
  });

  it('a name with braces survives a real Handlebars render as text, not as a merge field', () => {
    const parts = sendPartsFor(
      { subject: 's', format: 'visual', headline: 'Hi {{displayName}}', content: '<p>x</p>' },
      { ...DEFAULT_EMAIL_FRAME, business: { ...FULL, name: 'Test {{displayName}} Co' } },
    );
    const out = renderEmailParts({ ...parts, data: { displayName: 'Pat' } });
    expect(out.html).toContain('<h2>Hi Pat</h2>');
    // The braces reach the inbox as entities (a mail client shows "{{displayName}}"), never substituted.
    expect(out.html).toContain('<strong>Test &#123;&#123;displayName&#125;&#125; Co</strong>');
    expect(out.html).not.toContain('Test Pat Co');
  });

  it('the logo alt text is the header line, else the business name, else "Your Auntie"', () => {
    const LOGO = 'https://res.cloudinary.com/tribetails/image/upload/v1/tribetails/business/business_settings/logo.png';
    const named = frameHtml('H', '<p>c</p>', { ...DEFAULT_EMAIL_FRAME, logoUrl: LOGO, business: FULL });
    expect(named).toContain(`<img src="${LOGO}" alt="Test Business" width="160"`);
    const headed = frameHtml('H', '<p>c</p>', { ...DEFAULT_EMAIL_FRAME, logoUrl: LOGO, headerText: 'News', business: FULL });
    expect(headed).toContain(`alt="News"`);
    const unnamed = frameHtml('H', '<p>c</p>', { ...DEFAULT_EMAIL_FRAME, logoUrl: LOGO, business: { ...FULL, name: '' } });
    expect(unnamed).toContain(`alt="Your Auntie"`);
    expect(unnamed).not.toContain('Tribe Tails');
  });
});
