import { describe, it, expect } from 'vitest';
import {
  businessView,
  describeTarget,
  parseArgs,
  planCopy,
  report,
  uncopiedFields,
  SOURCE_KEY,
  TARGET_KEY,
  type Args,
} from '../backfillOperatorFailedLoginWarningOverride';
import { NOTIFICATION_CATALOG } from '../../functions/src/notifications/catalog';
import { overrideForStream } from '../../functions/src/notifications/prefs';
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

describe('businessView reads the override the way the dispatcher does', () => {
  const fixtures: BusinessNotificationOverride[] = [
    { enabled: false, channels: {} },
    { enabled: true, channels: { sms: false, push: true } },
    { enabled: true, channels: { email: true }, streams: { business: { enabled: false } } },
    { enabled: false, channels: { sms: true }, streams: { business: { channels: { sms: false } } } },
    { enabled: true, channels: { push: false }, streams: { kinfolk: { enabled: false, channels: { push: true } } } },
  ];

  it.each(fixtures.map((f, i) => [i, f] as const))('agrees with overrideForStream(business), fixture %i', (_i, f) => {
    const theirs = overrideForStream(f, 'business')!;
    expect(businessView(f)).toEqual({ enabled: theirs.enabled, channels: theirs.channels });
  });

  it('ignores the kinfolk overlay entirely', () => {
    expect(
      businessView({ enabled: true, channels: {}, streams: { kinfolk: { enabled: false } } }),
    ).toEqual({ enabled: true, channels: {} });
  });

  it('returns null for something that is not an override', () => {
    expect(businessView(null)).toBeNull();
    expect(businessView('off')).toBeNull();
    expect(businessView({ lockReason: 'x' })).toBeNull();
  });

  it('names the lock fields it does not copy', () => {
    expect(
      uncopiedFields({
        enabled: true,
        locked: { sms: true },
        lockReason: 'Required',
        streams: { business: { lockedEnabled: true } },
      }),
    ).toEqual(['locked', 'lockReason', 'streams.business.lockedEnabled']);
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

  it('copies channel toggles, with the business overlay winning', () => {
    const source = { enabled: true, channels: { sms: true, push: false }, streams: { business: { channels: { sms: false } } } };
    expect(planCopy({ byKey: { [SOURCE_KEY]: source } }, true)).toEqual({
      action: 'copy',
      source,
      value: { enabled: true, channels: { sms: false, push: false } },
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

describe('describeTarget', () => {
  const prod: Args = { mode: 'allow-prod', projectId: 'auntieos-ttpc' };

  it('refuses --allow-prod while FIRESTORE_EMULATOR_HOST is set', () => {
    expect(() =>
      describeTarget(prod, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', GOOGLE_APPLICATION_CREDENTIALS: '/k.json' }),
    ).toThrow(/refusing --allow-prod while FIRESTORE_EMULATOR_HOST is set/);
  });

  it('refuses --emulator-write without an emulator', () => {
    expect(() => describeTarget({ mode: 'emulator-write', projectId: null }, {})).toThrow(/FIRESTORE_EMULATOR_HOST is not set/);
  });

  it('refuses a production write without credentials', () => {
    expect(() => describeTarget(prod, {})).toThrow(/GOOGLE_APPLICATION_CREDENTIALS/);
  });

  it('names production, the project and the doc for a prod write', () => {
    expect(describeTarget(prod, { GOOGLE_APPLICATION_CREDENTIALS: '/k.json' }).line).toBe(
      'TARGET: PRODUCTION, project auntieos-ttpc, doc businessSettings/notifications, mode ALLOW-PROD',
    );
  });

  it('names the emulator for a dry run inside an emulator shell', () => {
    const t = describeTarget({ mode: 'dry-run', projectId: null }, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', GCLOUD_PROJECT: 'demo' });
    expect(t.projectId).toBe('demo');
    expect(t.line).toBe('TARGET: EMULATOR 127.0.0.1:8080, project demo, doc businessSettings/notifications, mode DRY-RUN');
  });
});

describe('report', () => {
  it('prints the doc, the old value, and the exact write', () => {
    const lines: string[] = [];
    report(
      { action: 'copy', source: { enabled: false, locked: { email: true } }, value: { enabled: false, channels: {} } },
      (l) => lines.push(l),
    );
    expect(lines).toEqual([
      'doc businessSettings/notifications',
      `  byKey['${SOURCE_KEY}']: {"enabled":false,"locked":{"email":true}}`,
      '  business view: {"enabled":false,"channels":{}}',
      `  byKey['${TARGET_KEY}']: absent`,
      `  WRITE byKey['${TARGET_KEY}'] = {"enabled":false,"channels":{}}`,
      '  NOT COPIED (re-set by hand on the Business tab if still wanted): locked',
    ]);
  });
});
