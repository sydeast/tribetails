import { describe, it, expect } from 'vitest';
import {
  bankTemplateName,
  catalogKeyName,
  catalogKeyNameFor,
  routedTemplateName,
} from './templateRoutingFormat';

describe('templateRoutingFormat (#1592)', () => {
  it('names a catalog key by its label, else its key as words', () => {
    expect(catalogKeyName({ key: 'invoice.new', label: 'New invoice', source: 'catalog' })).toBe('New invoice');
    expect(catalogKeyName({ key: 'invite.verify-email', label: 'invite.verify-email', source: 'direct-send' })).toBe(
      'Invite verify email',
    );
    expect(catalogKeyName({ key: 'kin.removal.archived', label: '  ', source: 'catalog' })).toBe('Kin removal archived');
  });

  it('never uses the legacy sentence as a name', () => {
    expect(
      catalogKeyName({ key: 'booking.confirmed', label: 'Not in the catalog, nothing dispatches it', source: 'legacy' }),
    ).toBe('Booking confirmed');
  });

  it('names a key the rows do not hold as words', () => {
    const rows = [{ key: 'invoice.new', label: 'New invoice', source: 'catalog' }];
    expect(catalogKeyNameFor('invoice.new', rows)).toBe('New invoice');
    expect(catalogKeyNameFor('account.welcome.kinfolk', rows)).toBe('Account welcome kinfolk');
    expect(catalogKeyNameFor('', rows)).toBe('Notification');
  });

  it('names an untitled bank doc by what it holds, never its id', () => {
    expect(bankTemplateName({ templateId: 't1', title: 'Booking confirmed', subject: 'x' })).toBe('Booking confirmed');
    expect(bankTemplateName({ templateId: 't1', title: '', headline: 'Your visit', subject: 'x' })).toBe('Your visit');
    expect(bankTemplateName({ templateId: 't1', title: ' ', headline: null, subject: 'Visit booked' })).toBe('Visit booked');
    expect(bankTemplateName({ templateId: 't1', title: '', headline: '', subject: '' })).toBe('Untitled template');
  });

  it('reads a title that is only the id (the server fills a missing title with it) as no title', () => {
    expect(bankTemplateName({ templateId: 'invoice.new', title: 'invoice.new', subject: 'Your invoice' })).toBe(
      'Your invoice',
    );
    expect(bankTemplateName({ templateId: 'invoice.new', title: 'invoice.new', subject: 'invoice.new' })).toBe(
      'Untitled template',
    );
  });

  it('names the routed template, never printing its id', () => {
    const names = new Map([['tmpl_ok', 'Booking confirmed']]);
    expect(routedTemplateName('tmpl_ok', names, true)).toBe('Booking confirmed');
    expect(routedTemplateName('tmpl_gone', names, true)).toBe('a template not in the bank');
    expect(routedTemplateName('tmpl_gone', names, false)).toBe('its template');
    expect(routedTemplateName('invoice.new', names, true, true)).toBe('its own template');
  });
});
