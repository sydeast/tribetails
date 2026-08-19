import { describe, expect, it } from 'vitest';
import {
  categoryChannels,
  categoryMarketingCategories,
  categoryMasterChecked,
  categoryToggleableChannels,
  channelChecked,
  keyChannelChecked,
  keyChannelOverridden,
  keyLockedChannels,
  marketingMasterChecked,
  type CategoryDto,
  type NotificationKeyDto,
} from './notificationsApi';

function key(overrides: Partial<NotificationKeyDto>): NotificationKeyDto {
  return {
    key: 'test.key',
    title: 'Test',
    description: 'A test key.',
    allowedChannels: ['email', 'push'],
    required: [],
    lockedChannels: [],
    lockedChannelValues: {},
    marketingCategory: null,
    lockReason: null,
    ...overrides,
  };
}

function cat(id: string, keys: NotificationKeyDto[]): CategoryDto {
  return { id, title: id, description: '', keys };
}

describe('categoryChannels', () => {
  it('unions allowedChannels across keys in canonical push/email/sms order', () => {
    const c = cat('visit', [
      key({ allowedChannels: ['email', 'sms'] }),
      key({ allowedChannels: ['push'] }),
    ]);
    expect(categoryChannels(c)).toEqual(['push', 'email', 'sms']);
  });

  it('is empty for a category with no keys', () => {
    expect(categoryChannels(cat('empty', []))).toEqual([]);
  });
});

describe('categoryToggleableChannels', () => {
  it('includes a channel when at least one key leaves it unlocked', () => {
    const c = cat('visit', [
      key({ allowedChannels: ['email'], lockedChannels: ['email'] }), // locked here
      key({ allowedChannels: ['email'], lockedChannels: [] }), // free here
    ]);
    expect(categoryToggleableChannels(c)).toEqual(['email']);
  });

  it('excludes a channel every key locks', () => {
    const c = cat('visit', [
      key({ allowedChannels: ['email', 'sms'], lockedChannels: ['email'] }),
      key({ allowedChannels: ['email'], lockedChannels: ['email'] }),
    ]);
    // email locked everywhere it appears -> not toggleable; sms free -> toggleable.
    expect(categoryToggleableChannels(c)).toEqual(['sms']);
  });
});

describe('channelChecked', () => {
  it('reads the saved byCategory value when the channel is toggleable', () => {
    const c = cat('visit', [key({ allowedChannels: ['sms'] })]);
    expect(channelChecked(c, 'sms', { sms: false })).toBe(false);
    expect(channelChecked(c, 'sms', { sms: true })).toBe(true);
  });

  it('defaults email on and other channels off when unsaved', () => {
    const c = cat('visit', [key({ allowedChannels: ['email', 'push', 'sms'] })]);
    expect(channelChecked(c, 'email', undefined)).toBe(true);
    expect(channelChecked(c, 'push', undefined)).toBe(false);
    expect(channelChecked(c, 'sms', undefined)).toBe(false);
  });

  it('reads the catalog’s value for a channel locked across every key, ignoring saved prefs', () => {
    const c = cat('visit', [
      key({
        allowedChannels: ['email'],
        lockedChannels: ['email'],
        lockedChannelValues: { email: true },
      }),
    ]);
    expect(channelChecked(c, 'email', { email: false })).toBe(true);
  });
  // #491. A locked channel is not an ON channel: `lockedEnabled` with no value
  // set for sms resolves OFF in the dispatcher, and this row used to read on.
  it('reads OFF for a locked channel the dispatcher resolves off', () => {
    const c = cat('visit', [
      key({
        allowedChannels: ['sms'],
        lockedChannels: ['sms'],
        lockedChannelValues: { sms: false },
      }),
    ]);
    expect(channelChecked(c, 'sms', { sms: true })).toBe(false);
  });
  // The category row aggregates several keys, so "on" has to be true of all of
  // them; one key resolving off makes the row's promise false for that key.
  it('reads OFF when one of the keys locking the channel resolves off', () => {
    const c = cat('visit', [
      key({
        key: 'a',
        allowedChannels: ['sms'],
        lockedChannels: ['sms'],
        lockedChannelValues: { sms: true },
      }),
      key({
        key: 'b',
        allowedChannels: ['sms'],
        lockedChannels: ['sms'],
        lockedChannelValues: { sms: false },
      }),
    ]);
    expect(channelChecked(c, 'sms', undefined)).toBe(false);
  });
});

describe('categoryMasterChecked', () => {
  it('is on only when every toggleable channel currently reads on', () => {
    const c = cat('visit', [key({ allowedChannels: ['email', 'sms'] })]);
    expect(categoryMasterChecked(c, { email: true, sms: true })).toBe(true);
    expect(categoryMasterChecked(c, { email: true, sms: false })).toBe(false);
  });

  it('reads on for a fully-locked category (nothing left to toggle)', () => {
    const c = cat('visit', [
      key({
        allowedChannels: ['email'],
        lockedChannels: ['email'],
        lockedChannelValues: { email: true },
      }),
    ]);
    expect(categoryMasterChecked(c, undefined)).toBe(true);
  });
});

