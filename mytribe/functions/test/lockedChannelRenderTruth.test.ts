import { describe, expect, it } from 'vitest';
import {
  lockedChannelValueFor,
  lockedChannelsFor,
} from '../src/notifications/getNotificationCatalog';
import { overrideForStream, resolveChannels } from '../src/notifications/prefs';
import type {
  BusinessNotificationOverride,
  Channel,
  NotificationDef,
  UserNotificationPrefs,
} from '../src/notifications/types';
/**
 * RENDER MUST AGREE WITH RESOLVE (#491).
 *
 * Every settings screen in this repo answers two questions about a channel:
 * can the person sitting here change it, and is it on. `resolveChannels` is
 * what actually decides whether a message goes out. When the two disagree, the
 * screen makes a promise the dispatcher does not keep, and the household
 * cannot even act on the discrepancy — a channel rendered read-only is
 * read-only precisely because the screen believes the decision was made for
 * them.
 *
 * The catalog is where that agreement has to be established, because the
 * catalog is what four clients render from. So this file walks the
 * combinations rather than spot-checking: `lockedEnabled` x a per-channel lock
 * x an admin channel value of unset/true/false x catalog-required x
 * alwaysEnabled, each against three different households (no preference, an
 * explicit yes, an explicit no).
 *
 * The invariant, in one sentence: what a client renders for a channel must
 * equal what `resolveChannels` produces for it — and for a channel the client
 * renders read-only, that has to hold for EVERY household, since a read-only
 * control is the screen saying their preference does not enter into it.
 */
const CHANNELS: Channel[] = ['email', 'sms', 'push'];
function defWith(over: Partial<NotificationDef>): NotificationDef {
  return {
    key: 'kincare.test.key',
    label: 'Test notification',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'visit',
    allowedChannels: [...CHANNELS],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    ...over,
  } as NotificationDef;
}
/**
 * The catalog gate, exactly as `getNotificationCatalogHandler` applies it: a
 * channel the operator explicitly switched off never reaches a client at all.
 */
function surviving(def: NotificationDef, ov: BusinessNotificationOverride | null): Channel[] {
  return def.allowedChannels.filter((ch) => !(ov?.channels && ov.channels[ch] === false));
}
/**
 * What a client puts on screen, in the shape all four of them share: a locked
 * channel shows the value the catalog reports for it, and a free channel shows
 * the household's own choice (byKey, then byCategory, then email-on).
 */
function rendered(
  def: NotificationDef,
  ov: BusinessNotificationOverride | null,
  ch: Channel,
  prefs: UserNotificationPrefs,
): boolean {
  if (lockedChannelsFor(def, ov, surviving(def, ov)).includes(ch)) {
    return lockedChannelValueFor(def, ov, ch);
  }
  const byKey = prefs.byKey?.[def.key]?.[ch];
  if (typeof byKey === 'boolean') return byKey;
  const byCategory = prefs.byCategory?.[def.category]?.[ch];
  if (typeof byCategory === 'boolean') return byCategory;
  return ch === 'email';
}
const HOUSEHOLDS: { name: string; prefs: UserNotificationPrefs }[] = [
  { name: 'no preference at all', prefs: {} },
  {
    name: 'asked for every channel',
    prefs: { byKey: { 'kincare.test.key': { email: true, sms: true, push: true } } },
  },
  {
    name: 'asked for nothing',
    prefs: { byKey: { 'kincare.test.key': { email: false, sms: false, push: false } } },
  },
];
const ADMIN_CHANNEL_VALUES: { name: string; value: boolean | undefined }[] = [
  { name: 'never set', value: undefined },
  { name: 'set on', value: true },
  { name: 'set off', value: false },
];
describe('what a client renders equals what resolveChannels sends (#491)', () => {
  for (const alwaysEnabled of [false, true]) {
    for (const requiredSms of [false, true]) {
      for (const lockedEnabled of [false, true]) {
        for (const smsLocked of [false, true]) {
          for (const adminSms of ADMIN_CHANNEL_VALUES) {
            const def = defWith({
              alwaysEnabled,
              required: requiredSms ? { sms: true } : {},
            });
            const raw: BusinessNotificationOverride = { channels: {} };
            if (lockedEnabled) raw.lockedEnabled = true;
            if (smsLocked) raw.locked = { sms: true };
            if (adminSms.value !== undefined) raw.channels = { sms: adminSms.value };
            const ov = overrideForStream(raw, 'kinfolk');
            const label =
              `alwaysEnabled=${alwaysEnabled} required.sms=${requiredSms} ` +
              `lockedEnabled=${lockedEnabled} locked.sms=${smsLocked} admin.sms=${adminSms.name}`;
            it(label, () => {
              for (const household of HOUSEHOLDS) {
                const resolved = resolveChannels(def, household.prefs, raw, 'kinfolk');
                for (const ch of surviving(def, ov)) {
                  expect(
                    rendered(def, ov, ch, household.prefs),
                    `${ch} rendered vs resolved for a household that ${household.name}`,
                  ).toBe(resolved[ch]);
                }
              }
            });
          }
        }
      }
    }
  }
  it('a channel the operator switched off is never rendered at all', () => {
    const def = defWith({});
    const raw: BusinessNotificationOverride = { channels: { sms: false }, lockedEnabled: true };
    const ov = overrideForStream(raw, 'kinfolk');
    expect(surviving(def, ov)).not.toContain('sms');
    expect(resolveChannels(def, {}, raw, 'kinfolk').sms).toBe(false);
  });
  it('alwaysEnabled alone locks nothing, because resolveChannels does not check it', () => {
    // #451 settled this: the flag is advisory. A screen that renders it as a
    // lock tells a household they cannot change something they can.
    const def = defWith({ alwaysEnabled: true });
    expect(lockedChannelsFor(def, null, def.allowedChannels)).toEqual([]);
  });
});
