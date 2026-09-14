import { describe, it, expect } from 'vitest';
import {
  businessView,
  describeTarget,
  isCatalogDefault,
  parseArgs,
  planCopy,
  report,
  resolveProjectId,
  SOURCE_KEY,
  TARGET_KEY,
  type Args,
} from '../backfillOperatorFailedLoginWarningOverride';
import { NOTIFICATION_CATALOG } from '../../functions/src/notifications/catalog';
import { resolveChannels } from '../../functions/src/notifications/prefs';
import type { BusinessNotificationOverride } from '../../functions/src/notifications/types';

/**
 * The #877 override backfill's pure rules. No Firestore, no emulator; the write
 * path is in backfillOperatorFailedLoginWarningOverride.emulator.test.ts.
 */

describe('the script targets the keys #877 split', () => {
  it('the source key is kinfolk-only now and the target key is business-only', () => {
    const source = NOTIFICATION_CATALOG[SOURCE_KEY];
    const target = NOTIFICATION_CATALOG[TARGET_KEY];
    expect(source?.audiences).toEqual({ kinfolk: true });
    expect(source?.secondaryResolver).toBeUndefined();
    expect(target?.audiences).toEqual({ business: true });
    expect(target?.recipientResolver).toBe('businessAdmins');
  });
});

describe("businessView is the dispatcher's business view, locks included", () => {
  it('folds the business overlay in and ignores the kinfolk overlay', () => {
    expect(
      businessView({
        enabled: true,
        channels: { sms: true, push: false },
        locked: { email: true },
        lockReason: 'Security alerts stay on',
        streams: {
          business: { channels: { sms: false }, lockedEnabled: true },
          kinfolk: { enabled: false, locked: { push: true } },
        },
      }),
    ).toEqual({
      enabled: true,
      channels: { sms: false, push: false },
      lockedEnabled: true,
      locked: { email: true },
      lockReason: 'Security alerts stay on',
    });
  });

  it('keeps a lock that only the business overlay sets', () => {
    expect(businessView({ enabled: true, channels: {}, streams: { business: { locked: { sms: true } } } })).toEqual({
      enabled: true,
      channels: {},
      locked: { sms: true },
    });
  });

  it('fills a missing enabled with true, which delivers the same', () => {
    expect(businessView({ channels: { push: false } })).toEqual({ enabled: true, channels: { push: false } });
  });

  it('returns null for something that is not an override', () => {
    expect(businessView(null)).toBeNull();
    expect(businessView('off')).toBeNull();
  });

  it('copying the view onto the new key delivers what the old key delivered to operators', () => {
    // Why locks are copied: a locked channel ignores the staff member's own
    // opt-in, and an unlocked one does not.
    const oldDef = { ...NOTIFICATION_CATALOG[SOURCE_KEY]!, audiences: { kinfolk: true, business: true } as const };
    const newDef = NOTIFICATION_CATALOG[TARGET_KEY]!;
    const staffPrefs = { byKey: { [SOURCE_KEY]: { push: true }, [TARGET_KEY]: { push: true } } };
    // Locked, with no explicit channel value: push takes the catalog default.
    const source: BusinessNotificationOverride = { enabled: true, channels: {}, locked: { sms: true } };
    const before = resolveChannels(oldDef, staffPrefs, source, 'business');

    const copied = planCopy({ byKey: { [SOURCE_KEY]: source } }, true);
    expect(copied.action).toBe('copy');
    const value = (copied as { value: BusinessNotificationOverride }).value;
    const after = resolveChannels(newDef, staffPrefs, value, 'business');
    expect(after.sms).toBe(before.sms);

    // Channels alone, without the lock, would leave sms to the staff prefs.
    const withoutLock: BusinessNotificationOverride = { enabled: value.enabled, channels: value.channels };
    const staffOptIn = { byKey: { [TARGET_KEY]: { sms: true } } };
    expect(resolveChannels(newDef, staffOptIn, withoutLock, 'business').sms).toBe(true);
    expect(resolveChannels(newDef, staffOptIn, value, 'business').sms).toBe(false);
  });
});

