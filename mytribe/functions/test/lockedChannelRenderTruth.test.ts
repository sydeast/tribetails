import { describe, expect, it } from 'vitest';
import {
  lockedChannelValueFor,
  lockedChannelsFor,
} from '../src/notifications/getNotificationCatalog';
import { getNotificationDef } from '../src/notifications/catalog';
import {
  overrideForStream,
  resolveChannels,
  withAliasedChoicesResolved,
} from '../src/notifications/prefs';
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

/**
 * THE SAME INVARIANT, FOR A CHOICE STORED UNDER A RETIRED KEY (#501).
 *
 * Everything above uses a synthetic def with no alias, so it never exercises
 * the other half of `explicitUserChoice`: the walk from the canonical key to
 * whatever retired key was merged into it. `kincare.report.sent` was merged
 * into `kintale.published` on 2026-07-24, and it crossed categories on the way
 * ('visit' to 'kintale'), so both alias steps are live on this one pair.
 *
 * The direction of the failure is the opposite of #491's and worse. A
 * household that turned email off before the merge has that stored under the
 * retired name; `resolveChannels` honors it and sends nothing; a screen reads
 * the canonical key, finds nothing, falls back to email-on and draws the
 * switch ON. Somebody is waiting for a KinTale notification that is never
 * coming, and the screen agrees with them.
 *
 * So the assertion is the same as above with one substitution: render reads
 * the prefs the callables now return (`withAliasedChoicesResolved`), resolve
 * reads what is actually in Firestore. Render must still equal resolve.
 */
const ALIASED = getNotificationDef('kintale.published');
const RETIRED_KEY = 'kincare.report.sent';
const RETIRED_CATEGORY = 'visit';
const ALIAS_HOUSEHOLDS: { name: string; prefs: UserNotificationPrefs }[] = [
  {
    name: 'turned email off under the retired key, before the merge',
    prefs: { byKey: { [RETIRED_KEY]: { email: false } } },
  },
  {
    name: 'turned every channel off under the retired key',
    prefs: { byKey: { [RETIRED_KEY]: { email: false, sms: false, push: false } } },
  },
  {
    name: 'turned sms on under the retired key',
    prefs: { byKey: { [RETIRED_KEY]: { sms: true } } },
  },
  {
    name: 'turned email off for the retired CATEGORY',
    prefs: { byCategory: { [RETIRED_CATEGORY]: { email: false } } },
  },
  {
    name: 'set the retired category off and the canonical category on',
    prefs: {
      byCategory: { [RETIRED_CATEGORY]: { email: false }, [ALIASED.category]: { email: true } },
    },
  },
  {
    name: 'changed their mind since the merge, canonical says yes',
    prefs: {
      byKey: { [RETIRED_KEY]: { email: false }, [ALIASED.key]: { email: true } },
    },
  },
  {
    name: 'set only sms canonically, leaving email under the retired key',
    prefs: {
      byKey: { [RETIRED_KEY]: { email: false, sms: true }, [ALIASED.key]: { sms: false } },
    },
  },
];
describe('a choice under a retired key renders the way it is sent (#501)', () => {
  for (const household of ALIAS_HOUSEHOLDS) {
    it(household.name, () => {
      const ov = overrideForStream(null, 'kinfolk');
      const resolved = resolveChannels(ALIASED, household.prefs, null, 'kinfolk');
      const forDisplay = withAliasedChoicesResolved(household.prefs);
      for (const ch of surviving(ALIASED, ov)) {
        expect(
          rendered(ALIASED, ov, ch, forDisplay),
          `${ch} rendered vs resolved for a household that ${household.name}`,
        ).toBe(resolved[ch]);
      }
    });
  }
  it('is a real divergence, not a test that would pass either way', () => {
    // Guards the test above: if the raw prefs already rendered correctly, the
    // normalizer would be untested scaffolding and this file would go green
    // whether or not #501 was ever fixed.
    const prefs: UserNotificationPrefs = { byKey: { [RETIRED_KEY]: { email: false } } };
    expect(resolveChannels(ALIASED, prefs, null, 'kinfolk').email).toBe(false);
    expect(rendered(ALIASED, null, 'email', prefs)).toBe(true);
    expect(rendered(ALIASED, null, 'email', withAliasedChoicesResolved(prefs))).toBe(false);
  });
  it('leaves the retired entry in place rather than folding it away', () => {
    // The clients send the whole prefs object back on save. Dropping the
    // retired entry here would delete, on the next save, a choice
    // explicitUserChoice still honors.
    const prefs: UserNotificationPrefs = { byKey: { [RETIRED_KEY]: { email: false } } };
    const out = withAliasedChoicesResolved(prefs);
    expect(out.byKey?.[RETIRED_KEY]).toEqual({ email: false });
    expect(out.byKey?.[ALIASED.key]).toEqual({ email: false });
  });
  it('never overrides a canonical choice with a retired one', () => {
    const prefs: UserNotificationPrefs = {
      byKey: { [RETIRED_KEY]: { email: false }, [ALIASED.key]: { email: true } },
    };
    expect(withAliasedChoicesResolved(prefs).byKey?.[ALIASED.key]?.email).toBe(true);
  });
  it('returns the prefs untouched when nothing is stored under an alias', () => {
    const prefs: UserNotificationPrefs = { byKey: { [ALIASED.key]: { email: false } } };
    expect(withAliasedChoicesResolved(prefs)).toBe(prefs);
    expect(withAliasedChoicesResolved({})).toEqual({});
  });
});
