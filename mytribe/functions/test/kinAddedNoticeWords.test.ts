import { describe, it, expect } from 'vitest';
import Handlebars from 'handlebars';
import { SEED_CORPUS } from '../src/notifications/seedCorpus.generated';
import { sendPartsFor } from '../src/lib/emailFrame';
import { renderEmailParts } from '../src/lib/email';

/**
 * #1822 (lead decision 2026-11-21): a Kin added to six upcoming visits is told
 * in one message that names every day, never as six messages and never as one
 * day standing for six (the 2026-08-23 "no summarising" ruling). Rendered from
 * the repo seeds with real Handlebars, the way they are sent. A single-visit
 * change, which carries no `kinAdded`, keeps its old wording.
 */

const seed = (key: string) => SEED_CORPUS.find((s) => s.key === key)!;
const email = (key: string, data: Record<string, unknown>) => {
  const s = seed(key);
  return renderEmailParts({
    ...sendPartsFor({ subject: s.emailSubject, format: 'visual' as const, headline: s.emailHeadline, content: s.emailContent }),
    data,
  });
};
const line = (tpl: string, data: Record<string, unknown>) => Handlebars.compile(tpl)(data).trim();

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const visits = DAYS.map((weekday, i) => ({ weekday, date: `Mar ${i + 1}`, time: '9:00 AM', visitId: `v${i}` }));
const kinAdded = {
  Business: 'TribeTails',
  kinfolkName: 'Jordan',
  kinName: 'Pepper',
  kinAdded: true,
  addedKinName: 'Pepper',
  serviceType: 'Drop-in',
  bookingDate: 'Mon, Mar 1',
  visits,
  visitCount: 6,
  nextVisit: visits[0],
  portalUrl: 'https://kinfolk.tribetails.com',
  // #2487: the seeds print the item's own address, which the channel trigger fills.
  link: 'https://kinfolk.tribetails.com/schedule',
};
const oneVisit = {
  Business: 'TribeTails',
  kinfolkName: 'Jordan',
  kinName: 'Biscuit',
  serviceType: 'Drop-in',
  bookingDate: 'Mon, Mar 1',
};

describe('#1822: one message names every visit a Kin was added to', () => {
  it('the household email lists all six days', () => {
    const out = email('kincare.changed', kinAdded);
    for (const v of visits) expect(out.text).toContain(`${v.weekday}, ${v.date} at 9:00 AM`);
    expect(out.html).toContain('Pepper is now on these visits too');
    expect(out.html).not.toContain('has been updated');
  });

  it('the household SMS and push give the count, the first day and the link', () => {
    const sms = line(seed('kincare.changed').smsTxt, kinAdded);
    expect(sms).toBe("It's Auntie. Pepper is now on 6 of your visits, first up Mon Mar 1. Every date: https://kinfolk.tribetails.com/schedule");
    const push = line(seed('kincare.changed').pushTxt, kinAdded);
    expect(push).toBe('Visit details updated. Pepper is now on 6 of your visits, starting Mon Mar 1. Tap for every date.');
  });

  it("the Auntie's email lists her days, and her SMS and push give the count", () => {
    const hers = { ...kinAdded, visits: visits.slice(0, 4), visitCount: 4, portalUrl: 'https://auntie.tribetails.com', link: 'https://auntie.tribetails.com/directory/fam1' };
    const out = email('assignment.changed', hers);
    for (const v of visits.slice(0, 4)) expect(out.text).toContain(`${v.weekday}, ${v.date} at 9:00 AM`);
    expect(out.text).not.toContain('Fri, Mar 5');
    expect(line(seed('assignment.changed').smsTxt, hers)).toBe(
      'TribeTails: Pepper is now on 4 of your visits, first Mon Mar 1. Every date: https://auntie.tribetails.com/directory/fam1',
    );
    expect(line(seed('assignment.changed').pushTxt, hers)).toBe(
      'Assignment changed. Pepper is now on 4 of your visits, starting Mon Mar 1. Tap for every date.',
    );
  });

  it('a one-visit change keeps its old wording on every channel', () => {
    expect(email('kincare.changed', oneVisit).html).toContain('the Drop-in for Biscuit on Mon, Mar 1 has been updated');
    expect(line(seed('kincare.changed').smsTxt, oneVisit)).toBe("It's Auntie. The Drop-in for Biscuit on Mon, Mar 1 was updated.");
    expect(line(seed('kincare.changed').pushTxt, oneVisit)).toBe(
      'Visit details updated. The Drop-in on Mon, Mar 1 has changed. Tap to see the new details.',
    );
    expect(line(seed('assignment.changed').smsTxt, oneVisit)).toBe(
      'TribeTails: your Drop-in for Biscuit on Mon, Mar 1 changed or was canceled.',
    );
    expect(email('assignment.changed', oneVisit).html).toContain('was changed, reassigned, or canceled');
  });

  it('a one-visit change carries no empty list and no gap where the days would be', () => {
    for (const key of ['kincare.changed', 'assignment.changed']) {
      const out = email(key, oneVisit);
      expect(out.html).not.toContain('<ul');
      expect(out.html).not.toMatch(/<p>\s*<\/p>/);
      expect(out.text).not.toMatch(/\n\n\n/);
    }
  });
});