describe('isCatalogDefault', () => {
  it('is true only for enabled with nothing else set', () => {
    expect(isCatalogDefault({ enabled: true, channels: {} })).toBe(true);
    expect(isCatalogDefault({ enabled: false, channels: {} })).toBe(false);
    expect(isCatalogDefault({ enabled: true, channels: { sms: true } })).toBe(false);
    expect(isCatalogDefault({ enabled: true, channels: {}, locked: { email: true } })).toBe(false);
    expect(isCatalogDefault({ enabled: true, channels: {}, lockedEnabled: true })).toBe(false);
    expect(isCatalogDefault({ enabled: true, channels: {}, lockReason: 'why' })).toBe(false);
  });
});

describe('planCopy', () => {
  it('plans nothing when the doc does not exist', () => {
    expect(planCopy(undefined, false)).toEqual({ action: 'no-doc' });
  });

  it('plans nothing when the old key was never set', () => {
    expect(planCopy({ byKey: { 'invoice.new': { enabled: false } } }, true)).toEqual({ action: 'no-source' });
  });

  it('never overwrites an override the new key already has', () => {
    const existing = { enabled: true, channels: { sms: true } };
    expect(planCopy({ byKey: { [SOURCE_KEY]: { enabled: false }, [TARGET_KEY]: existing } }, true)).toEqual({
      action: 'target-exists',
      source: { enabled: false },
      existing,
    });
  });

  it('copies nothing when the business view is the catalog default', () => {
    expect(planCopy({ byKey: { [SOURCE_KEY]: { enabled: true, channels: {} } } }, true).action).toBe('default-only');
  });

  it('copies a disabled warning', () => {
    expect(planCopy({ byKey: { [SOURCE_KEY]: { enabled: false, channels: {} } } }, true)).toEqual({
      action: 'copy',
      source: { enabled: false, channels: {} },
      value: { enabled: false, channels: {} },
    });
  });

  it('copies a lock-only override', () => {
    const source = { enabled: true, channels: {}, lockedEnabled: true };
    expect(planCopy({ byKey: { [SOURCE_KEY]: source } }, true)).toEqual({
      action: 'copy',
      source,
      value: { enabled: true, channels: {}, lockedEnabled: true },
    });
  });

  it('copies channel toggles and locks, with the business overlay winning', () => {
    const source = {
      enabled: true,
      channels: { sms: true, push: false },
      locked: { push: true },
      streams: { business: { channels: { sms: false } } },
    };
    expect(planCopy({ byKey: { [SOURCE_KEY]: source } }, true)).toEqual({
      action: 'copy',
      source,
      value: { enabled: true, channels: { sms: false, push: false }, locked: { push: true } },
    });
  });
});

