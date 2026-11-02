import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #1321: the public business card is a projection of the staff-only settings
 * document, and the projection is the whole security story. A household on
 * the sign-in screen may read `business_public/card` with no account at all,
 * so what reaches it is decided here, field by field, and nothing else may.
 */
const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  logEvent: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn(() => 'sentry-id') }));

import { onBusinessSettingsWrite } from '../src/triggers/onBusinessSettingsWrite';
import { buildBusinessPublicCard, publicHttpsUrl, publicWeeklyHours } from '../src/lib/businessPublicCard';

type Docs = Record<string, Record<string, unknown> | null>;

function dbWith(docs: Docs) {
  const mock = buildDbMock({ docs, writeThrough: true });
  mocks.dbFn.mockReturnValue(mock.db);
  return mock;
}

async function settingsWritten(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined) {
  await onBusinessSettingsWrite.run({
    id: 'evt-settings',
    params: {},
    data: {
      before: { data: () => before, exists: before !== undefined },
      after: { data: () => after, exists: after !== undefined },
    },
  } as never);
}

const CLOSED_WEEK = {
  Monday: '',
  Tuesday: '',
  Wednesday: '',
  Thursday: '',
  Friday: '',
  Saturday: '',
  Sunday: '',
};

/** A settings document with the public facts set and a sample of what must never leave it. */
const FULL_SETTINGS: Record<string, unknown> = {
  businessName: 'Sunny Paws',
  businessPhone: '555-0142',
  businessEmail: 'hello@example.test',
  businessAddress: '12 Elm Street',
  businessHours: { Monday: '9:00-17:00', Tuesday: '09:00 - 17:30', Saturday: 'by appointment' },
  timeZone: 'America/Chicago',
  serviceRates: { walk: 25 },
  venmoHandle: '@sunny-paws',
  paypalHandle: 'sunny@example.test',
  householdNotificationsLive: true,
  stripeAccountId: 'acct_123',
  allowClientLocationSharing: true,
};

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEvent.mockClear();
});

describe('buildBusinessPublicCard, the closed field list', () => {
  it('carries name, phone, the seven days and the privacy policy URL, and nothing else', () => {
    const card = buildBusinessPublicCard({ ...FULL_SETTINGS, privacyPolicyUrl: 'https://example.test/privacy' });
    expect(card).toEqual({
      name: 'Sunny Paws',
      phone: '555-0142',
      hours: { ...CLOSED_WEEK, Monday: '09:00-17:00', Tuesday: '09:00-17:30' },
      privacyPolicyUrl: 'https://example.test/privacy',
    });
    expect(Object.keys(card).sort()).toEqual(['hours', 'name', 'phone', 'privacyPolicyUrl']);
  });

  it('never forwards an operational, payment or contact field', () => {
    const card = buildBusinessPublicCard(FULL_SETTINGS) as unknown as Record<string, unknown>;
    for (const secret of [
      'businessEmail',
      'businessAddress',
      'timeZone',
      'serviceRates',
      'venmoHandle',
      'paypalHandle',
      'householdNotificationsLive',
      'stripeAccountId',
      'allowClientLocationSharing',
    ]) {
      expect(card).not.toHaveProperty(secret);
    }
    expect(JSON.stringify(card)).not.toContain('acct_123');
    expect(JSON.stringify(card)).not.toContain('@sunny-paws');
  });

  it('reads a missing or deleted document as an all-blank card', () => {
    expect(buildBusinessPublicCard(undefined)).toEqual({ name: '', phone: '', hours: CLOSED_WEEK, privacyPolicyUrl: '' });
    expect(buildBusinessPublicCard({})).toEqual({ name: '', phone: '', hours: CLOSED_WEEK, privacyPolicyUrl: '' });
  });

  it('trims the name and phone and ignores a non-string value', () => {
    expect(buildBusinessPublicCard({ businessName: '  Sunny Paws ', businessPhone: 5550142 })).toMatchObject({
      name: 'Sunny Paws',
      phone: '',
    });
  });
});

describe('publicWeeklyHours', () => {
  it('always lists the seven Monday-first days, in that order', () => {
    expect(Object.keys(publicWeeklyHours(undefined))).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ]);
  });

  it('normalizes a range, reads a blank as closed and drops a key that is not a day', () => {
    const hours = publicWeeklyHours({ Monday: '9:00-17:00', Friday: '', Funday: '10:00-11:00', Sunday: 7 });
    expect(hours.Monday).toBe('09:00-17:00');
    expect(hours.Friday).toBe('');
    expect(hours.Sunday).toBe('');
    expect(hours).not.toHaveProperty('Funday');
  });

  it('shows nothing for a range it cannot read rather than the raw text', () => {
    expect(publicWeeklyHours({ Monday: 'by appointment', Tuesday: '25:00-26:00' })).toMatchObject({
      Monday: '',
      Tuesday: '',
    });
  });
});