describe('categoryMarketingCategories', () => {
  it('collects distinct marketingCategory values across keys', () => {
    const c = cat('marketing', [
      key({ marketingCategory: 'newsletter' }),
      key({ marketingCategory: 'survey' }),
      key({ marketingCategory: 'newsletter' }),
    ]);
    expect(categoryMarketingCategories(c)).toEqual(['newsletter', 'survey']);
  });

  it('falls back to "marketing" when keys exist but none declare a marketingCategory', () => {
    const c = cat('marketing', [key({ marketingCategory: null })]);
    expect(categoryMarketingCategories(c)).toEqual(['marketing']);
  });

  it('is empty for a category with no keys', () => {
    expect(categoryMarketingCategories(cat('empty', []))).toEqual([]);
  });
});

describe('marketingMasterChecked', () => {
  it('is on only when every referenced marketingCategory is opted in', () => {
    const c = cat('marketing', [key({ marketingCategory: 'newsletter' }), key({ marketingCategory: 'survey' })]);
    expect(marketingMasterChecked(c, { newsletter: true, survey: true })).toBe(true);
    expect(marketingMasterChecked(c, { newsletter: true, survey: false })).toBe(false);
    expect(marketingMasterChecked(c, undefined)).toBe(false);
  });

  it('is off for a category with no keys', () => {
    expect(marketingMasterChecked(cat('empty', []), { marketing: true })).toBe(false);
  });
});

// P7: per-key notification toggles. These back the expanded-card rows in
// NotificationSettings.tsx; see that file's tests for the rendering side.
describe('keyLockedChannels', () => {
  it('is the key’s own lockedChannels, unaffected by other keys in the category', () => {
    const k = key({ allowedChannels: ['email', 'sms'], lockedChannels: ['sms'] });
    expect(keyLockedChannels(k)).toEqual(['sms']);
  });

  it('is empty when the key locks nothing', () => {
    expect(keyLockedChannels(key({ lockedChannels: [] }))).toEqual([]);
  });
});

describe('keyChannelChecked', () => {
  it('reads the catalog’s value for a channel in the key’s own lockedChannels, ignoring saved prefs', () => {
    const k = key({
      allowedChannels: ['sms'],
      lockedChannels: ['sms'],
      lockedChannelValues: { sms: true },
    });
    expect(keyChannelChecked(k, 'sms', { sms: false }, { sms: false })).toBe(true);
  });
  /**
   * The deploy skew window. This app ships on its own schedule; the callable
   * ships in the operator's batched functions release. A browser running this
   * code against a callable that predates `lockedChannelValues` must render the
   * old way, not throw on `undefined[ch]` and take the settings screen down.
   */
  it('renders a locked channel as on when the server has not shipped the values yet', () => {
    const stale = { ...key({ allowedChannels: ['sms'], lockedChannels: ['sms'] }) } as Record<
      string,
      unknown
    >;
    delete stale.lockedChannelValues;
    const k = stale as unknown as NotificationKeyDto;
    expect(keyChannelChecked(k, 'sms', { sms: false }, undefined)).toBe(true);
    expect(channelChecked(cat('visit', [k]), 'sms', { sms: false })).toBe(true);
  });
  // #491: the case every client got wrong. Locked says the household does not
  // decide it; what was decided here is off, and the row has to say so.
  it('reads OFF for a locked channel the dispatcher resolves off, whatever the household saved', () => {
    const k = key({
      allowedChannels: ['sms'],
      lockedChannels: ['sms'],
      lockedChannelValues: { sms: false },
    });
    expect(keyChannelChecked(k, 'sms', { sms: true }, { sms: true })).toBe(false);
  });

  it('prefers the key’s own byKey override over the category default', () => {
    const k = key({ allowedChannels: ['sms'], lockedChannels: [] });
    expect(keyChannelChecked(k, 'sms', { sms: true }, { sms: false })).toBe(true);
    expect(keyChannelChecked(k, 'sms', { sms: false }, { sms: true })).toBe(false);
  });

  it('inherits the category default when the key has no byKey entry', () => {
    const k = key({ allowedChannels: ['sms'], lockedChannels: [] });
    expect(keyChannelChecked(k, 'sms', undefined, { sms: true })).toBe(true);
    expect(keyChannelChecked(k, 'sms', undefined, { sms: false })).toBe(false);
  });

  it('defaults email on and other channels off when neither byKey nor byCategory says anything', () => {
    const k = key({ allowedChannels: ['email', 'push'], lockedChannels: [] });
    expect(keyChannelChecked(k, 'email', undefined, undefined)).toBe(true);
    expect(keyChannelChecked(k, 'push', undefined, undefined)).toBe(false);
  });
});

describe('keyChannelOverridden', () => {
  it('is true only when the key’s own byKey map has an explicit value for that channel', () => {
    expect(keyChannelOverridden({ sms: false }, 'sms')).toBe(true);
    expect(keyChannelOverridden({ email: true }, 'sms')).toBe(false);
    expect(keyChannelOverridden(undefined, 'sms')).toBe(false);
  });
});