describe('parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toEqual({ mode: 'dry-run', projectId: null });
  });

  it('--dry-run beats both write flags in either order', () => {
    expect(parseArgs(['--allow-prod', '--dry-run']).mode).toBe('dry-run');
    expect(parseArgs(['--dry-run', '--allow-prod']).mode).toBe('dry-run');
    expect(parseArgs(['--emulator-write', '--dry-run']).mode).toBe('dry-run');
  });

  it('refuses both write flags together, a valueless --project, and unknown flags', () => {
    expect(() => parseArgs(['--allow-prod', '--emulator-write'])).toThrow(/cannot be combined/);
    expect(() => parseArgs(['--project', '--dry-run'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--force'])).toThrow(/unknown arg/);
  });
});

describe('resolveProjectId', () => {
  const prod: Args = { mode: 'allow-prod', projectId: null };
  const noFile = (): string => {
    throw new Error('ENOENT');
  };

  it('uses --project first, without reading the credentials file', () => {
    expect(
      resolveProjectId({ mode: 'allow-prod', projectId: 'auntieos-ttpc' }, { GOOGLE_APPLICATION_CREDENTIALS: '/k.json' }, noFile),
    ).toBe('auntieos-ttpc');
  });

  it('reads project_id from the credentials file for a prod write, and ignores GCLOUD_PROJECT', () => {
    const read = (p: string): string => {
      expect(p).toBe('/k.json');
      return JSON.stringify({ type: 'service_account', project_id: 'auntieos-ttpc' });
    };
    expect(resolveProjectId(prod, { GOOGLE_APPLICATION_CREDENTIALS: '/k.json', GCLOUD_PROJECT: 'other' }, read)).toBe(
      'auntieos-ttpc',
    );
  });

  it('refuses a prod write when neither --project nor project_id gives one', () => {
    expect(() => resolveProjectId(prod, { GOOGLE_APPLICATION_CREDENTIALS: '/k.json' }, noFile)).toThrow(
      /could not read project_id from \/k\.json.*Pass --project/,
    );
    expect(() =>
      resolveProjectId(prod, { GOOGLE_APPLICATION_CREDENTIALS: '/k.json' }, () => JSON.stringify({ type: 'x' })),
    ).toThrow(/found no project_id/);
    expect(() => resolveProjectId(prod, {}, noFile)).toThrow(/needs --project/);
  });

  it('a dry run falls back to the environment', () => {
    expect(resolveProjectId({ mode: 'dry-run', projectId: null }, { GOOGLE_CLOUD_PROJECT: 'demo' }, noFile)).toBe('demo');
  });
});

describe('describeTarget', () => {
  const prod: Args = { mode: 'allow-prod', projectId: null };
  const creds = (): string => JSON.stringify({ project_id: 'auntieos-ttpc' });

  it('refuses --allow-prod while FIRESTORE_EMULATOR_HOST is set', () => {
    expect(() =>
      describeTarget(prod, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', GOOGLE_APPLICATION_CREDENTIALS: '/k.json' }, creds),
    ).toThrow(/refusing --allow-prod while FIRESTORE_EMULATOR_HOST is set/);
  });

  it('refuses --emulator-write without an emulator', () => {
    expect(() => describeTarget({ mode: 'emulator-write', projectId: null }, {})).toThrow(/FIRESTORE_EMULATOR_HOST is not set/);
  });

  it('refuses a production write without credentials', () => {
    expect(() => describeTarget(prod, {}, creds)).toThrow(/GOOGLE_APPLICATION_CREDENTIALS/);
  });

  it('prints the resolved project first, then production and the doc', () => {
    const t = describeTarget(prod, { GOOGLE_APPLICATION_CREDENTIALS: '/k.json' }, creds);
    expect(t.projectId).toBe('auntieos-ttpc');
    expect(t.lines).toEqual([
      'PROJECT: auntieos-ttpc',
      'TARGET: PRODUCTION, doc businessSettings/notifications, mode ALLOW-PROD',
    ]);
  });

  it('names the emulator for a dry run inside an emulator shell', () => {
    const t = describeTarget({ mode: 'dry-run', projectId: null }, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', GCLOUD_PROJECT: 'demo' });
    expect(t.lines).toEqual([
      'PROJECT: demo',
      'TARGET: EMULATOR 127.0.0.1:8080, doc businessSettings/notifications, mode DRY-RUN',
    ]);
  });
});

describe('report', () => {
  it('prints the doc, the old value, and the exact write, locks included', () => {
    const lines: string[] = [];
    report(
      {
        action: 'copy',
        source: { enabled: false, locked: { email: true } },
        value: { enabled: false, channels: {}, locked: { email: true } },
      },
      (l) => lines.push(l),
    );
    expect(lines).toEqual([
      'doc businessSettings/notifications',
      `  byKey['${SOURCE_KEY}']: {"enabled":false,"locked":{"email":true}}`,
      '  business view: {"enabled":false,"channels":{},"locked":{"email":true}}',
      `  byKey['${TARGET_KEY}']: absent`,
      `  WRITE byKey['${TARGET_KEY}'] = {"enabled":false,"channels":{},"locked":{"email":true}}`,
    ]);
  });
});
