import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

import {
  isBindingActive,
  resolveTemplateId,
  readTemplateBindings,
} from '../src/lib/sendFromTemplate';

// #965: listing (`listTemplateBindings`) used to decode a missing `active`
// field as off while sending (this file) already treats it as on. These pin
// down the one rule (`isBindingActive`) that every reader, server or client,
// must agree with.
describe('isBindingActive', () => {
  it('a missing field (undefined) is active', () => {
    expect(isBindingActive(undefined)).toBe(true);
  });

  it('explicit true is active', () => {
    expect(isBindingActive(true)).toBe(true);
  });

  it('explicit false is NOT active', () => {
    expect(isBindingActive(false)).toBe(false);
  });

  it('any other truthy/falsy junk value is still active (only literal false turns it off)', () => {
    expect(isBindingActive(0)).toBe(true);
    expect(isBindingActive(null)).toBe(true);
    expect(isBindingActive('false')).toBe(true);
  });
});

describe('resolveTemplateId', () => {
  it('a binding doc with no active field still resolves to its templateId', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        docs: { 'notificationTemplateBindings/booking.confirmed': { templateId: 'tmpl_custom' } },
      }).db,
    );
    const id = await resolveTemplateId('booking.confirmed');
    expect(id).toBe('tmpl_custom');
  });

  it('active: false falls back to the catalog key default', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        docs: {
          'notificationTemplateBindings/invoice.new': { templateId: 'tmpl_custom', active: false },
        },
      }).db,
    );
    const id = await resolveTemplateId('invoice.new');
    expect(id).toBe('invoice.new');
  });
});

describe('readTemplateBindings', () => {
  it('a binding with no active field lands in activeBindings, matching resolveTemplateId', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        queryDocs: {
          notificationTemplateBindings: [
            { id: 'booking.confirmed', data: { templateId: 'tmpl_custom' } },
          ],
        },
      }).db,
    );
    const { boundKeys, activeBindings } = await readTemplateBindings();
    expect(boundKeys.has('booking.confirmed')).toBe(true);
    expect(activeBindings.get('booking.confirmed')).toBe('tmpl_custom');
  });

  it('active: false is bound but not in activeBindings', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        queryDocs: {
          notificationTemplateBindings: [
            { id: 'invoice.new', data: { templateId: 'tmpl_custom', active: false } },
          ],
        },
      }).db,
    );
    const { boundKeys, activeBindings } = await readTemplateBindings();
    expect(boundKeys.has('invoice.new')).toBe(true);
    expect(activeBindings.has('invoice.new')).toBe(false);
  });
});