describe('publicHttpsUrl (#1410 slot)', () => {
  it('keeps an https URL and refuses everything else', () => {
    expect(publicHttpsUrl('https://example.test/privacy')).toBe('https://example.test/privacy');
    expect(publicHttpsUrl(' https://example.test/privacy ')).toBe('https://example.test/privacy');
    expect(publicHttpsUrl('http://example.test/privacy')).toBe('');
    expect(publicHttpsUrl('javascript:alert(1)')).toBe('');
    expect(publicHttpsUrl('example.test/privacy')).toBe('');
    expect(publicHttpsUrl(undefined)).toBe('');
    expect(publicHttpsUrl(42)).toBe('');
  });
});

describe('onBusinessSettingsWrite', () => {
  it('creates the card from a fresh settings document', async () => {
    const { writes } = dbWith({ 'business_public/card': null });
    await settingsWritten(undefined, FULL_SETTINGS);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      path: 'business_public/card',
      merge: false,
      data: {
        name: 'Sunny Paws',
        phone: '555-0142',
        hours: { ...CLOSED_WEEK, Monday: '09:00-17:00', Tuesday: '09:00-17:30' },
        privacyPolicyUrl: '',
      },
    });
    expect(Object.keys(writes[0]!.data as Record<string, unknown>).sort()).toEqual(['hours', 'name', 'phone', 'privacyPolicyUrl']);
  });

  it('writes nothing when a save touched no public field', async () => {
    const { writes } = dbWith({ 'business_public/card': buildBusinessPublicCard(FULL_SETTINGS) as never });
    await settingsWritten(FULL_SETTINGS, { ...FULL_SETTINGS, serviceRates: { walk: 30 }, venmoHandle: '@other' });
    expect(writes).toEqual([]);
    const events = mocks.logEvent.mock.calls.map((c) => c[0].event);
    expect(events).not.toContain('business.publicCard.mirrored');
  });

  it('replaces the card when the name changes, so a blanked field is blanked on the card', async () => {
    const { writes, db } = dbWith({ 'business_public/card': buildBusinessPublicCard(FULL_SETTINGS) as never });
    await settingsWritten(FULL_SETTINGS, { ...FULL_SETTINGS, businessName: 'Sunny Paws Pet Care', businessPhone: '' });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ path: 'business_public/card', merge: false, data: { name: 'Sunny Paws Pet Care', phone: '' } });
    const stored = (await db.doc('business_public/card').get()).data();
    expect(stored).toEqual({
      name: 'Sunny Paws Pet Care',
      phone: '',
      hours: { ...CLOSED_WEEK, Monday: '09:00-17:00', Tuesday: '09:00-17:30' },
      privacyPolicyUrl: '',
    });
  });

  it('rewrites a card that drifted from settings even when this save changed nothing public', async () => {
    const { writes } = dbWith({ 'business_public/card': { name: 'Someone Else', phone: '555-0199', hours: CLOSED_WEEK, privacyPolicyUrl: '' } });
    await settingsWritten(FULL_SETTINGS, { ...FULL_SETTINGS, serviceRates: { walk: 30 } });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ data: { name: 'Sunny Paws', phone: '555-0142' } });
  });

  it('blanks the card when the settings document is deleted', async () => {
    const { writes } = dbWith({ 'business_public/card': buildBusinessPublicCard(FULL_SETTINGS) as never });
    await settingsWritten(FULL_SETTINGS, undefined);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      path: 'business_public/card',
      data: { name: '', phone: '', hours: CLOSED_WEEK, privacyPolicyUrl: '' },
    });
  });

  it('mirrors the privacy policy URL once settings carry one', async () => {
    const { writes } = dbWith({ 'business_public/card': buildBusinessPublicCard(FULL_SETTINGS) as never });
    await settingsWritten(FULL_SETTINGS, { ...FULL_SETTINGS, privacyPolicyUrl: 'https://example.test/privacy' });
    expect(writes[0]).toMatchObject({ data: { privacyPolicyUrl: 'https://example.test/privacy' } });
  });

  it('logs the mirror without the values themselves', async () => {
    dbWith({ 'business_public/card': null });
    await settingsWritten(undefined, FULL_SETTINGS);
    const mirrored = mocks.logEvent.mock.calls.map((c) => c[0]).find((e) => e.event === 'business.publicCard.mirrored');
    expect(mirrored).toBeDefined();
    expect(JSON.stringify(mirrored)).not.toContain('Sunny Paws');
    expect(JSON.stringify(mirrored)).not.toContain('555-0142');
  });
});
