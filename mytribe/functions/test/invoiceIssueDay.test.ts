import { describe, it, expect } from 'vitest';
import { DUE_BEFORE_SEND_CODE, DUE_BEFORE_SEND_MESSAGE, issueDayFields } from '../src/lib/invoiceIssueDay';

/**
 * #2246: a bill is dated the business day it goes out, and its due date is
 * worked out from that day. Made Monday Nov 16, sent Thursday Nov 19.
 */
const MONDAY = '2026-11-16';
const THURSDAY = '2026-11-19';
const TZ = 'America/Chicago';

function send(doc: Record<string, unknown>, serviceDates: string[] = [], mode: 'send' | 'accept' = 'send') {
  return issueDayFields({ doc, issueDay: THURSDAY, serviceDates, timeZone: TZ, mode });
}

describe('issueDayFields: coded terms are worked out again from the send day', () => {
  it('due on receipt: dated and due the day it goes out, never the day the draft was made', () => {
    expect(send({ date: MONDAY, dueDate: MONDAY, termsCode: 'due_on_receipt', terms: 'Due on receipt' })).toEqual({
      ok: true,
      fields: { date: THURSDAY, dueDate: THURSDAY, termsCode: 'due_on_receipt', terms: 'Due on receipt' },
    });
  });

  it('an invoice-date count runs from the send day', () => {
    expect(send({ date: MONDAY, dueDate: '2026-11-23', termsCode: 'net_7' })).toEqual({
      ok: true,
      fields: { date: THURSDAY, dueDate: '2026-11-26', termsCode: 'net_7', terms: 'Due 7 days after the invoice date' },
    });
  });

  it('a visit count still runs from the visits, read on the business clock', () => {
    // 7 PM Nov 10 in Chicago is 01:00 Nov 11 in UTC.
    const out = send({ date: MONDAY, dueDate: '2026-11-24', termsCode: 'net_14_after_last_visit' }, [
      '2026-11-11T01:00:00.000Z',
    ]);
    expect(out).toEqual({
      ok: true,
      fields: {
        date: THURSDAY,
        dueDate: '2026-11-24',
        termsCode: 'net_14_after_last_visit',
        terms: 'Due 14 days after the last visit',
      },
    });
  });

  it('a visit count that now lands before the send day is due on receipt (the #1966 floor)', () => {
    const out = send({ date: MONDAY, dueDate: MONDAY, termsCode: 'net_3_after_last_visit' }, ['2026-11-12T15:00:00Z']);
    expect(out).toEqual({
      ok: true,
      fields: { date: THURSDAY, dueDate: THURSDAY, termsCode: 'due_on_receipt', terms: 'Due on receipt' },
    });
  });

  it('a date set later than the send day was set on purpose and is kept', () => {
    expect(send({ date: '2026-11-25', dueDate: '2026-11-25', termsCode: 'due_on_receipt' })).toEqual({
      ok: true,
      fields: { dueDate: '2026-11-25', termsCode: 'due_on_receipt', terms: 'Due on receipt' },
    });
  });

  it('a draft with no date at all is dated the send day', () => {
    expect(send({ termsCode: 'due_on_receipt' })).toMatchObject({ ok: true, fields: { date: THURSDAY, dueDate: THURSDAY } });
  });

  it('the older invoiceDueDate spelling follows the new due date when the doc carries it', () => {
    expect(send({ date: MONDAY, dueDate: MONDAY, invoiceDueDate: MONDAY, termsCode: 'due_on_receipt' })).toMatchObject({
      ok: true,
      fields: { dueDate: THURSDAY, invoiceDueDate: THURSDAY },
    });
  });
});

describe('issueDayFields: a due date picked by hand', () => {
  it('is kept when it is on or after the send day', () => {
    expect(send({ date: MONDAY, dueDate: THURSDAY, termsCode: 'custom' })).toEqual({ ok: true, fields: { date: THURSDAY } });
    expect(send({ date: MONDAY, dueDate: '2026-11-30', terms: 'Pay at the first visit' })).toEqual({
      ok: true,
      fields: { date: THURSDAY },
    });
  });

  it('refuses the office send when it has already passed, saying what to do', () => {
    for (const doc of [
      { date: MONDAY, dueDate: '2026-11-18', termsCode: 'custom' },
      { date: MONDAY, dueDate: '2026-11-18', terms: 'Net 2' },
      { date: MONDAY, dueDate: 'November 18, 2026' },
    ]) {
      expect(send(doc)).toEqual({ ok: false, code: DUE_BEFORE_SEND_CODE, message: DUE_BEFORE_SEND_MESSAGE });
    }
    expect(DUE_BEFORE_SEND_MESSAGE).not.toMatch(/—|–/);
  });

  it('on a household accept, is brought up to the accept day instead (the household cannot send it back)', () => {
    expect(send({ date: MONDAY, dueDate: '2020-01-01', termsCode: 'custom' }, [], 'accept')).toEqual({
      ok: true,
      fields: { date: THURSDAY, dueDate: THURSDAY },
    });
  });

  it('with no due date at all, only the date moves', () => {
    expect(send({ date: MONDAY, dueDate: '', terms: '' })).toEqual({ ok: true, fields: { date: THURSDAY } });
  });
});

describe('issueDayFields: nothing to work from', () => {
  it('an unreadable send day changes nothing', () => {
    expect(issueDayFields({ doc: { date: MONDAY, termsCode: 'due_on_receipt' }, issueDay: '', serviceDates: [], timeZone: TZ, mode: 'send' })).toEqual({
      ok: true,
      fields: {},
    });
  });

  it('a draft already dated the send day with nothing to change writes the same values', () => {
    expect(send({ date: THURSDAY, dueDate: THURSDAY, termsCode: 'due_on_receipt' })).toEqual({
      ok: true,
      fields: { dueDate: THURSDAY, termsCode: 'due_on_receipt', terms: 'Due on receipt' },
    });
  });
});
