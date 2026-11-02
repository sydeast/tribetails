import { describe, expect, it } from 'vitest';
import { describeCard, parseArgs, planBackfill } from '../backfillBusinessPublicCard';
import { BUSINESS_PUBLIC_CARD_DOC, BUSINESS_SETTINGS_SOURCE_DOC } from '../../functions/src/lib/businessPublicCard';

/**
 * #1321: the first mirror of `business_public/card`. The trigger that keeps the
 * card only fires on a settings write, so this is what puts the business name
 * on the sign-in screen the day the trigger deploys.
 */

/** Minimal Firestore double: only `.doc(path).get()` is exercised by planBackfill. */
function fakeFirestore(docs: Record<string, Record<string, unknown>>): any {
  return {
    doc: (path: string) => ({
      get: () => Promise.resolve({ exists: path in docs, data: () => docs[path] }),
    }),
  };
}

const CLOSED_WEEK = { Monday: '', Tuesday: '', Wednesday: '', Thursday: '', Friday: '', Saturday: '', Sunday: '' };

const SETTINGS = {
  businessName: 'Sunny Paws',
  businessPhone: '555-0142',
  businessHours: { Monday: '9:00-17:00' },
  venmoHandle: '@sunny-paws',
  serviceRates: { walk: 25 },
};

const EXPECTED_CARD = {
  name: 'Sunny Paws',
  phone: '555-0142',
  hours: { ...CLOSED_WEEK, Monday: '09:00-17:00' },
  privacyPolicyUrl: '',
};

describe('parseArgs', () => {
  it('is a dry run by default', () => {
    expect(parseArgs([])).toEqual({ mode: 'dry-run', allowProd: false, projectId: null });
  });

  it('--allow-prod applies', () => {
    expect(parseArgs(['--allow-prod']).mode).toBe('apply');
  });

  it('an explicit --dry-run beats --allow-prod in either order', () => {
    expect(parseArgs(['--allow-prod', '--dry-run']).mode).toBe('dry-run');
    expect(parseArgs(['--dry-run', '--allow-prod']).mode).toBe('dry-run');
  });

  it('takes a project and refuses a flag as its value', () => {
    expect(parseArgs(['--project', 'p1']).projectId).toBe('p1');
    expect(() => parseArgs(['--project', '--dry-run'])).toThrow('--project requires a value');
    expect(() => parseArgs(['--project'])).toThrow('--project requires a value');
  });
});

describe('planBackfill', () => {
  it('plans the first mirror when no card exists', async () => {
    const plan = await planBackfill(fakeFirestore({ [BUSINESS_SETTINGS_SOURCE_DOC]: SETTINGS }));
    expect(plan).toEqual({ settingsExists: true, before: null, after: EXPECTED_CARD, changes: true });
  });

  it('carries only the public fields, so the card never learns a payment handle or a rate', async () => {
    const plan = await planBackfill(fakeFirestore({ [BUSINESS_SETTINGS_SOURCE_DOC]: SETTINGS }));
    expect(Object.keys(plan.after).sort()).toEqual(['hours', 'name', 'phone', 'privacyPolicyUrl']);
    expect(JSON.stringify(plan.after)).not.toContain('@sunny-paws');
  });

  it('plans nothing when the card already matches, so a second run is a no-op', async () => {
    const plan = await planBackfill(
      fakeFirestore({ [BUSINESS_SETTINGS_SOURCE_DOC]: SETTINGS, [BUSINESS_PUBLIC_CARD_DOC]: EXPECTED_CARD }),
    );
    expect(plan).toMatchObject({ changes: false, before: EXPECTED_CARD });
  });

  it('plans a rewrite when the card has drifted from settings', async () => {
    const plan = await planBackfill(
      fakeFirestore({
        [BUSINESS_SETTINGS_SOURCE_DOC]: SETTINGS,
        [BUSINESS_PUBLIC_CARD_DOC]: { ...EXPECTED_CARD, name: 'Old Name' },
      }),
    );
    expect(plan).toMatchObject({ changes: true, after: EXPECTED_CARD });
  });

  it('refuses to mirror a settings document that does not exist, rather than writing blanks', async () => {
    const plan = await planBackfill(fakeFirestore({}));
    expect(plan).toMatchObject({ settingsExists: false, changes: false });
  });
});

describe('describeCard', () => {
  it('names what is set without printing the phone number', () => {
    const line = describeCard(EXPECTED_CARD);
    expect(line).toContain('name="Sunny Paws"');
    expect(line).toContain('phone=set');
    expect(line).toContain('hours=1 open day');
    expect(line).toContain('privacyPolicyUrl=(unset)');
    expect(line).not.toContain('555-0142');
  });

  it('reads a missing card and an unset name plainly', () => {
    expect(describeCard(null)).toBe('(no card)');
    expect(describeCard({ name: '', phone: '', hours: CLOSED_WEEK, privacyPolicyUrl: '' })).toContain('name=(unset)');
    expect(describeCard({ name: '', phone: '', hours: CLOSED_WEEK, privacyPolicyUrl: '' })).toContain('hours=0 open days');
  });
});
